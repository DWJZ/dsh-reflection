/**
 * What one digest run asks the model, and how its answers are checked.
 *
 * Two phases: the model first sees the project summaries and the record index and
 * may ask for a few bodies; the second call carries those bodies and asks for the
 * candidates. Nothing is written to Memory here — the result is a pending file a
 * person reviews.
 *
 * @module dsh-reflection/digest/prompt
 */

import { MAX_CONTENT_CHARS, charLength, normalizeContent } from '../schema.js'
import { findSecretIn } from '../redact.js'
import { MEMORY_TITLE_RULE } from '../title.js'
import type { DigestScope } from './collect.js'
import type { MemoryRecord } from '../types/memory.js'

/** One record the model asked to read. */
export interface ExpandedRecord {
  projectId: string
  record: MemoryRecord
}

/** One proposed cross-project experience. */
export interface DigestCandidate {
  title: string
  content: string
  derived_from: { project_id: string; record_id: string }[]
}

/** The system instruction shared by both calls. */
export const DIGEST_SYSTEM = [
  'You distill reusable experience across coding workspaces.',
  'You get the model-written summaries of projects whose Memory changed since the last digest,',
  'plus an index of their active records. Find problems that recur across projects and how they',
  'were solved; merge duplicates into one general, actionable experience. Remove project names,',
  'absolute paths and one-off details. Never include secrets.',
  '',
  'Every candidate needs a one-line title:',
  MEMORY_TITLE_RULE,
  '',
  'Phase one: return only {"expand":["mem_..."]} with record ids from the index you want to read.',
  'Phase two: return only {"candidates":[{"title":"...","content":"...","derived_from":[{"project_id":"...","record_id":"mem_..."}]}]}.',
  'Return {"candidates":[]} when these updates teach nothing reusable.',
].join('\n')

/**
 * Render the summaries and the record index for phase one.
 * @param scopes - the projects in the window.
 * @param since - exclusive lower bound, or undefined for every summary.
 * @param now - scan time, ISO-8601.
 * @returns the user-role payload.
 */
export function expansionPrompt(scopes: readonly DigestScope[], since: string | undefined, now: string): string {
  const parts = [
    `Digest window: ${since ?? 'all available'} .. ${now}`,
    '',
    'Project summaries that moved in this window:',
  ]
  for (const scope of scopes) {
    parts.push('', `## project ${scope.projectId}`, scope.summary.content.trim())
  }
  parts.push('', 'Active record index (ask for ids from here):')
  for (const scope of scopes) {
    parts.push('', `### project ${scope.projectId}`)
    if (scope.records.length === 0) parts.push('(none)')
    for (const record of scope.records) parts.push(`- ${scope.projectId} / ${record.id} · ${record.title}`)
  }
  parts.push('', 'Return only {"expand":[...]}.')
  return parts.join('\n')
}

/**
 * Render the summaries plus the records the model asked to read.
 * @param scopes - the projects in the window.
 * @param expanded - records requested in phase one.
 * @param since - exclusive lower bound, or undefined.
 * @param now - scan time, ISO-8601.
 * @returns the user-role payload.
 */
export function synthesisPrompt(
  scopes: readonly DigestScope[],
  expanded: readonly ExpandedRecord[],
  since: string | undefined,
  now: string,
): string {
  const parts = [
    `Digest window: ${since ?? 'all available'} .. ${now}`,
    '',
    'Project summaries that moved in this window:',
  ]
  for (const scope of scopes) {
    parts.push('', `## project ${scope.projectId}`, scope.summary.content.trim())
  }
  parts.push('', 'Records you asked to read:')
  if (expanded.length === 0) parts.push('(none)')
  for (const item of expanded) {
    parts.push('', `## project ${item.projectId}`, `- ${item.record.id} · ${item.record.title}`, item.record.content)
  }
  parts.push('', 'Return only {"candidates":[...]}.')
  return parts.join('\n')
}

/**
 * Read the JSON object out of a model answer.
 * @param text - the answer.
 * @returns the parsed object.
 * @throws when no JSON object is present.
 */
function readObject(text: string): Record<string, unknown> {
  const raw = String(text ?? '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`dsh-reflection: digest model returned no JSON object (${String(raw.length)} characters)`)
  const parsed = JSON.parse(raw.slice(start, end + 1))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('dsh-reflection: digest plan must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Parse the phase-one expansion request, keeping only offered record ids.
 * @param text - the model answer.
 * @param allowed - record ids present in the index.
 * @returns requested ids, unique.
 */
export function parseExpansion(text: string, allowed: ReadonlySet<string>): string[] {
  const parsed = readObject(text)
  const expand = Array.isArray(parsed.expand) ? parsed.expand : []
  const ids = new Set<string>()
  for (const id of expand) {
    if (typeof id === 'string' && allowed.has(id)) ids.add(id)
  }
  return [...ids]
}

/**
 * Parse and check the phase-two candidates.
 * @param text - the model answer.
 * @param allowedSources - `${projectId}/${recordId}` keys that exist.
 * @returns accepted candidates and why others were dropped.
 */
export function parseCandidates(text: string, allowedSources: ReadonlySet<string>): {
  accepted: DigestCandidate[]
  rejected: { reason: string }[]
} {
  const parsed = readObject(text)
  const rows = Array.isArray(parsed.candidates) ? parsed.candidates : []
  const accepted: DigestCandidate[] = []
  const rejected: { reason: string }[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      rejected.push({ reason: 'candidate is not an object' })
      continue
    }
    const candidate = row as Record<string, unknown>
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const content = typeof candidate.content === 'string' ? candidate.content.trim() : ''
    if (title === '') { rejected.push({ reason: 'title is missing' }); continue }
    if (/[\n\r\u2028\u2029]/u.test(title)) { rejected.push({ reason: 'title is not a single line' }); continue }
    if (content === '') { rejected.push({ reason: 'content is empty' }); continue }
    if (/[\n\r\u2028\u2029]/u.test(content)) { rejected.push({ reason: 'content is not a single line' }); continue }
    if (charLength(content) > MAX_CONTENT_CHARS) { rejected.push({ reason: `content is longer than ${String(MAX_CONTENT_CHARS)} characters` }); continue }
    const secret = findSecretIn([title, content])
    if (secret !== undefined) { rejected.push({ reason: `secret-detected:${secret.name}` }); continue }
    const sources: { project_id: string; record_id: string }[] = []
    for (const source of Array.isArray(candidate.derived_from) ? candidate.derived_from : []) {
      if (typeof source !== 'object' || source === null) continue
      const projectId = typeof (source as Record<string, unknown>).project_id === 'string' ? (source as { project_id: string }).project_id : ''
      const recordId = typeof (source as Record<string, unknown>).record_id === 'string' ? (source as { record_id: string }).record_id : ''
      if (!allowedSources.has(`${projectId}/${recordId}`)) continue
      sources.push({ project_id: projectId, record_id: recordId })
    }
    if (sources.length === 0) { rejected.push({ reason: 'no known source record' }); continue }
    const key = normalizeContent(content)
    if (seen.has(key)) { rejected.push({ reason: 'duplicate candidate' }); continue }
    seen.add(key)
    accepted.push({ title, content, derived_from: sources })
  }
  return { accepted, rejected }
}
