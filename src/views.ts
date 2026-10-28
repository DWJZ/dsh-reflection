/**
 * The generated `MEMORY.md` index and the per-record files beside it.
 *
 * `memories.json` is the source of truth; both of these are derived, readable,
 * and disposable. Three rules follow from that and are all implemented here:
 * the index lists only active Memory, so a reader never mistakes a superseded
 * decision for a current one; every active record also gets its own file under
 * `memories/`, which is where an agent goes for the full text; and a failed
 * rebuild never fails the mutation that triggered it — otherwise a caller
 * retrying on failure would ADD a second copy.
 *
 * The rebuild reads the latest canonical state under the store lock rather than
 * reusing the state that triggered it, so a slow writer cannot overwrite a newer
 * view with an older one.
 *
 * @module dsh-reflection/views
 */

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readStore, writeAtomic, withStore } from './jsonstore.js'
import type { StoreLockOptions, StoreMutation } from './jsonstore.js'
import { withLock } from './lock.js'
import { CATEGORY_PRIORITY, activeRecords } from './retention.js'
import type { MemoryRecord, MemoryStore } from './types/memory.js'
import { failureMessage } from './errors.js'

/** Marker identifying the revision a view was rendered from. */
const REVISION_MARKER = 'dsh-reflection: revision'

/** Longest headline quoted into the index, in characters. */
const HEADLINE_CHARS = 100

/**
 * Render one scope's active Memory as a Markdown index.
 *
 * One line per record: its id (what `memory_get` takes), the day it last moved,
 * and a headline. The body lives in `memories/<id>.md`; the index exists to be
 * scanned cheaply and to hand out ids, not to carry the facts themselves.
 * @param records - every record in the scope, including inactive ones.
 * @param {object} options - render inputs.
 * @param options.revision - canonical revision the render reflects.
 * @returns the complete file content.
 */
export function renderMemoryView(records: MemoryRecord[], options: { revision?: number | undefined } = {}) {
  const revision = options.revision ?? 0
  const active = activeRecords(records)
  const lines = [
    '# Memory index',
    '',
    '<!-- This file is generated from memories.json and will be overwritten. -->',
    `<!-- ${REVISION_MARKER} ${String(revision)} -->`,
    `<!-- ${String(active.length)} active record${active.length === 1 ? '' : 's'}; read memories/<id>.md for the full record. -->`,
    '',
  ]
  if (active.length === 0) {
    lines.push('No active Memory.')
    lines.push('')
    return lines.join('\n')
  }
  for (const category of CATEGORY_PRIORITY) {
    const group = active.filter((record: MemoryRecord) => record.category === category)
    if (group.length === 0) continue
    lines.push(`## ${category}`, '')
    for (const record of group) {
      lines.push(`- ${record.id} · ${record.updated_at.slice(0, 10)} · ${headlineOf(record.content)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render one record as a standalone Markdown file.
 * @param record - the record to render.
 * @returns the complete file content.
 */
export function renderRecordFile(record: MemoryRecord) {
  const lines = [
    `# ${record.id} — ${record.category}`,
    '',
    '<!-- Generated from memories.json; overwritten on rebuild. -->',
    '',
    `- scope: ${record.scope}`,
    `- status: ${record.status}`,
    `- confidence: ${String(record.confidence)}`,
    `- created: ${record.created_at}`,
    `- updated: ${record.updated_at}`,
  ]
  if (typeof record.project_id === 'string' && record.project_id !== '') {
    lines.push(`- project: ${record.project_id}`)
  }
  if (typeof record.superseded_by === 'string' && record.superseded_by !== '') {
    lines.push(`- superseded by: ${record.superseded_by}`)
  }
  lines.push('', '## Content', '', record.content, '')
  if (record.evidence.length === 0) return lines.join('\n')
  lines.push('## Evidence', '')
  for (const entry of record.evidence) {
    const seqs = entry.event_seqs.length === 0 ? 'no seq' : `seq ${entry.event_seqs.join(',')}`
    lines.push(`- ${entry.observed_at} · ${entry.kind} · ${seqs} · session ${entry.session_id}`)
    if (entry.quote !== '') lines.push(`  > ${singleLine(entry.quote)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Regenerate one scope's index and per-record files from the latest canonical state.
 *
 * Files for records that are no longer active are removed, so `memories/` always
 * mirrors the index; a record that disappears from both is still readable through
 * `memory_get`, which reads the canonical store.
 * @param {object} options - layout, lock thresholds, and optional logger.
 * @param options.storePath - absolute path of `memories.json`.
 * @param options.lockPath - absolute path of the store lock file.
 * @param options.viewPath - absolute path of `MEMORY.md`.
 * @param options.recordsDir - directory that holds one file per active record.
 * @param options.lockTimeoutMs - how long to wait for the lock.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @returns the revision the view now reflects.
 * @throws when the lock cannot be taken or the view cannot be written.
 */
export async function rebuildView(options: StoreLockOptions & { viewPath: string; recordsDir: string }) {
  return withLock(options, () => {
    const store = readStore(options.storePath)
    writeAtomic(options.viewPath, renderMemoryView(store.records, { revision: store.revision }))
    writeRecordFiles(options.recordsDir, activeRecords(store.records))
    return { revision: store.revision }
  })
}

/**
 * Write one file per active record and remove the files of records that left.
 * @param recordsDir - directory that holds one file per active record.
 * @param active - the active records, already ordered.
 * @returns nothing.
 */
function writeRecordFiles(recordsDir: string, active: MemoryRecord[]): void {
  mkdirSync(recordsDir, { recursive: true })
  const wanted = new Set<string>()
  for (const record of active) {
    const name = `${record.id}.md`
    wanted.add(name)
    writeAtomic(join(recordsDir, name), renderRecordFile(record))
  }
  for (const name of readdirSync(recordsDir)) {
    if (!name.endsWith('.md') || wanted.has(name)) continue
    rmSync(join(recordsDir, name), { force: true })
  }
}

/**
 * One record's first line, short enough to scan in the index.
 * @param content - the remembered text.
 * @returns a single line, truncated when it is long.
 */
function headlineOf(content: string): string {
  const line = singleLine(content)
  const characters = [...line]
  return characters.length <= HEADLINE_CHARS
    ? line
    : `${characters.slice(0, HEADLINE_CHARS).join('')}…`
}

/**
 * Collapse one text to a single line.
 * @param text - the text to flatten.
 * @returns the text with every whitespace run replaced by one space.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Commit one mutation, then refresh the view without letting the view decide the
 * mutation's outcome.
 * @param options - layout, lock thresholds, and optional logger.
 * @param operation - receives the latest store, returns `{ result, changed, records }`.
 * @returns the mutation result, the committed revision, and whether the view is stale.
 */
export async function mutateAndRefreshView<T = Record<string, unknown>>(
  options: StoreLockOptions & { viewPath: string; recordsDir: string },
  operation: (store: MemoryStore) => StoreMutation<T> | undefined,
) {
  const outcome = await withStore(options, operation)
  let viewStale = false
  try {
    await rebuildView(options)
  } catch (error) {
    viewStale = true
    options.logger?.warn(`dsh-reflection: memory-view-stale: ${options.viewPath}: ${failureMessage(error)}`)
  }
  return { result: outcome.result, revision: outcome.revision, viewStale }
}
