/**
 * Reading the events this process never observed.
 *
 * The collector is a projection: it knows what it saw after the plugin mounted,
 * and nothing about a Session resumed in another process or a range its buffer
 * had to evict. The harness does offer a supported read for that history — the
 * `sessionQuery` service — so before a hole is written down as a gap, the plugin
 * asks for the events and folds them into the batch.
 *
 * The service is optional. A profile without it keeps the old behavior, where an
 * unreadable range is recorded as a gap; a failed read is treated the same way.
 *
 * @module dsh-reflection/history
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EventPayload, ObservedEvent } from './types/trajectory.js'

/**
 * Largest hole one call will read.
 *
 * A batch is capped at a couple of hundred events, so a hole far larger than that
 * is read and mostly discarded. Past this size the range stays a gap: the cost of
 * pulling it in is not paid for something the window cannot use anyway.
 */
const MAX_BACKFILL_EVENTS = 2000

/** What one backfill needs from the harness. */
export interface HistoryReader {
  /**
   * Read one contiguous range of raw Session events.
   * @param sessionId - the Session to read.
   * @param fromSeq - first seq wanted, inclusive.
   * @param toSeq - last seq wanted, inclusive.
   * @returns the events in ascending seq order, or undefined when the range cannot be read whole.
   */
  read(sessionId: string, fromSeq: number, toSeq: number): Promise<ObservedEvent[] | undefined>
}

/** The part of the harness session-query service this reader uses. */
interface SessionQueryService {
  readEvent?(request: {
    sessionId: string
    seq: number
    before?: number
    after?: number
  }): Promise<{ events?: readonly unknown[] } | undefined>
}

/** One raw event, as much of it as this reader validates. */
interface RawEvent {
  seq?: unknown
  type?: unknown
  data?: unknown
  ignorable?: unknown
}

/**
 * Build the reader over the harness's session-query service.
 * @param ctx - Cordis context of this plugin's fiber.
 * @returns a reader that answers `undefined` whenever the harness cannot.
 */
export function createHistoryReader(ctx: Context): HistoryReader {
  return {
    async read(sessionId, fromSeq, toSeq) {
      if (!Number.isInteger(fromSeq) || !Number.isInteger(toSeq) || toSeq < fromSeq) return []
      if (toSeq - fromSeq + 1 > MAX_BACKFILL_EVENTS) return undefined
      // A stub context in the unit suites has no service resolver at all; a
      // missing resolver and a missing service are the same answer here.
      const service = typeof ctx.get === 'function'
        ? ctx.get('sessionQuery') as SessionQueryService | undefined
        : undefined
      if (service === undefined || typeof service.readEvent !== 'function') return undefined
      try {
        // `readEvent` is a window around one seq: targeting the end of the range
        // and asking for everything before it reads exactly the hole.
        const window = await service.readEvent({ sessionId, seq: toSeq, before: toSeq - fromSeq, after: 0 })
        if (window === undefined || !Array.isArray(window.events)) return undefined
        const mapped: ObservedEvent[] = []
        for (const raw of window.events as RawEvent[]) {
          if (typeof raw?.seq !== 'number' || !Number.isInteger(raw.seq)) continue
          if (raw.seq < fromSeq || raw.seq > toSeq) continue
          if (typeof raw.type !== 'string') continue
          mapped.push({
            seq: raw.seq,
            type: raw.type,
            data: (raw.data ?? {}) as EventPayload,
            ...raw.ignorable === true ? { ignorable: true } : {},
          })
        }
        mapped.sort((left, right) => left.seq - right.seq)
        // A pruned or forked log can answer with a shorter window. A partial range
        // is not a backfill: folding it in would consume the remaining hole unread.
        if (mapped.length !== toSeq - fromSeq + 1) return undefined
        const head = mapped[0]
        const tail = mapped[mapped.length - 1]
        if (head === undefined || tail === undefined) return undefined
        if (head.seq !== fromSeq || tail.seq !== toSeq) return undefined
        return mapped
      } catch {
        // A failed read is the same as no reader: the caller records the gap.
        return undefined
      }
    },
  }
}
