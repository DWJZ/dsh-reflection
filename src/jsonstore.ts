/**
 * Canonical store persistence: an index plus one body file per record.
 *
 * `memories.json` holds metadata — id, category, title, status, timestamps.
 * The text and its evidence live beside it in `memories/<id>.md`. The index
 * write is the commit point: a body is written first, and a body the index does
 * not name is an orphan the next write removes.
 *
 * A body is the only copy of its text, so a missing body is a failure rather
 * than a record to skip: silently serving the index would claim Memory exists
 * while the text it points at does not.
 *
 * @module dsh-reflection/jsonstore
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { withLock } from './lock.js'
import { deriveTitle, isMemoryId, validateStoreRecords } from './schema.js'
import { failureMessage } from './errors.js'
import type { SweepOptions } from './types/seams.js'
import type { EvidenceEntry, MemoryRecord, MemoryScope, MemorySource, MemoryStore } from './types/memory.js'

/** Format version this build writes; an unknown version is refused, never guessed. */
export const STORE_SCHEMA_VERSION = 2

/** Suffix every temporary file this plugin creates carries. */
export const TEMP_MARKER = '.dsh-reflection-tmp-'

/** One row of the index: every field of a record except its text and evidence. */
interface IndexRow {
  id: string
  scope: MemoryScope
  project_id?: string | null
  source: MemorySource
  title: string
  status: string
  confidence: number
  created_at: string
  updated_at: string
  superseded_by?: string | null
  /** Version 1 kept these in the index; version 2 reads them from the body. */
  content?: string
  evidence?: EvidenceEntry[]
}

/** One store document, before bodies are read. */
interface StoreDocument {
  schema_version: number
  revision: number
  records: IndexRow[]
}

/**
 * Build an empty store.
 * @returns a store with no records and revision 0.
 */
export function emptyStore() {
  return { schema_version: STORE_SCHEMA_VERSION, revision: 0, records: [] }
}

/**
 * Read one canonical store and validate every record it holds.
 *
 * Bodies are read here, so callers keep seeing complete records while the disk
 * layout stays split.
 * @param storePath - absolute path of `memories.json`.
 * @returns the stored document, or an empty store when the file is absent.
 * @throws when the file is malformed, a body is missing, or a record is invalid.
 */
export function readStore(storePath: string) {
  const document = parseStoreDocument(storePath)
  const records = readRecords(storePath, document)
  validateStoreRecords(records)
  return { schema_version: document.schema_version, revision: document.revision, records }
}

/**
 * Read one store document, checking only its own shape.
 * @param storePath - absolute path of `memories.json`.
 * @returns the parsed document, or an empty one when the file is absent.
 * @throws when the file is unreadable, malformed, or written by an unknown format.
 */
function parseStoreDocument(storePath: string): StoreDocument {
  if (!existsSync(storePath)) return emptyStore()
  const text = readFileSync(storePath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-reflection: ${storePath} is not valid JSON: ${failureMessage(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-reflection: ${storePath} must hold a JSON object`)
  }
  if (parsed.schema_version !== 1 && parsed.schema_version !== STORE_SCHEMA_VERSION) {
    throw new Error(`dsh-reflection: ${storePath} has schema_version ${JSON.stringify(parsed.schema_version)}, this build reads 1 and ${String(STORE_SCHEMA_VERSION)}`)
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error(`dsh-reflection: ${storePath} has an invalid revision ${JSON.stringify(parsed.revision)}`)
  }
  if (!Array.isArray(parsed.records)) {
    throw new Error(`dsh-reflection: ${storePath} must hold a records array`)
  }
  return parsed
}

/**
 * Assemble the logical records a document describes.
 *
 * A version-1 document carries text in the index; a version-2 document points at
 * body files. Both return the same record shape.
 * @param storePath - the index file, used to locate bodies.
 * @param document - the parsed index document.
 * @returns complete records.
 * @throws when a body is missing or malformed, or an index row has no valid id.
 */
function readRecords(storePath: string, document: StoreDocument): MemoryRecord[] {
  const legacy = document.schema_version === 1
  const recordsDir = join(dirname(storePath), 'memories')
  return document.records.map((row: IndexRow): MemoryRecord => {
    if (typeof row !== 'object' || row === null || !isMemoryId(row.id)) {
      throw new TypeError(`dsh-reflection: ${storePath} holds an index row without a valid Memory id`)
    }
    const title = typeof row.title === 'string' && row.title !== ''
      ? row.title
      : deriveTitle(typeof row.content === 'string' ? row.content : '')
    if (legacy) {
      return {
        id: row.id,
        scope: row.scope,
        source: row.source ?? 'agent',
        title,
        status: row.status,
        content: typeof row.content === 'string' ? row.content : '',
        confidence: row.confidence,
        project_id: row.project_id ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
        superseded_by: row.superseded_by ?? null,
      }
    }
    const bodyPath = join(recordsDir, `${row.id}.md`)
    if (!existsSync(bodyPath)) {
      throw new Error(`dsh-reflection: memory ${row.id} has no body at ${bodyPath}`)
    }
    const { content, evidence } = parseRecordBody(readFileSync(bodyPath, 'utf8'))
    return {
      id: row.id,
      scope: row.scope,
      source: row.source ?? 'agent',
      title,
      status: row.status,
      content,
      confidence: row.confidence,
      project_id: row.project_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      evidence,
      superseded_by: row.superseded_by ?? null,
    }
  })
}

/**
 * Write text to a file atomically, removing the temporary file on any failure.
 * @param targetPath - the file to replace.
 * @param text - the complete new content.
 * @throws when the content cannot be committed.
 */
export function writeAtomic(targetPath: string, text: string) {
  const dir = dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `${randomUUID()}${TEMP_MARKER}${basename(targetPath)}`)
  let fd
  let committed = false
  try {
    fd = openSync(tmpPath, 'wx', 0o600)
    writeSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, targetPath)
    committed = true
    fsyncDirectory(dir)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The descriptor is already unusable; the temporary file is removed below.
      }
    }
    if (!committed) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Best effort: a leftover temporary file is cleaned on the next mount.
      }
    }
  }
}

/**
 * Render one record's body file.
 *
 * The text is the file's first paragraph; evidence follows under its own
 * heading so a person reading the file sees what the record is grounded in.
 * @param record - the record to render.
 * @returns the complete file content.
 */
export function renderRecordBody(record: MemoryRecord) {
  const lines = [record.content, '']
  if (record.evidence.length > 0) {
    lines.push('## Evidence', '')
    for (const entry of record.evidence) {
      const seqs = entry.event_seqs.length === 0 ? 'no seq' : `seq ${entry.event_seqs.join(',')}`
      lines.push(`- ${entry.observed_at} · ${entry.kind} · ${seqs} · session ${entry.session_id}`)
      if (entry.quote !== '') lines.push(`  > ${singleLine(entry.quote)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Parse one record body back into text and evidence.
 * @param text - the body file content.
 * @returns the record text and its evidence.
 * @throws when an evidence line does not have the rendered shape.
 */
export function parseRecordBody(text: string) {
  const marker = '\n## Evidence\n'
  const at = text.indexOf(marker)
  const content = (at < 0 ? text : text.slice(0, at)).trim()
  const evidence: EvidenceEntry[] = []
  if (at >= 0) {
    let current: EvidenceEntry | undefined
    for (const line of text.slice(at + marker.length).split('\n')) {
      if (line.startsWith('- ')) {
        const match = /^- (.+?) · (.+?) · (?:seq ([\d,]+)|no seq) · session (.+)$/u.exec(line)
        if (match === null) {
          throw new Error(`dsh-reflection: malformed evidence line in a record body: ${JSON.stringify(line)}`)
        }
        const [, observedAt, kind, seqs, sessionId] = match
        if (observedAt === undefined || kind === undefined || sessionId === undefined) {
          throw new Error(`dsh-reflection: malformed evidence line in a record body: ${JSON.stringify(line)}`)
        }
        current = {
          observed_at: observedAt,
          kind,
          event_seqs: seqs === undefined ? [] : seqs.split(',').map(Number),
          session_id: sessionId,
          quote: '',
        }
        evidence.push(current)
      } else if (line.startsWith('  > ') && current !== undefined) {
        current.quote = line.slice(4)
      }
    }
  }
  return { content, evidence }
}

/**
 * Remove this plugin's abandoned temporary files below one directory.
 *
 * Temporary files live beside the store they belong to, so scopes nested under
 * the Memory root are swept too. A file is removed only when it carries this
 * plugin's own marker AND is older than the threshold: a marker alone cannot
 * mean "abandoned", because another process may be writing that very file right
 * now, and deleting it would make that writer's rename fail.
 * @param dir - the Memory root to sweep.
 * @param {object} options - sweep inputs.
 * @param options.staleTempMs - age at which a temporary file is abandoned.
 * @param options.now - clock, injectable for tests.
 * @returns the number of files removed.
 */
export function cleanupStaleTemps(dir: string, options: SweepOptions = {}) {
  if (!existsSync(dir)) return 0
  const now = options.now ?? Date.now
  const staleTempMs = options.staleTempMs ?? Number.POSITIVE_INFINITY
  let removed = 0
  for (const path of findTemps(dir)) {
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      if (now() - stats.mtimeMs <= staleTempMs) continue
      unlinkSync(path)
      removed += 1
    } catch {
      // A concurrent writer may own this file; it cleans up after itself.
    }
  }
  return removed
}

/**
 * Every temporary file this plugin left below one directory.
 * @param dir - the directory to walk.
 * @returns absolute paths, deepest last.
 */
function findTemps(dir: string) {
  const found: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findTemps(path))
      continue
    }
    if (entry.name.includes(TEMP_MARKER)) found.push(path)
  }
  return found
}

/** Where one store lives, and the lock that guards it. */
export interface StoreLockOptions {
  /** The index file. */
  storePath: string
  /** Its lock file. */
  lockPath: string
  /** Its body directory; defaults to `memories/` beside the index. */
  recordsDir?: string | undefined
  /** How long to wait for the lock before reporting the file. */
  lockTimeoutMs: number
  /** Age at which an existing lock is treated as abandoned. */
  staleLockMs: number
  /** Clock in epoch milliseconds. */
  now?(): number
  /** The host name written into the lock record. */
  host?: string
  /** Whether a recorded process is still alive. */
  kill?(pid: number, signal?: number | string): boolean
  /** Diagnostic sink. */
  logger?: { warn(message: string | Error): void; info?(message: string): void } | undefined
}

/**
 * What one store mutation produces.
 *
 * A mutation that reports a change must supply the records to write; one that does
 * not is skipped and carries none, which is what lets the writer read them without
 * a second check.
 */
export type StoreMutation<T = Record<string, unknown>> =
  | { changed: true; records: MemoryRecord[]; result?: T }
  | { changed?: false | undefined; records?: undefined; result?: T }

/**
 * Apply one mutation to the canonical store under the store lock.
 *
 * The operation receives the latest stored revision, so a target it judges
 * against cannot be replaced between the check and the write.
 * @param {object} options - store location and lock thresholds.
 * @param operation - receives the latest store, returns `{ result, changed }`.
 * @returns the operation's result and the store now on disk.
 */
export async function withStore<T = Record<string, unknown>>(
  options: StoreLockOptions,
  operation: (store: MemoryStore) => StoreMutation<T> | undefined,
) {
  return withLock(options, () => {
    const document = parseStoreDocument(options.storePath)
    const store: MemoryStore = {
      schema_version: document.schema_version,
      revision: document.revision,
      records: readRecords(options.storePath, document),
    }
    // Validate what is already on disk before the mutation runs. An operation
    // that changes nothing must still refuse a store that violates its own
    // schema.
    validateStoreRecords(store.records)
    const outcome = operation(store)
    // Checked without optional chaining so the compiler keeps the answer narrowed
    // to the one that reported a change.
    if (outcome === undefined || outcome.changed !== true) {
      return { result: outcome?.result, revision: store.revision, store }
    }
    const next: MemoryStore = {
      schema_version: STORE_SCHEMA_VERSION,
      revision: store.revision + 1,
      records: outcome.records,
    }
    // The evidence cap is deliberately not applied here — it bounds what a writer
    // may append, not what a valid record is, so a store written under a larger
    // cap must still load after a deployment lowers it.
    validateStoreRecords(next.records)
    const recordsDir = recordsDirOf(options)
    // Version 1 keeps text in the index, so its first write also migrates the
    // bodies it has never had.
    writeBodies(recordsDir, document.schema_version === 1 ? next.records : changedRecords(store.records, next.records))
    writeAtomic(options.storePath, renderIndexDocument(next.records, next.revision))
    cleanOrphanBodies(recordsDir, next.records)
    return { result: outcome.result, revision: next.revision, store: next }
  })
}

/**
 * Migrate one scope's index and views to the split layout.
 *
 * Version 1 keeps text in the index and generates `MEMORY.md`; both are removed
 * here. Bodies are written before the index changes, so an interrupted run
 * leaves a still-valid version-1 store and can be retried.
 * @param options - store location and lock thresholds.
 * @returns whether the store was migrated.
 */
export async function migrateStore(options: StoreLockOptions): Promise<{ migrated: boolean; records: number }> {
  return withLock(options, () => {
    const document = parseStoreDocument(options.storePath)
    const legacyView = join(dirname(options.storePath), 'MEMORY.md')
    if (document.schema_version === STORE_SCHEMA_VERSION) {
      // A previous build's generated view carries no facts; removing it keeps the
      // scope to one index and one body per record.
      if (existsSync(legacyView)) unlinkSync(legacyView)
      return { migrated: false, records: document.records.length }
    }
    const records = readRecords(options.storePath, document)
    validateStoreRecords(records)
    const recordsDir = recordsDirOf(options)
    writeBodies(recordsDir, records)
    writeAtomic(options.storePath, renderIndexDocument(records, document.revision))
    if (existsSync(legacyView)) unlinkSync(legacyView)
    cleanOrphanBodies(recordsDir, records)
    return { migrated: true, records: records.length }
  })
}

/**
 * Remove one store's directory, used by tests and by an explicit scope reset.
 * @param dir - the directory to remove.
 * @returns fulfillment once the directory is gone.
 */
export async function removeStoreDir(dir: string) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * The body directory for one store.
 * @param options - store options, optionally carrying the directory.
 * @returns the absolute body directory.
 */
function recordsDirOf(options: StoreLockOptions) {
  return options.recordsDir ?? join(dirname(options.storePath), 'memories')
}

/**
 * Render one index document.
 * @param records - complete records to index.
 * @param revision - revision the document describes.
 * @returns the file content.
 */
function renderIndexDocument(records: readonly MemoryRecord[], revision: number) {
  const document = {
    schema_version: STORE_SCHEMA_VERSION,
    revision,
    records: records.map(indexRowOf),
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * The index row for one record: everything except text and evidence.
 * @param record - the complete record.
 * @returns the index row.
 */
function indexRowOf(record: MemoryRecord) {
  return {
    id: record.id,
    scope: record.scope,
    source: record.source,
    title: record.title,
    status: record.status,
    confidence: record.confidence,
    project_id: record.project_id ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    superseded_by: record.superseded_by ?? null,
  }
}

/**
 * Write one body file per record.
 * @param recordsDir - the body directory.
 * @param records - every record whose body must be written.
 * @returns nothing.
 */
function writeBodies(recordsDir: string, records: readonly MemoryRecord[]): void {
  for (const record of records) {
    writeAtomic(join(recordsDir, `${record.id}.md`), renderRecordBody(record))
  }
}

/**
 * Records whose body differs from what the store already held.
 * @param previous - records as the store held them.
 * @param next - records the mutation produced.
 * @returns records that need their body rewritten.
 */
function changedRecords(previous: readonly MemoryRecord[], next: readonly MemoryRecord[]): MemoryRecord[] {
  const before = new Map(previous.map((record: MemoryRecord) => [record.id, record]))
  return next.filter((record: MemoryRecord) => {
    const previousRecord = before.get(record.id)
    return previousRecord === undefined
      || previousRecord.content !== record.content
      || JSON.stringify(previousRecord.evidence) !== JSON.stringify(record.evidence)
  })
}

/**
 * Remove body files the index does not name.
 * @param recordsDir - the body directory.
 * @param records - the records the index now holds.
 * @returns nothing.
 */
function cleanOrphanBodies(recordsDir: string, records: readonly MemoryRecord[]): void {
  if (!existsSync(recordsDir)) return
  const keep = new Set(records.map((record: MemoryRecord) => `${record.id}.md`))
  try {
    for (const name of readdirSync(recordsDir)) {
      if (!name.endsWith('.md') || keep.has(name)) continue
      const id = name.slice(0, -3)
      if (!isMemoryId(id)) continue
      unlinkSync(join(recordsDir, name))
    }
  } catch {
    // Cleaning is best effort; the next write tries again.
  }
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
 * Flush one directory entry so the rename survives a crash.
 * @param dir - the directory that received the rename.
 */
function fsyncDirectory(dir: string) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync is unavailable on some platforms; the rename still stands.
  }
}
