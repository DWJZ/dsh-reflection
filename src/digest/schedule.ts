/**
 * The daily automatic digest.
 *
 * One scan a day at 00:00 Asia/Shanghai (Beijing has no daylight saving, so the
 * offset is a constant). The scan writes pending candidates for review; it never
 * applies anything. The timer lives in the host process, so a night the harness
 * is not running is simply missed.
 *
 * The timer is deliberately outside the agent's maintenance phase: a scan takes
 * a model call, and sleeping inside maintenance would block a turn for hours.
 *
 * Usage: `const daily = createDailyDigest({ run, enabled }); daily.start()`.
 *
 * @module dsh-reflection/digest/schedule
 */

import { failureMessage } from '../errors.js'

/** Beijing is UTC+8 all year; the digest schedule is defined in that zone. */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** Milliseconds in one day. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The next 00:00 Asia/Shanghai strictly after an instant.
 * @param nowMs - current epoch milliseconds.
 * @returns the epoch milliseconds of the next Beijing midnight.
 */
export function nextBeijingMidnight(nowMs: number): number {
  const local = nowMs + BEIJING_OFFSET_MS
  const dayStart = Math.floor(local / DAY_MS) * DAY_MS
  return dayStart + DAY_MS - BEIJING_OFFSET_MS
}

/** What one daily timer takes. */
export interface DailyDigestOptions {
  /** Run one digest. A rejection is logged and the next day is still scheduled. */
  run(): Promise<void>
  /** Whether the plugin is on; a disabled plugin must not reach a model. */
  enabled(): boolean
  /** Injectable clock, so a test can place itself before midnight. */
  now?(): number
  /** Injectable timer starter, so a test can fire the scan without waiting. */
  schedule?(run: () => Promise<void>, ms: number): ReturnType<typeof setTimeout>
  /** Injectable timer canceller, for the same reason. */
  cancelSchedule?(handle: ReturnType<typeof setTimeout>): void
  /** Diagnostic sink. */
  logger?: { info?(message: string): void; warn(message: string | Error): void }
}

/** What the daily timer exposes. */
export interface DailyDigest {
  /** Arm the next scan. Calling it twice does not arm two timers. */
  start(): void
  /** Drop the pending timer without waiting for a running scan. */
  cancel(): void
  /** Stop scheduling and drop the pending timer. */
  dispose(): void
  /** Wait for the scan in flight, if there is one. */
  whenSettled(): Promise<void>
}

/**
 * Build the daily digest timer.
 * @param options - the scan, the switch, and the injectable clock and timers.
 * @returns the timer.
 */
export function createDailyDigest(options: DailyDigestOptions): DailyDigest {
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms))
  const cancelSchedule = options.cancelSchedule ?? (handle => { clearTimeout(handle) })
  let handle: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | null = null
  let disposed = false

  /**
   * Arm the next Beijing midnight.
   * @returns nothing.
   */
  const arm = (): void => {
    if (disposed || handle !== undefined) return
    const delay = Math.max(0, nextBeijingMidnight(now()) - now())
    handle = schedule(() => fire(), delay)
  }

  /**
   * Run one scan, then arm the next one.
   *
   * A disabled plugin, or a scan already running, still re-arms: the schedule
   * must not die because one night was skipped.
   * @returns fulfillment once the scan settled.
   */
  const fire = async (): Promise<void> => {
    handle = undefined
    if (disposed) return
    if (!options.enabled()) {
      options.logger?.info?.('dsh-reflection: automatic digest skipped; Memory is off')
      arm()
      return
    }
    if (running !== null) {
      arm()
      return
    }
    const work = options.run()
    running = work
    try {
      await work
    } catch (failure) {
      options.logger?.warn(`dsh-reflection: automatic digest failed: ${failureMessage(failure)}`)
    } finally {
      running = null
      arm()
    }
  }

  return {
    start() {
      arm()
    },
    cancel() {
      if (handle !== undefined) cancelSchedule(handle)
      handle = undefined
    },
    dispose() {
      disposed = true
      this.cancel()
    },
    async whenSettled() {
      await running
    },
  }
}
