/**
 * How a record's score moves with time and confirmed use.
 *
 * Two values describe a record, and they answer different questions:
 *
 * - `confidence` is fixed when the record is created: how reliable the fact was
 *   when it was written (see `confidence.ts`).
 * - `score` is derived on every read: `confidence × 0.5 ^ (age / halfLife)`.
 *
 * The half-life starts from the confidence and grows by 1% per confirmed helpful
 * use, so a record that keeps proving useful decays more slowly, while one that
 * was never confirmed falls below the serving threshold. Access alone (a search
 * hit or a read) only updates diagnostics; it must not be mistaken for use.
 *
 * @module dsh-reflection/priority
 */

import type { MemoryRecord } from './types/memory.js'

/** Smallest half-life a record may have, in days. */
export const MIN_STABILITY_DAYS = 3
/** Largest half-life a record may have, in days. */
export const MAX_STABILITY_DAYS = 365
/** Milliseconds in one day. */
const DAY_MS = 86_400_000
/** Half-life growth per confirmed helpful use. */
export const CONFIRMATION_GROWTH = 0.01

/**
 * The half-life a new record starts with.
 * @param confidence - the writer's confidence in [0, 1].
 * @returns days, clamped to {@link MIN_STABILITY_DAYS}..{@link MAX_STABILITY_DAYS}.
 */
export function initialStability(confidence: number): number {
  const safe = Number.isFinite(confidence) ? confidence : 1
  const value = 3 * Math.pow(60, Math.max(0, Math.min(1, safe)))
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, value))
}

/**
 * The record's current half-life.
 *
 * Starts at the value its confidence earns and grows with confirmed use, so the
 * useful records are the slow-decaying ones. Old rows without the new fields
 * fall back to their confidence and to zero confirmations.
 * @param record - one record.
 * @returns days, within the allowed range.
 */
export function halfLifeDays(record: MemoryRecord): number {
  const confirmations = Number.isFinite(record.effective_count) ? Math.max(0, record.effective_count ?? 0) : 0
  const grown = initialStability(record.confidence) * (1 + CONFIRMATION_GROWTH * confirmations)
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, grown))
}

/**
 * The time the record was last known to do its job.
 *
 * `last_effective_at` is a confirmed helpful use; older rows fall back through
 * the feedback and access timestamps they already have.
 * @param record - one record.
 * @returns an ISO-8601 time, always parseable for rows this plugin wrote.
 */
export function effectiveAt(record: MemoryRecord): string {
  return record.last_effective_at
    ?? record.last_feedback_at
    ?? record.last_access_at
    ?? record.updated_at
}

/**
 * Read a record's age in days since it last did its job.
 * @param record - one record.
 * @param nowMs - current epoch milliseconds.
 * @returns non-negative days.
 */
export function ageDays(record: MemoryRecord, nowMs: number): number {
  const from = Date.parse(effectiveAt(record))
  if (!Number.isFinite(from)) return 0
  return Math.max(0, (nowMs - from) / DAY_MS)
}

/**
 * The record's current score: its write-time confidence decayed since it last
 * did its job. Served records are ranked and thresholded by this value.
 * @param record - one record.
 * @param nowMs - current epoch milliseconds.
 * @returns a value in [0, 1].
 */
export function score(record: MemoryRecord, nowMs: number): number {
  const confidence = Number.isFinite(record.confidence) ? record.confidence : 0
  const decay = Math.pow(0.5, ageDays(record, nowMs) / halfLifeDays(record))
  return Math.max(0, Math.min(1, confidence * decay))
}

/**
 * Apply one access to diagnostics only.
 *
 * Reads are not use: they say the record was fetched, not that it helped. The
 * score ignores both fields; a confirmed helpful use is what moves it.
 * @param record - one record.
 * @param weight - access weight; memory_get is 1, a search hit is 0.25.
 * @param atIso - access time, ISO-8601.
 * @returns the fields to merge into the record.
 */
export function accessUpdate(record: MemoryRecord, weight: number, atIso: string) {
  return {
    access_count: (record.access_count ?? 0) + weight,
    last_access_at: atIso,
  }
}
