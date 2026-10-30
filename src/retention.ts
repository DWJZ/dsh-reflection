/**
 * What one scope's records are, and in which order they are listed.
 *
 * Summary counts, the index, and every reader that walks active
 * Memory order records here, so a human reading a file and a model reading a
 * count never disagree about which records exist or how they sort.
 *
 * Confidence deliberately plays no part: an explicit write is certain, and an
 * automatic one carries the model's own estimate, which is not a ranking signal.
 *
 * @module dsh-reflection/retention
 */

import type { MemoryRecord } from './types/memory.js'

/**
 * Order two records for display: most recently updated first, then id so the
 * order is total and reproducible.
 * @param left - one record.
 * @param right - the other record.
 * @returns a negative number when `left` sorts first.
 */
export function compareRecords(left: MemoryRecord, right: MemoryRecord): number {
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
