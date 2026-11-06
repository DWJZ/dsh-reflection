/**
 * Drives one automatic consolidation at the exact moment it becomes possible.
 *
 * The plugin's own trigger waits out a debounce on a timer that deliberately
 * lives outside the agent's maintenance phase, which is right for a long-running
 * application and unreachable in a one-shot harness: the process exits as soon
 * as the turn is idle, long before the debounce has passed. Waiting for it here
 * would make the suite depend on a race with process exit.
 *
 * So this fixture takes the other supported entry point — the same `/memory
 * consolidate` command a person would type — and invokes it once, after the
 * Session has produced events. The consolidation then runs as a maintenance
 * task, which `whenIdle()` follows, so the harness waits for it.
 *
 * With `DSH_MEMORY_FOLLOWUP_TASK` set, the fixture then queues one ordinary
 * follow-up turn in the same process. The runtime-context suite uses it to ask
 * the same Session again after Memory changed.
 *
 * `DSH_MEMORY_DRIVER_LOG` records each step, because a throw inside an event
 * listener is contained by the harness and would otherwise be invisible.
 */
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

// The fixture lives under the plugin, which has no workspace link to the harness
// packages, so it resolves the checkout the same way the scripted adapter does.
const HARNESS = process.env.DSH_REPO ?? join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const LLM_ENTRY = join(HARNESS, 'packages/llm/llm/src/index.ts')
const { createUserMessage } = await import(pathToFileURL(LLM_ENTRY).href) as {
  createUserMessage: (input: object) => object
}

/** Stable Cordis plugin name. */
export const name = 'dsh-reflection-consolidate-on-idle'

/** The command surface this fixture drives. */
export const inject = ['commands']

/** Which `/memory` line to invoke. */
export interface Config {
  rawInput?: string
}

/**
 * Record one step of the driver, when a log path is configured.
 * @param step - what happened.
 */
function note(step: string): void {
  const log = process.env.DSH_MEMORY_DRIVER_LOG
  if (log === undefined) return
  try {
    appendFileSync(log, `${step}\n`)
  } catch {
    // Diagnostics are best effort; a missing log never changes the run.
  }
}

/**
 * Invoke the configured Memory command once, after the Session has events.
 * @param ctx - context carrying the command service.
 * @param config - the command line to run.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const rawInput = config.rawInput ?? 'consolidate'
  note('applied')
  const done = new Set<string>()
  ctx.on('agent/status', ({ agent, status }) => {
    note(`status:${status}:seq=${String(agent.session.seq)}`)
    if (status !== 'idle') return
    // A fresh agent reaches idle once before any task is submitted, and that
    // window holds nothing. Drive only after the Session has events.
    if (agent.session.seq === 0) return
    const id = String(agent.session.id)
    if (done.has(id)) return
    done.add(id)
    const definition = ctx.commands.find(agent, 'memory')
    note(`find:${definition === undefined ? 'missing' : definition.name}`)
    note(`available:${ctx.commands.list(agent).map(command => command.name).join('|')}`)
    if (definition === undefined) return
    const running = Promise.resolve(definition.handler({ rawInput, agent } as never))
    // Queue the follow-up while the command's maintenance still holds the agent:
    // the wake then survives the command, and the next turn runs in this process.
    const followup = process.env.DSH_MEMORY_FOLLOWUP_TASK
    if (followup !== undefined && followup !== '') {
      note('followup')
      setTimeout(() => {
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: followup }],
          source: { kind: 'user' },
        }) as never)
      } catch (error: unknown) {
        note(`followup-failed:${String(error)}`)
      }
      }, 0)
    }
    void running
      .then(result => { note(`handled:${String(result?.kind)}:${String(result?.text).slice(0, 300)}`) })
      .catch((error: unknown) => { note(`handler-failed:${String(error)}`) })
  })
}
