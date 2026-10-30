/**
 * The digest checkpoint.
 *
 * A manual digest consumes the project summaries that moved since the previous
 * run. The checkpoint is the time it started, so an update that lands during the
 * run is picked up next time rather than silently skipped.
 *
 * @module dsh-reflection/digest/state
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../jsonstore.js'

/** What the digest remembers between runs. */
export interface DigestState {
  /** Start of the last successful proposal run, ISO-8601. */
  lastScanAt?: string | undefined
}

/** How far back a first run looks. */
export const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000

/**
 * Read the digest checkpoint.
 * @param path - absolute path of `digest/state.json`.
 * @returns the checkpoint, or an empty one when absent or malformed.
 */
export function readDigestState(path: string): DigestState {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null && typeof parsed.lastScanAt === 'string') {
      return { lastScanAt: parsed.lastScanAt }
    }
  } catch {
    // A corrupted checkpoint means "no checkpoint", not a reason to refuse the run.
  }
  return {}
}

/**
 * Write the digest checkpoint atomically.
 * @param path - absolute path of `digest/state.json`.
 * @param state - the checkpoint to persist.
 * @returns nothing.
 */
export function writeDigestState(path: string, state: DigestState): void {
  writeAtomic(path, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`)
}

/**
 * The checkpoint a first run uses.
 * @param now - current epoch milliseconds.
 * @returns the ISO time one day earlier.
 */
export function defaultSince(now: number): string {
  return new Date(now - DEFAULT_LOOKBACK_MS).toISOString()
}
