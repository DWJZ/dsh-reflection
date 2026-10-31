/**
 * Automatic recall for the request being assembled.
 *
 * The summary is a directory, not a guarantee that every record is mentioned.
 * The latest user message is used as a local search query, and the top matches
 * are listed by id and title so the agent can open them without having to guess
 * what to search for.
 *
 * @module dsh-reflection/recall
 */

import { foldForSearch, searchRecords } from './retrieval.js'
import type { MemoryRecord } from './types/memory.js'

/** One automatically recalled record. */
export interface RecallEntry {
  id: string
  title: string
  scope: 'user' | 'project'
  project_id: string | null
}

/**
 * Extract the user's text from one Session event.
 * @param event - a committed Session event.
 * @returns the text, or undefined when the event is not a user message.
 */
export function userTextFromEvent(event: { type?: unknown; data?: unknown }): string | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const source = (data as { source?: { kind?: unknown } }).source
  if (typeof source !== 'object' || source === null || source.kind !== 'user') return undefined
  const content = (data as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const text = content
    .filter((block): block is { type: 'text'; text: string } => typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text)
    .join(' ')
    .trim()
  return text === '' ? undefined : text
}

/**
 * Pick the records to recall for one query.
 * @param records - every record this request may see.
 * @param summaryText - the injected summary, used to avoid repeating titles.
 * @param query - the latest user message.
 * @param projectId - the current project, when there is one.
 * @param nowMs - clock for the priority re-rank.
 * @param topK - largest recall list.
 * @returns records to list, in rank order.
 */
export function selectRecall(
  records: readonly MemoryRecord[],
  summaryText: string,
  query: string,
  projectId: string | null | undefined,
  nowMs: number,
  topK = 3,
): RecallEntry[] {
  if (query.trim() === '') return []
  const summary = foldForSearch(summaryText)
  const found = searchRecords([...records], { query, projectId, topK: Math.max(topK * 4, 12), now: nowMs })
  const byId = new Map(records.map(record => [record.id, record]))
  const entries: RecallEntry[] = []
  for (const result of found.results) {
    const record = byId.get(result.id)
    if (record === undefined || record.title === '') continue
    if (summary.includes(foldForSearch(record.title))) continue
    entries.push({ id: record.id, title: record.title, scope: record.scope, project_id: record.project_id ?? null })
    if (entries.length >= topK) break
  }
  return entries
}

/**
 * Render the automatic recall block.
 * @param entries - records selected for recall.
 * @returns the block, or an empty string when nothing was selected.
 */
export function renderRecall(entries: readonly RecallEntry[]): string {
  if (entries.length === 0) return ''
  return [
    '<memory-recall>',
    'Found automatically from the latest user message; open one by id with memory_get:',
    ...entries.map(entry => `- ${entry.id} · ${entry.title}`),
    '</memory-recall>',
  ].join('\n')
}
