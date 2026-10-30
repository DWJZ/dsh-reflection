/**
 * The reviewable output of one digest run.
 *
 * Same candidates in two forms: JSON for a later apply step, Markdown for a
 * person. Nothing here writes Memory; the run is a proposal.
 *
 * @module dsh-reflection/digest/pending
 */

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
