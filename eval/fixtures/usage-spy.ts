/**
 * Evaluation-only: record the token usage a run reported.
 *
 * The headless `--json` stream carries answers and tool calls but no usage, and
 * the one-shot process exits before the durable log is flushed. This spy reads
 * the committed events instead: each `assistant/message` carries the provider's
 * usage, and a consolidation audit carries the usage of the consolidator call.
 *
 * `DSH_EVAL_USAGE_LOG` names the file to append to; without it this plugin is
 * inert, so mounting it outside the evaluation changes nothing.
 */
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'dsh-reflection-eval-usage-spy'

/** One usage record, as this fixture writes it. */
interface UsageLine {
  kind: 'assistant' | 'consolidation'
  sessionId: string
  cwd?: string | undefined
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  totalTokens?: number | undefined
}

/**
 * Append one usage line, best effort.
 * @param line - the record to write.
 * @returns nothing.
 */
function note(line: UsageLine): void {
  const log = process.env.DSH_EVAL_USAGE_LOG
  if (log === undefined) return
  try {
    appendFileSync(log, `${JSON.stringify(line)}\n`)
  } catch {
    // Diagnostics are best effort; a missing log never changes the run.
  }
}

/**
 * Subscribe to the committed event feed.
 * @param ctx - the plugin's context.
 * @returns nothing.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.on('session/event', (session: any, event: any) => {
    const sessionId = typeof session?.id === 'string' ? session.id : session?.header?.id
    if (typeof sessionId !== 'string') return
    const cwd = typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
    if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
      const usage = event.data.usage
      note({
        kind: 'assistant',
        sessionId,
        ...cwd === undefined ? {} : { cwd },
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
      })
      return
    }
    if (event?.type === 'plugin:dsh-reflection/consolidation' && event.data?.usage !== undefined) {
      const usage = event.data.usage
      note({
        kind: 'consolidation',
        sessionId,
        ...cwd === undefined ? {} : { cwd },
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
      })
    }
  }), 'dsh-reflection-eval-usage-spy: feed')
}
