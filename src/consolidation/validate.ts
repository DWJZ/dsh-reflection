/**
 * Decide which proposed operations may be committed.
 *
 * The model proposes; this module decides. Two kinds of problem are treated
 * differently, on purpose:
 *
 * - A plan that cannot be read at all fails the batch. Nothing is committed and
 *   the mark stays where it was, so the same window is retried.
 * - An operation that cannot be justified is dropped, with the reason recorded,
 *   while the rest of the plan proceeds and the window is consumed. One
 *   hallucinated sequence number should not force the trajectory to be
 *   re-read and re-judged from scratch, and the operations around it were
 *   judged against the same trajectory.
 *
 * Evidence is built here, never accepted. The model names sequence numbers; this
 * module checks that each one exists, lies inside the window, was actually shown
 * to the model, and is neither ignorable nor one of this plugin's own events —
 * then constructs the provenance itself.
 *
 * Usage: `import { reviewPlan } from './validate.js'`.
 */

import { MAX_CONTENT_CHARS, charLength } from '../schema.js'
import { findSecretIn, redactText } from '../redact.js'
import type { AddOperation, AutoOperation, EvidenceEntry, MemoryRecord, MemoryScope, TargetedOperation } from '../types/memory.js'
import type { ObservedEvent } from '../types/trajectory.js'

/** Actions automatic consolidation may take. */
export const AUTO_ACTIONS = Object.freeze(['add', 'update', 'supersede', 'noop'])

/** Actions the model may not take automatically, named so a refusal can say why. */
export const FORBIDDEN_ACTIONS = Object.freeze(['forget', 'clear', 'delete', 'archive'])

/** Scopes an operation may write to. */
export const WRITE_SCOPES = Object.freeze(['user', 'project'])

/**
 * Review one plan against the window it came from.
 *
 * @param plan - the parsed plan.
 * @param {object} context - what the plan is judged against.
 * @param context.fromSeq - first seq in the consolidation window.
 * @param context.toSeq - last seq in the window.
 * @param context.visibleSeqs - seqs the model was actually shown.
 * @param context.eventsBySeq - the events behind those seqs, for evidence.
 * @param context.existing - active Memory the model may target.
 * @param context.projectId - the current project, or null.
 * @param context.sessionId - the Session being consolidated.
 * @param context.quoteMaxChars - largest stored quote, in code points.
 * @param context.maxEvidencePerMemory - largest accepted evidence list.
 * @param context.now - clock, injectable for tests.
 * @returns the accepted operations and, for each dropped one, why.
 */
/** What one review is given: the window, what the model was shown, and the settings. */
export interface ReviewContext {
  sessionId: string
  projectId: string | null | undefined
  fromSeq: number
  toSeq: number
  visibleSeqs: Set<number>
  eventsBySeq: Map<number, ObservedEvent>
  existing: MemoryRecord[]
  content?: string | undefined
  maxEvidencePerMemory: number
  quoteMaxChars: number
  now(): number
}

/**
 * An operation the review accepted.
 *
 * It is what Phase 1 would write, plus the target the review resolved: a proposal
 * names a target only for `update` and `supersede`, and the dry-run report shows it.
 */
/** An operation the review accepted for a new fact. */
export interface ReviewedAdd extends AddOperation {
  /** The confidence the review assigned. */
  confidence: number
  /** The citation the review resolved and screened. */
  evidence: EvidenceEntry
}

/** An operation the review accepted for an existing record. */
export interface ReviewedTargeted extends TargetedOperation {
  /** The record being rewritten or retired. */
  target_id: string
  /** The confidence the review assigned. */
  confidence: number
  /** The citation the review resolved and screened. */
  evidence: EvidenceEntry
}

/** An operation the review accepted: the fact to store, or the record to rewrite. */
export type ReviewedOperation = ReviewedAdd | ReviewedTargeted

/** What reviewing one proposal produced. */
export type ReviewOutcome =
  | { kind: 'accepted'; operation: ReviewedOperation }
  | { kind: 'noop'; reason: string }
  | { kind: 'rejected'; reason: string; code: string }

/**
 * View a model-supplied value as a record of unknowns.
 * @param value - the value the model returned.
 * @returns the record, or undefined when it is not one.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function reviewPlan(plan: { operations?: unknown[] } | null | undefined, context: ReviewContext) {
  if (!Array.isArray(plan?.operations)) {
    throw new TypeError('dsh-reflection: a consolidation plan must carry an operations array')
  }
  const accepted = []
  const rejected = []
  const noopReasons = []
  for (const [index, operation] of plan.operations.entries()) {
    const review = reviewOperation(operation, context)
    if (review.kind === 'noop') {
      noopReasons.push(review.reason)
      continue
    }
    if (review.kind === 'rejected') {
      const proposal = asRecord(operation)
      const action = proposal !== undefined && typeof proposal.action === 'string' ? proposal.action : undefined
      const scope = proposal !== undefined && typeof proposal.scope === 'string' ? proposal.scope : undefined
      const content = proposal !== undefined && typeof proposal.content === 'string' ? proposal.content.trim() : undefined
      rejected.push({
        index,
        code: review.code ?? 'other',
        reason: review.reason,
        ...action === undefined ? {} : { action },
        ...scope === undefined ? {} : { scope },
        ...content === undefined ? {} : { content_length: charLength(content) },
      })
      continue
    }
    accepted.push(review.operation)
  }
  return { accepted, rejected, noopReasons }
}

/**
 * Review one proposed operation.
 *
 * @param operation - the proposal.
 * @param context - the judging context.
 * @returns `{ kind: 'accepted', operation }`, `{ kind: 'noop', reason }`, or
 *   `{ kind: 'rejected', reason }`.
 */
export function reviewOperation(operation: unknown, context: ReviewContext): ReviewOutcome {
  const proposal = asRecord(operation)
  if (proposal === undefined) {
    return { kind: 'rejected', reason: 'operation is not an object', code: 'not-an-object' }
  }
  const action = String(proposal.action ?? '')
  if (action === 'noop') {
    return { kind: 'noop', reason: typeof proposal.reason === 'string' ? proposal.reason : 'no reason given' }
  }
  if (!AUTO_ACTIONS.includes(action)) {
    return { kind: 'rejected', code: FORBIDDEN_ACTIONS.includes(action) ? 'action-forbidden' : 'unknown-action', reason: FORBIDDEN_ACTIONS.includes(action)
      ? `"${action}" is not an automatic action`
      : `unknown action "${action}"` }
  }

  const content = typeof proposal.content === 'string' ? proposal.content.trim() : ''
  if (content === '') return { kind: 'rejected', reason: 'content is empty', code: 'empty-content' }
  if (charLength(content) > MAX_CONTENT_CHARS) {
    return { kind: 'rejected', reason: `content is longer than ${String(MAX_CONTENT_CHARS)} characters`, code: 'content-too-long' }
  }
  if (/[\n\r\u2028\u2029]/u.test(content)) return { kind: 'rejected', reason: 'content is not a single line', code: 'content-not-single-line' }

  const title = typeof proposal.title === 'string' ? proposal.title.trim() : ''
  if (title === '') return { kind: 'rejected', reason: 'title is missing', code: 'title-missing' }
  if (/[\n\r\u2028\u2029]/u.test(title)) return { kind: 'rejected', reason: 'title is not a single line', code: 'title-not-single-line' }

  const confidence = proposal.confidence
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { kind: 'rejected', reason: 'confidence must be a number in [0, 1]', code: 'confidence-not-a-number' }
  }
  const target = action === 'add' ? undefined : findTarget(proposal.target_id, context)
  if (action !== 'add' && target === undefined) {
    return { kind: 'rejected', reason: `target_id ${JSON.stringify(proposal.target_id ?? null)} is not an active Memory this Session can see`, code: 'target-not-visible' }
  }
  if (target !== undefined && confidence < (target.confidence ?? 1)) {
    // A rewrite retires the target. Replacing a more confident fact with a less
    // confident one is the one confidence gate left: adds have no such collateral.
    return { kind: 'rejected', reason: `confidence ${String(confidence)} is below the target's ${String(target.confidence ?? 1)}`, code: 'confidence-below-target' }
  }

  // `update` and `supersede` take their scope and category from the record they
  // act on, so a proposal cannot move a fact to another project by restating it.
  const scope = target?.scope ?? proposal.scope
  if (typeof scope !== 'string' || !WRITE_SCOPES.includes(scope)) return { kind: 'rejected', reason: `unknown scope ${JSON.stringify(scope ?? null)}`, code: 'unknown-scope' }
  if (scope === 'project' && (context.projectId === undefined || context.projectId === null)) {
    return { kind: 'rejected', reason: 'project-scope Memory needs a resolved project for this Session', code: 'no-resolved-project' }
  }

  const evidence = buildEvidence(proposal.evidence_event_seqs, { ...context, content })
  if (evidence.kind === 'rejected') return evidence

  const shared = {
    scope: scope as MemoryScope,
    title,
    content,
    confidence,
    projectId: scope === 'project' ? (target?.project_id ?? context.projectId) : undefined,
    evidence: evidence.entry,
  }
  if (action === 'add') return { kind: 'accepted', operation: { action: 'add', ...shared } }
  // The guard above refused every non-add action without a visible target.
  return {
    kind: 'accepted',
    operation: { action: action as 'update' | 'supersede', target_id: target?.id ?? '', ...shared },
  }
}

/**
 * Find the active Memory one operation targets.
 * @param targetId - the proposed target id.
 * @param context - the judging context.
 * @returns the record, or undefined when it is not visible and active.
 */
function findTarget(targetId: unknown, context: ReviewContext) {
  if (typeof targetId !== 'string' || targetId === '') return undefined
  return context.existing.find((record: MemoryRecord) => record.id === targetId && record.status === 'active')
}

/**
 * Verify the cited sequence numbers and build the provenance to persist.
 *
 * Every citation is checked against what the model was actually shown: a
 * sequence number it invented, one from outside the window, one belonging to an
 * event it never saw, or one from an ignorable or internal event is refused
 * rather than stored. The quote is taken from the cited events by this plugin,
 * and is screened for secrets before it can be persisted.
 * @param seqs - the proposed citations.
 * @param context - the judging context, plus the content being stored.
 * @returns `{ kind: 'accepted', entry }` or `{ kind: 'rejected', reason }`.
 */
function buildEvidence(
  seqs: unknown,
  context: ReviewContext,
): { kind: 'rejected'; reason: string; code: string } | {
  kind: 'accepted'
  entry: { kind: string; session_id: string; event_seqs: number[]; quote: string; observed_at: string }
} {
  if (!Array.isArray(seqs) || seqs.length === 0) {
    return { kind: 'rejected', reason: 'evidence_event_seqs must be a non-empty array', code: 'evidence-missing' }
  }
  if (seqs.some(seq => !Number.isInteger(seq))) {
    return { kind: 'rejected', reason: 'evidence_event_seqs must contain integers', code: 'evidence-not-integers' }
  }
  const unique = [...new Set(seqs)].sort((left, right) => left - right)
  for (const seq of unique) {
    if (seq < context.fromSeq || seq > context.toSeq) {
      return { kind: 'rejected', reason: `evidence seq ${String(seq)} is outside the window`, code: 'evidence-outside-window' }
    }
    if (!context.visibleSeqs.has(seq)) {
      return { kind: 'rejected', reason: `evidence seq ${String(seq)} was not shown to the model`, code: 'evidence-not-shown' }
    }
  }
  const cited = unique.map(seq => context.eventsBySeq.get(seq)).filter(Boolean)
  if (cited.length !== unique.length) {
    return { kind: 'rejected', reason: 'an evidence seq has no event behind it', code: 'evidence-missing-event' }
  }
  // The quote is a truncation of the cited text. Redacting the complete text and
  // quoting from the result is what keeps a credential that straddles the cut
  // from surviving as a fragment no detector recognizes. What is stored is
  // therefore a faithful quote of the redacted text, not byte-for-byte the
  // Session's own words.
  const sources = cited.flatMap(event => textBlocks(event)).map((text: string) => redactText(text))
  const quote = quoteFrom(sources, context.quoteMaxChars)
  if (quote === undefined) {
    return { kind: 'rejected', reason: 'the cited events carry no text to quote', code: 'no-quotable-text' }
  }
  const secret = findSecretIn([context.content, ...sources, quote])
  if (secret !== undefined) {
    return { kind: 'rejected', code: 'secret-detected', reason: `secret-detected: ${secret.name}` }
  }
  return {
    kind: 'accepted',
    entry: {
      kind: evidenceKind(cited),
      session_id: context.sessionId,
      event_seqs: unique,
      quote,
      observed_at: new Date(context.now()).toISOString(),
    },
  }
}

/**
 * Choose the provenance kind that best describes the cited events.
 *
 * A human statement outranks a tool result, and a tool result outranks the
 * assistant's own summary, because the reader of a Memory wants to know how
 * directly a person or a command grounded it.
 * @param cited - the cited events.
 * @returns `user`, `tool`, or `agent`.
 */
function evidenceKind(cited: readonly (ObservedEvent | undefined)[]): string {
  if (cited.some(event => event?.type === 'user/message' && event?.data?.source?.kind === 'user')) return 'user'
  if (cited.some(event => event?.type === 'tool/result' || event?.type === 'tool/call')) return 'tool'
  return 'agent'
}

/**
 * Take the persisted quote from the cited text.
 * @param texts - the cited text blocks, in seq order.
 * @param maxChars - largest quote, in code points.
 * @returns the quote, or undefined when there was no text.
 */
function quoteFrom(texts: string[], maxChars: number): string | undefined {
  const joined = texts.join('\n').trim()
  if (joined === '') return undefined
  const points = Array.from(joined)
  return points.length <= maxChars ? joined : `${points.slice(0, maxChars).join('')}…`
}

/**
 * Every text block one event carries.
 * @param event - a Session event.
 * @returns its text blocks, in order.
 */
function textBlocks(event: ObservedEvent | undefined) {
  const blocks = event?.data?.content ?? event?.data?.message?.content
  if (!Array.isArray(blocks)) return []
  return blocks.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text)
}

/** One feedback verdict the review accepted. */
export interface ReviewedFeedback {
  target_id: string
  verdict: 'confirmed' | 'corrected' | 'neutral'
}

/**
 * Review the model's feedback on records found in the window.
 * @param feedback - the raw `feedback` array from the plan.
 * @param accessed - records referenced in the window, with their ids.
 * @returns accepted verdicts and rejected entries.
 */
export function reviewFeedback(
  feedback: unknown,
  accessed: readonly { id: string }[],
): { accepted: ReviewedFeedback[]; rejected: { reason: string }[] } {
  if (!Array.isArray(feedback) || feedback.length === 0) return { accepted: [], rejected: [] }
  const allowed = new Set(accessed.map(record => record.id))
  const accepted: ReviewedFeedback[] = []
  const rejected: { reason: string }[] = []
  const seen = new Set<string>()
  for (const entry of feedback) {
    const proposal = asRecord(entry)
    if (proposal === undefined) { rejected.push({ reason: 'feedback is not an object' }); continue }
    const targetId = typeof proposal.target_id === 'string' ? proposal.target_id : ''
    const verdict = proposal.verdict
    if (targetId === '' || !allowed.has(targetId)) { rejected.push({ reason: 'feedback target was not found in this window' }); continue }
    if (verdict !== 'confirmed' && verdict !== 'corrected' && verdict !== 'neutral') {
      rejected.push({ reason: 'unknown feedback verdict' })
      continue
    }
    if (seen.has(targetId)) { rejected.push({ reason: 'duplicate feedback target' }); continue }
    seen.add(targetId)
    accepted.push({ target_id: targetId, verdict })
  }
  return { accepted, rejected }
}
