/**
 * Records every plugin record one Session publishes.
 *
 * The integration suite runs the harness from source, so this is the case where
 * a second copy of the session module would show up: `appendPluginRecord` from
 * another copy refuses the Session it is handed, and then no event is ever
 * published. Reading the published feed therefore proves the write reached the
 * harness's own Session, which the persisted log cannot show here — the headless
 * profile does not flush its JSONL generation during a one-shot run.
 *
 * `DSH_MEMORY_RECORD_LOG` names the file to append to; without it this fixture
 * stays inert.
 */
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'dsh-reflection-record-spy'

/** The Session event feed this fixture reads. */
export const inject = []

/** One published event, as much of it as this fixture keeps. */
interface ObservedRecord {
  type?: unknown
  ignorable?: unknown
  data?: unknown
}

/**
 * Append every published plugin record to the configured log.
 * @param ctx - the plugin's context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.on('session/event', (_session: unknown, event: ObservedRecord) => {
    const log = process.env.DSH_MEMORY_RECORD_LOG
    if (log === undefined) return
    if (typeof event?.type !== 'string' || !event.type.startsWith('plugin:')) return
    appendFileSync(log, `${JSON.stringify({ type: event.type, ignorable: event.ignorable === true, data: event.data })}\n`)
  }), 'dsh-reflection-record-spy: feed')
}
