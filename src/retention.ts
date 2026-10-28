/**
 * What one scope's records are, and in which order they are listed.
 *
 * Summary counts, the `MEMORY.md` index, and every reader that walks active
 * Memory order records here, so a human reading a file and a model reading a
 * count never disagree about which records exist or how they sort.
 *
 * Confidence deliberately plays no part: an explicit write is certain, and an
 * automatic one carries the model's own estimate, which is not a ranking signal.
 *
 * @module dsh-reflection/retention
 */

import type { MemoryRecord } from './types/memory.js'

/** Category order used for display; earlier categories list first. */
export const CATEGORY_PRIORITY = Object.freeze([
  'preference',
  'feedback',
  'decision',
  'lesson',
  'state',
  'reference',
])

/**
 * Rank of one category.
 * @param category - the record's category.
 * @returns the position in {@link CATEGORY_PRIORITY}; unknown categories sort last.
 */
export function categoryRank(category: string): number {
  const index = CATEGORY_PRIORITY.indexOf(category)
  return index < 0 ? CATEGORY_PRIORITY.length : index
}

/**
 * Order two records for display: category priority, then most recently updated,
 * then id so the order is total and reproducible.
 * @param left - one record.
 * @param right - the other record.
 * @returns a negative number when `left` sorts first.
 */
export function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
  const byCategory = categoryRank(left.category) - categoryRank(right.category)
  if (byCategory !== 0) return byCategory
  if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Keep the records ordinary retrieval and injection may see.
 * @param records - every record in one scope.
 * @returns the active records, ordered by {@link compareRecords}.
 */
export function activeRecords(records: MemoryRecord[]) {
  return records.filter((record: MemoryRecord) => record.status === 'active').sort(compareRecords)
}

/**
 * Measure text the way a byte budget is expressed.
 * @param text - the text to measure.
 * @returns its length in UTF-8 bytes.
 */
export function byteLength(text: string) {
  return Buffer.byteLength(text, 'utf8')
}
