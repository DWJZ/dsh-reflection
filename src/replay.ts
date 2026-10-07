/**
 * Workspace-instruction replay after a compaction.
 *
 * The `agent-instructions` layer publishes workspace instructions as ordinary
 * `user/message` entries, so they live in history: a compaction folds the older
 * copies into its summary, and the model keeps only whichever copy the retained
 * tail happens to hold. Memory and the skill catalog do not have this problem —
 * they are runtime contexts rebuilt for every request — so this module exists for
 * the instruction channel alone.
 *
 * The replay is a runtime context, which means its text is assembled per request.
 * Rendering must therefore stay pure: the slot is filled when a compaction that
 * consumed the newest instruction copy is observed, and cleared once the model has
 * answered, not from inside the renderer.
 *
 * @module dsh-reflection/replay
 */

import type { Context } from '@deepseek-ai/cordis'

/** Context contribution name, unique across the harness. */
export const REPLAY_NAME = 'memory:replay'

/**
 * Position among runtime contexts.
 *
 * Immediately after the Memory index, so the two read as one block: what Memory
 * holds, then the rules that were just re-delivered.
 */
export const REPLAY_ORDER = 131

/** Header line that names why the instructions are repeated. */
export const REPLAY_HEADING = 'History was compacted. These workspace instructions still apply:'

/**
 * Trim text to a UTF-8 byte budget.
 *
 * `truncateChars` counts code points, which is the wrong unit for a context
 * budget: one CJK character costs three bytes, so a code-point cap can overshoot
 * the byte budget threefold.
 * @param text - the text to trim.
 * @param limit - maximum UTF-8 bytes to keep.
 * @returns the longest prefix that fits.
 */
function trimToBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  let used = 0
  let kept = ''
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > limit) break
    used += size
    kept += character
  }
  return kept
}

/** One instruction publication observed on the event feed. */
export interface InstructionCopy {
  /** Scope key the publisher used, `<directory>\0<file name>`. */
  scope: string
  /** Sequence number of the message that carried it. */
  seq: number
  /** Publisher-supplied content digest, when it published one. */
  digest?: string | undefined
  /** Instruction text, as the publisher sent it. */
  text: string
}

/** What a replay needs from one event, structurally narrowed at this boundary. */
interface ObservedEvent {
  readonly type?: string
  readonly seq?: number
  readonly data?: {
    readonly source?: {
      readonly kind?: string
      readonly changes?: readonly { readonly scope?: string; readonly path?: string; readonly digest?: string }[]
    }
    readonly shadowedRange?: { readonly start?: number; readonly end?: number }
    readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  }
}

/** Extract the plain-text body of one observed message. */
function messageText(event: ObservedEvent): string {
  const parts = event.data?.content ?? []
  return parts
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
}

/** The scopes one instruction publication claims, or an empty list. */
function publishedScopes(event: ObservedEvent): { scope: string; digest?: string | undefined }[] {
  const changes = event.data?.source?.changes
  if (Array.isArray(changes)) {
    return changes
      .filter(change => typeof change?.scope === 'string' && change.scope !== '')
      .map(change => ({
        scope: change.scope as string,
        digest: typeof change.digest === 'string' ? change.digest : undefined,
      }))
  }
  // A baseline publication carries `baselineIdentity` instead of per-file changes;
  // its scope is the workspace root, which is what the empty directory means.
  const source = event.data?.source
  if (source?.kind === 'agent-instructions' && (source as { baseline?: unknown }).baseline === true) {
    return [{ scope: '', digest: undefined }]
  }
  return []
}

/** One replay the slot queued, which the caller may record. */
export interface ReplayDecision {
  /** Scope the replayed copy came from, `<directory>\0<file name>`. */
  scope: string
  /** Sequence number of the message that carried it. */
  seq: number
  /** Content digest the publisher supplied, when it supplied one. */
  digest?: string | undefined
  /** UTF-8 bytes the replay will add, heading included. */
  bytes: number
}

/** The workspace-instruction replay slot. */
export interface InstructionReplay {
  /**
   * Observe one Session event.
   * @returns the replay this event queued, or null when it queued nothing.
   */
  observe(sessionId: string, event: unknown): ReplayDecision | null
  /** Render the pending replay for one agent, or the empty string. */
  render(agent: MemoryAgent, budgetBytes: number): string
  /** Drop the pending replay, once the model has answered with it in view. */
  clear(sessionId: string): void
}

/**
 * Create the replay slot.
 * @returns a slot that keeps at most one pending replay per Session.
 */
export function createInstructionReplay(): InstructionReplay {
  const copies = new Map<string, Map<string, InstructionCopy>>()
  const pending = new Map<string, { text: string; digest: string; scope: string }>()

  return {
    observe(sessionId, event) {
      const observed = event as ObservedEvent
      if (observed.type === 'user/message' && observed.data?.source?.kind === 'agent-instructions') {
        const text = messageText(observed)
        if (text === '') return null
        const seq = typeof observed.seq === 'number' ? observed.seq : -1
        const byScope = copies.get(sessionId) ?? new Map<string, InstructionCopy>()
        for (const { scope, digest } of publishedScopes(observed)) {
          // One scope holds one live version: the publisher replaces rather than
          // accumulates, so a replay of every observed copy would restore rules
          // that were already retired.
          byScope.set(scope, { scope, seq, digest, text })
        }
        copies.set(sessionId, byScope)
        return null
      }
      if (observed.type !== 'compaction/summary') return null
      const range = observed.data?.shadowedRange
      const start = range?.start
      const end = range?.end
      if (typeof start !== 'number' || typeof end !== 'number') return null
      const byScope = copies.get(sessionId)
      if (byScope === undefined) return null
      const lost = [...byScope.values()].filter(copy => copy.seq >= start && copy.seq <= end)
      if (lost.length === 0) return null
      // The retained tail may still hold the newest copy; only a copy the
      // compaction actually consumed is worth repeating.
      const newest = lost.sort((left, right) => right.seq - left.seq)[0]
      if (newest === undefined) return null
      const digest = newest.digest ?? String(newest.seq)
      const current = pending.get(sessionId)
      if (current !== undefined && current.digest === digest) return null
      pending.set(sessionId, { text: newest.text, digest, scope: newest.scope })
      return {
        scope: newest.scope,
        seq: newest.seq,
        digest: newest.digest,
        bytes: Buffer.byteLength(REPLAY_HEADING + '\n\n' + newest.text, 'utf8'),
      }
    },
    render(agent, budgetBytes) {
      const session = agent.session as { id?: unknown } | undefined
      const entry = typeof session?.id === 'string' ? pending.get(session.id) : undefined
      if (entry === undefined) return ''
      return trimToBytes(`${REPLAY_HEADING}\n\n${entry.text}`, budgetBytes)
    },
    clear(sessionId) {
      pending.delete(sessionId)
    },
  }
}

/**
 * Register the replay as a runtime context.
 * @param ctx - the injection scope that owns the runtime.
 * @param replay - the slot to render from.
 * @param budgetBytes - UTF-8 byte budget for one replay.
 * @returns the exact disposer that removes the contribution.
 */
export function registerInstructionReplay(
  ctx: Context,
  replay: InstructionReplay,
  budgetBytes: number,
): () => void {
  return ctx.systemPrompt.context({
    name: REPLAY_NAME,
    order: REPLAY_ORDER,
    text: (assembleContext: { agent?: MemoryAgent }) => {
      const agent = assembleContext.agent
      // A bare assemble (tests, diagnostics) has no session to describe.
      if (agent === undefined) return ''
      return replay.render(agent, budgetBytes)
    },
  })
}
