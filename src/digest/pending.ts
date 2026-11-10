/**
 * The reviewable output of one digest run.
 *
 * Same candidates in two forms: JSON for a later apply step, Markdown for a
 * person. Nothing here writes Memory; the run is a proposal.
 *
 * @module dsh-reflection/digest/pending
 */

import { existsSync, readFileSync } from 'node:fs'
import { failureMessage } from '../errors.js'
import type { DigestCandidate, RejectedCandidate } from './prompt.js'

/** One pending digest document. */
export interface PendingDigest {
  version: 1
  created_at: string
  scan_from: string | null
  scan_to: string
  model?: string | undefined
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number | undefined } | undefined
  candidates: DigestCandidate[]
  rejected?: RejectedCandidate[] | undefined
}

/**
 * Render the machine-readable pending file.
 * @param entry - the run's candidates and window.
 * @returns the file content.
 */
export function renderPendingDocument(entry: PendingDigest): string {
  return `${JSON.stringify(entry, null, 2)}\n`
}

/**
 * Render the human-readable pending file.
 * @param entry - the run's candidates and window.
 * @returns the file content.
 */
export function renderPendingMarkdown(entry: PendingDigest): string {
  const lines = [
    '# Pending cross-project experience',
    '',
    `- window: ${entry.scan_from ?? 'all available'} .. ${entry.scan_to}`,
    `- created: ${entry.created_at}`,
    `- candidates: ${String(entry.candidates.length)}`,
  ]
  if (entry.model !== undefined) lines.push(`- model: ${entry.model}`)
  if (entry.candidates.length === 0) {
    lines.push('', 'No candidate experience was proposed for this window.')
    return `${lines.join('\n')}\n`
  }
  if (entry.rejected !== undefined && entry.rejected.length > 0) {
    lines.push('', '## Rejected', '')
    for (const rejected of entry.rejected) {
      const workspaces = rejected.workspaces === undefined ? '' : ` (${String(rejected.workspaces)} workspace)`
      lines.push(`- ${rejected.title === undefined || rejected.title === '' ? '(no title)' : rejected.title} — ${rejected.reason}${workspaces}`)
    }
  }
  for (const [index, candidate] of entry.candidates.entries()) {
    lines.push('', `## ${String(index + 1)}. ${candidate.title}`, '')
    lines.push(candidate.content)
    lines.push('')
    lines.push(`sources: ${candidate.derived_from.map(source => `${source.project_id}/${source.record_id}`).join(' · ')}`)
  }
  return `${lines.join('\n')}\n`
}

/** What reading the pending file produced. */
export type PendingRead =
  | { status: 'none' }
  | { status: 'invalid'; reason: string }
  | { status: 'pending'; entry: PendingDigest }

/**
 * Read the pending file without trusting it.
 *
 * The file is written by this plugin, but a person can edit it between runs and a
 * half-written document must not reach the review page as if it were valid. A
 * malformed document is reported, not thrown: the caller shows the reason and
 * keeps the review page usable.
 * @param path - absolute path of `digest/pending.json`.
 * @returns the absence, the parsed document, or why it cannot be read.
 */
export function readPending(path: string): PendingRead {
  if (!existsSync(path)) return { status: 'none' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (failure) {
    return { status: 'invalid', reason: `pending.json is not valid JSON: ${failureMessage(failure)}` }
  }
  const problem = pendingProblem(parsed)
  if (problem !== undefined) return { status: 'invalid', reason: problem }
  return { status: 'pending', entry: parsed as PendingDigest }
}

/**
 * Check the fields the review page and the apply step read.
 * @param value - the parsed file content.
 * @returns why the document is unusable, or undefined when it is.
 */
function pendingProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'pending.json must hold a JSON object'
  const entry = value as Record<string, unknown>
  if (entry.version !== 1) return `pending.json has version ${JSON.stringify(entry.version)}, this build reads 1`
  if (typeof entry.created_at !== 'string' || typeof entry.scan_to !== 'string') {
    return 'pending.json is missing created_at or scan_to'
  }
  if (entry.scan_from !== null && entry.scan_from !== undefined && typeof entry.scan_from !== 'string') {
    return 'pending.json has an invalid scan_from'
  }
  if (!Array.isArray(entry.candidates)) return 'pending.json is missing its candidates array'
  for (const [index, candidate] of entry.candidates.entries()) {
    const problem = candidateProblem(candidate, index)
    if (problem !== undefined) return problem
  }
  if (entry.rejected !== undefined && !Array.isArray(entry.rejected)) return 'pending.json has an invalid rejected list'
  return undefined
}

/**
 * Check one candidate's fields.
 * @param value - the parsed candidate.
 * @param index - its position, for the diagnostic.
 * @returns why the candidate is unusable, or undefined when it is.
 */
function candidateProblem(value: unknown, index: number): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `pending.json candidate ${String(index + 1)} is not an object`
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.title !== 'string' || typeof candidate.content !== 'string') {
    return `pending.json candidate ${String(index + 1)} is missing title or content`
  }
  if (!Array.isArray(candidate.derived_from)) {
    return `pending.json candidate ${String(index + 1)} is missing derived_from`
  }
  for (const source of candidate.derived_from) {
    if (typeof source !== 'object' || source === null) {
      return `pending.json candidate ${String(index + 1)} has an invalid source`
    }
    const id = source as Record<string, unknown>
    if (typeof id.project_id !== 'string' || typeof id.record_id !== 'string') {
      return `pending.json candidate ${String(index + 1)} has an invalid source`
    }
  }
  return undefined
}
