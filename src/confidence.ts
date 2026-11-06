/**
 * The confidence a record is created with.
 *
 * Confidence answers "how reliable was this fact when it was written", not
 * "how much should we trust it now" — that second question is the score in
 * `priority.ts`, which moves with time and confirmed use.
 *
 * Two dimensions, weighted: whether the write carries checkable evidence, and
 * how strongly the trajectory asserts the fact. The model supplies the assertion
 * label; the plugin computes the rest, so two runs over the same trajectory and
 * the same labels produce the same number.
 *
 * @module dsh-reflection/confidence
 */

import type { EvidenceEntry } from './types/memory.js'

/** Assertion labels a writer may attach to a fact. */
export const ASSERTION_LABELS = Object.freeze(['stated', 'implied', 'mentioned', 'synthesized'])

/** Weight of the evidence dimension. */
export const EVIDENCE_WEIGHT = 0.6

/** Weight of the assertion dimension. */
export const ASSERTION_WEIGHT = 0.4

/**
 * Highest confidence any writer may store.
 *
 * No record claims absolute certainty: a later trajectory can always contradict
 * it, and the score is the mechanism that reflects that.
 */
export const MAX_WRITE_CONFIDENCE = 0.99

/**
 * Score one assertion label.
 * @param label - the label the model supplied; an unknown or missing label reads as `implied`.
 * @returns a value in [0, 1].
 */
export function assertionScore(label: unknown): number {
  switch (label) {
    // The trajectory says the fact outright.
    case 'stated': return 1
    // The fact follows from what the trajectory shows, but nobody said it.
    case 'implied': return 0.6
    // Something related was mentioned; the fact itself is a reading of it.
    case 'mentioned': return 0.3
    // A summary over other records, not a statement in the trajectory.
    case 'synthesized': return 0.4
    default: return 0.6
  }
}

/**
 * Score the evidence a write carries.
 *
 * A citation that names the events and quotes the exact text is checkable; one
 * with only a session id is a claim. Derived records cite other records, which is
 * weaker than a trajectory span.
 * @param input - the evidence entries and derived sources, when the write has them.
 * @returns a value in (0, 1].
 */
export function evidenceScore(input: {
  evidence?: readonly EvidenceEntry[] | undefined
  derivedFrom?: readonly unknown[] | undefined
}): number {
  const entries = input.evidence ?? []
  let best = 0
  for (const entry of entries) {
    const quoted = typeof entry.quote === 'string' && entry.quote.trim() !== ''
    const cited = Array.isArray(entry.event_seqs) && entry.event_seqs.length > 0
    const score = quoted && cited ? 1 : quoted ? 0.7 : cited ? 0.6 : 0.3
    best = Math.max(best, score)
  }
  if (best === 0 && (input.derivedFrom?.length ?? 0) > 0) best = 0.6
  return best === 0 ? 0.3 : best
}

/**
 * Compute the confidence a record is created with.
 * @param input - the write's evidence, derived sources, and assertion label.
 * @returns a value in [0, 0.99].
 */
export function initialConfidence(input: {
  evidence?: readonly EvidenceEntry[] | undefined
  derivedFrom?: readonly unknown[] | undefined
  assertion?: unknown
}): number {
  const evidence = evidenceScore(input)
  const assertion = assertionScore(input.assertion)
  return Math.min(MAX_WRITE_CONFIDENCE, EVIDENCE_WEIGHT * evidence + ASSERTION_WEIGHT * assertion)
}
