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


/** Context contribution name, unique across the harness. */
export const REPLAY_NAME = 'memory:replay'

/**
 * Position among runtime contexts.
 *
 * Immediately after the Memory index, so the two read as one block: what Memory
 * holds, then the rules that were just re-delivered.
 */
export const REPLAY_ORDER = 131

/** Header line that names why the context is repeated. */
export const REPLAY_HEADING = 'History was compacted. This context still applies:'

/** Line introducing replayed workspace instructions. */
export const REPLAY_INSTRUCTION_LEAD = 'Workspace instructions still apply:'

/** Line introducing a replayed skill catalog. */
export const REPLAY_CATALOG_LEAD = 'The skill catalog for this session is still current:'

/**
 * Digest one catalog publication the way its publisher does: over the entry list,
 * not over the rendered prose, because the framing is written for the model and
 * must not decide whether a republish is needed.
 * @param entries - the catalog entries one publication carried.
 * @returns a stable digest of the entries.
 */
function digestEntries(entries: readonly { readonly name?: string; readonly description?: string }[]): string {
  return entries.map(entry => JSON.stringify([entry.name ?? '', entry.description ?? ''])).join('\n')
}

/**
 * Compose the pending replay body, or the empty string when nothing is pending.
 * @param instructions - queued instruction copies, newest per scope.
 * @param catalog - the queued catalog copy, when one was queued.
 * @returns the body text, without any byte trimming.
 */
function composeBody(instructions: readonly InstructionCopy[], catalog: CatalogCopy | undefined): string {
  const sections: string[] = []
  if (instructions.length > 0) {
    sections.push(REPLAY_INSTRUCTION_LEAD)
    for (const copy of instructions) sections.push('', copy.text)
  }
  if (catalog !== undefined) sections.push('', REPLAY_CATALOG_LEAD, '', catalog.text)
  return sections.join('\n')
}

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

/** One skill-catalog publication observed on the event feed. */
export interface CatalogCopy {
  /** Sequence number of the message that carried it. */
  seq: number
  /** Digest over the published entries, which is what a republish changes. */
  digest: string
  /** How many entries the catalog carried. */
  count: number
  /** Catalog text, as the publisher rendered it. */
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
      readonly entries?: readonly { readonly name?: string; readonly description?: string }[]
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
  /** UTF-8 bytes the replay will add, heading and leads included. */
  bytes: number
  /** Present when a skill catalog was queued, describing what it carried. */
  catalog?: { count: number; digest: string; bytes: number } | undefined
}

/** The workspace-instruction replay slot. */
export interface InstructionReplay {
  /**
   * Observe one Session event.
   * @returns the replay this event queued, or null when it queued nothing.
   */
  observe(sessionId: string, event: unknown): ReplayDecision | null
  /** Render the pending replay for one Session, or the empty string. */
  body(sessionId: string, budgetBytes: number): string
  /** Drop the pending replay, once the model has answered with it in view. */
  clear(sessionId: string): void
}

/**
 * Create the replay slot.
 * @returns a slot that keeps at most one pending replay per Session.
 */
export function createInstructionReplay(): InstructionReplay {
  const copies = new Map<string, Map<string, InstructionCopy>>()
  const catalogs = new Map<string, CatalogCopy>()
  const pending = new Map<string, { instructions: InstructionCopy[]; catalog?: CatalogCopy | undefined; fingerprint: string }>()

  return {
    observe(sessionId, event) {
      const observed = event as ObservedEvent
      const kind = observed.data?.source?.kind
      const seq = typeof observed.seq === 'number' ? observed.seq : -1
      if (observed.type === 'user/message' && kind === 'agent-instructions') {
        const text = messageText(observed)
        if (text === '') return null
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
      if (observed.type === 'user/message' && kind === 'skill-catalog') {
        const text = messageText(observed)
        if (text === '') return null
        const entries = observed.data?.source?.entries ?? []
        catalogs.set(sessionId, { seq, digest: digestEntries(entries), count: entries.length, text })
        return null
      }

      if (observed.type !== 'compaction/summary') return null
      const range = observed.data?.shadowedRange
      const start = range?.start
      const end = range?.end
      if (typeof start !== 'number' || typeof end !== 'number') return null
      const inside = (copySeq: number): boolean => copySeq >= start && copySeq <= end
      const byScope = copies.get(sessionId)
      // The retained tail may still hold the newest copy; only a copy the
      // compaction actually consumed is worth repeating.
      const lost = (byScope === undefined ? [] : [...byScope.values()].filter(copy => inside(copy.seq)))
        .sort((left, right) => right.seq - left.seq)
      const newest = lost[0]
      const catalog = catalogs.get(sessionId)
      const lostCatalog = catalog !== undefined && inside(catalog.seq) ? catalog : undefined
      if (newest === undefined && lostCatalog === undefined) return null
      const instructions = newest === undefined ? [] : [newest]
      const fingerprint = `${newest?.digest ?? ''}|${newest?.seq ?? ''}|${lostCatalog?.digest ?? ''}`
      const current = pending.get(sessionId)
      if (current !== undefined && current.fingerprint === fingerprint) return null
      pending.set(sessionId, { instructions, catalog: lostCatalog, fingerprint })
      return {
        scope: newest?.scope ?? 'skill-catalog',
        seq: newest?.seq ?? lostCatalog?.seq ?? seq,
        digest: newest?.digest ?? lostCatalog?.digest,
        bytes: Buffer.byteLength(REPLAY_HEADING + '\n' + composeBody(instructions, lostCatalog), 'utf8'),
        ...lostCatalog === undefined ? {} : {
          catalog: {
            count: lostCatalog.count,
            digest: lostCatalog.digest,
            bytes: Buffer.byteLength(lostCatalog.text, 'utf8'),
          },
        },
      }
    },
    body(sessionId, budgetBytes) {
      const entry = pending.get(sessionId)
      if (entry === undefined) return ''
      return trimToBytes(`${REPLAY_HEADING}\n${composeBody(entry.instructions, entry.catalog)}`, budgetBytes)
    },
    clear(sessionId) {
      pending.delete(sessionId)
    },
  }
}
