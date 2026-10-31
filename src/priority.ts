/**
 * How an active record's serving priority ages.
 *
 * The score uses only confidence and time: a record keeps `stability_days` as
 * its decay scale, and a power-law curve leaves a long tail, so an old but
 * correct record remains reachable instead of vanishing. Access nudges stability
 * slightly; consolidation feedback adjusts it more when evidence exists.
 *
 * @module dsh-reflection/priority
 */

import type { MemoryRecord } from './types/memory.js'

/** Smallest stability a record may have, in days. */
export const MIN_STABILITY_DAYS = 3
/** Largest stability a record may have, in days. */
export const MAX_STABILITY_DAYS = 365
/** Fraction of a day in milliseconds. */
const DAY_MS = 86_400_000

/**
 * The stability a new record starts with.
 * @param confidence - the writer's confidence in [0, 1].
 * @returns days, clamped to {@link MIN_STABILITY_DAYS}..{@link MAX_STABILITY_DAYS}.
 */
export function initialStability(confidence: number): number {
  const safe = Number.isFinite(confidence) ? confidence : 1
  const value = 3 * Math.pow(60, Math.max(0, Math.min(1, safe)))
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, value))
}

/**
 * The record's decay scale, defaulting old rows to their confidence.
 * @param record - one record.
 * @returns days, within the allowed range.
 */
export function stabilityDays(record: MemoryRecord): number {
  const value = record.stability_days ?? initialStability(record.confidence)
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, value))
}

/**
 * Read a record's age in days.
 * @param record - one record.
 * @param nowMs - current epoch milliseconds.
 * @returns non-negative days since the last access, or since the update.
 */
export function ageDays(record: MemoryRecord, nowMs: number): number {
  const from = Date.parse(record.last_access_at ?? record.updated_at)
  if (!Number.isFinite(from)) return 0
  return Math.max(0, (nowMs - from) / DAY_MS)
}

/**
 * The retrievability curve: a power law with a long tail.
 * @param record - one record.
 * @param nowMs - current epoch milliseconds.
 * @returns a value in (0, 1]; equals 0.5 at one stability period.
 */
export function retrievability(record: MemoryRecord, nowMs: number): number {
  return 1 / (1 + ageDays(record, nowMs) / stabilityDays(record))
}

/**
 * Order active records for serving. Confidence is a multiplier, not a filter.
 * @param record - one record.
 * @param nowMs - current epoch milliseconds.
 * @returns a positive priority; higher means more prominent.
 */
export function priority(record: MemoryRecord, nowMs: number): number {
  const confidence = Number.isFinite(record.confidence) ? record.confidence : 1
  return confidence * (0.4 + 0.6 * retrievability(record, nowMs))
}

/**
 * Apply one access to access metadata.
 * @param record - one record.
 * @param weight - access weight; memory_get is 1, a search hit is 0.25.
 * @param atIso - access time, ISO-8601.
 * @returns the fields to merge into the record.
 */
export function accessUpdate(record: MemoryRecord, weight: number, atIso: string) {
  const grown = stabilityDays(record) * (1 + 0.01 * weight)
  return {
    access_count: (record.access_count ?? 0) + weight,
    last_access_at: atIso,
    stability_days: Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, grown)),
  }
}
