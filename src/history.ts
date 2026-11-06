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
 * A range over {@link MAX_BACKFILL_EVENTS} is requested in chunks by the caller,
 * and each chunk is paged to the service's window cap rather than sent as one
 * oversized request.
 *
 * @module dsh-reflection/history
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EventPayload, ObservedEvent } from './types/trajectory.js'

/**
 * Largest range one history call will read.
 *
 * This is a chunk size, not a give-up threshold: consolidation reads a larger
 * hole in consecutive chunks of this size, so a long backlog is drained rather
 * than recorded as one gap. A single batch only uses a couple of hundred events,
 * so chunking keeps each read close to what the window can consume.
 */
export const MAX_BACKFILL_EVENTS = 2000

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

/** The one read call this reader makes, once the service is known to have it. */
type ReadEvent = NonNullable<SessionQueryService["readEvent"]>

/**
 * Largest number of events one `readEvent` call requests.
 *
 * The harness caps that window (`readWindowMax`, 50 by default) and rejects a
 * larger request, which would otherwise turn a readable hole into a gap. Reads
 * above this size are paged; a deployment that caps the window lower makes the
 * reader halve its page and retry.
 */
export const READ_WINDOW_EVENTS = 50

/**
 * Read one page and validate that it covers exactly the requested range.
 * @param readEvent - the harness session-query read call.
 * @param sessionId - the Session to read.
 * @param fromSeq - first seq wanted, inclusive.
 * @param toSeq - last seq wanted, inclusive.
 * @returns the page in ascending order, or undefined when the answer is partial.
 * @throws when the service rejects the request; the caller retries with a smaller page.
 */
async function readPage(
  readEvent: ReadEvent,
  sessionId: string,
  fromSeq: number,
  toSeq: number,
): Promise<ObservedEvent[] | undefined> {
  // `readEvent` is a window around one seq: targeting the end of the range and
  // asking for everything before it reads exactly this page.
  const window = await readEvent({
    sessionId,
    seq: toSeq,
    before: toSeq - fromSeq,
    after: 0,
  })
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
  // A pruned or forked log can answer with a shorter window. A partial range is
  // not a backfill: folding it in would consume the remaining hole unread.
  if (mapped.length !== toSeq - fromSeq + 1) return undefined
  const head = mapped[0]
  const tail = mapped[mapped.length - 1]
  if (head === undefined || tail === undefined) return undefined
  if (head.seq !== fromSeq || tail.seq !== toSeq) return undefined
  return mapped
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
      const events: ObservedEvent[] = []
      let cursor = fromSeq
      let pageSize = READ_WINDOW_EVENTS
      while (cursor <= toSeq) {
        const end = Math.min(cursor + pageSize - 1, toSeq)
        let page: ObservedEvent[] | undefined
        try {
          page = await readPage(service.readEvent, sessionId, cursor, end)
        } catch {
          // A deployment may cap the window below the harness default. Retry the
          // same page smaller rather than recording a readable hole as a gap.
          if (pageSize <= 1) return undefined
          pageSize = Math.max(1, Math.floor(pageSize / 2))
          continue
        }
        if (page === undefined) return undefined
        events.push(...page)
        cursor = end + 1
      }
      return events
    },
  }
}
