/**
 * What consolidation is told, and how its answer is read.
 *
 * The policy is deliberately biased toward silence. A Memory that is never
 * written costs nothing; a Memory that is wrong is injected into every later
 * Session and is believed. So the instruction is to prefer NOOP, and the bar
 * for a fact is that the trajectory grounds it — not that the model finds it
 * plausible.
 *
 * The model proposes operations and nothing else. It never supplies the
 * provenance that gets persisted: it names the sequence numbers it relied on,
 * and the plugin looks those up, verifies them, and builds the evidence itself.
 *
 * Usage: `import { buildRequest, parsePlan } from './policy.js'`.
 */

import type { ConsolidationRequest } from './model.js'
import { MEMORY_TITLE_RULE } from '../title.js'
import { MAX_CONTENT_CHARS } from '../schema.js'
import type { TrajectoryEntry } from '../types/trajectory.js'

/** The instruction that frames one consolidation call. */
export const CONSOLIDATION_SYSTEM_PROMPT = [
  'You maintain long-term Memory for one coding agent.',
  '',
  'You are given the new trajectory of a Session and the Memory that already exists.',
  'Your job is to decide what, if anything, from this trajectory should be remembered in future Sessions.',
  '',
  'Remember only information that is all of:',
  '- durable: still true and still useful in later Sessions',
  '- about the user or this project, rather than about the current task',
  '- grounded in what the trajectory shows, not inferred from what seems likely',
  '- not already represented by the existing Memory',
  '',
  'Never remember:',
  '- transient state: what is running now, what a command printed, what remains to do today',
  '- speculation, guesses, or anything the trajectory does not support',
  '- facts that only describe the task at hand',
  '- secrets, credentials, or tokens, in any form',
  '',
  'Prefer NOOP. Returning no operations is a good answer and the expected one for most trajectories.',
  'A missed Memory is a small loss. A wrong Memory is repeated in every later Session.',
  '',
  'Choose one action per operation:',
  '- "add" for durable information no existing Memory covers',
  '- "update" when an existing Memory stays true but should be refined; requires target_id',
  '- "supersede" when new information replaces an existing Memory; requires target_id',
  '- "noop" to record that nothing should change; may carry a short reason',
  '',
  'You may not delete, forget, clear, or archive anything.',
  'Use "user" scope for preferences and facts about the person; "project" scope for facts about this repository.',
  'Write each fact so a later Session can reuse it: when the trajectory shows a problem and how it was solved, record the reusable pattern (condition, problem, fix), not the play-by-play.',
  'Evidence must reference seq numbers that appear in the trajectory you were given.',
  '',
  'You may also return feedback on records that were found in this window.',
  'Use confirmed only when the trajectory clearly relied on, restated, or verified the record;',
  'use corrected when the user or the trajectory contradicted it; otherwise neutral.',
  'Feedback is only allowed for ids listed under "Records found in this window".',
  '',
  'Answer with one JSON object, and nothing else:',
  '{"operations":[{"action":"add","scope":"project","title":"The project uses pnpm for dependencies.","content":"The project uses pnpm.","confidence":0.94,"evidence_event_seqs":[190,198]}],"feedback":[{"target_id":"mem_...","verdict":"confirmed"}]}',
  'confidence is a number in [0,1] reflecting how well the trajectory grounds the fact.',
  'A rewrite must be at least as confident as the record it targets; a lower-confidence rewrite is rejected.',
  '',
  'Every add, update and supersede must include a one-line title:',
  MEMORY_TITLE_RULE,
  'A plan with an operation missing its title is invalid and will be sent back.',
  '',
  `Every add, update and supersede must keep content to one line of at most ${String(MAX_CONTENT_CHARS)} characters:`,
  '- a longer fact must be split into separate operations;',
  '- a plan with over-long content is sent back once, and a still-over-long plan is rejected.',
].join('\n')

/**
 * Render the trajectory and the existing Memory for one consolidation call.
 *
 * The trajectory is passed as JSON lines rather than prose so a remembered
 * sentence inside it stays data: an entry cannot be read as an instruction to
 * the consolidator any more than it can to the agent.
 * @param {object} request - what the call is about.
 * @param request.sessionId - the Session being consolidated.
 * @param request.fromSeq - first seq in the window.
 * @param request.toSeq - last seq in the window.
 * @param request.entries - the normalized trajectory entries.
 * @param request.existing - the active Memory the model may target.
 * @returns the user-role payload for the call.
 */
export function buildRequest(request: ConsolidationRequest): string {
  const parts = [
    'New trajectory since the last consolidation:',
    `session: ${request.sessionId}`,
    `seq range: ${String(request.fromSeq)}..${String(request.toSeq)}`,
    '',
    ...request.entries.map(entry => JSON.stringify(entry)),
    '',
    'Memory that already exists and may be targeted:',
    request.existing.length === 0 ? '(none)' : JSON.stringify(request.existing),
    '',
    'Records found in this window (feedback only for these):',
    request.accessed === undefined || request.accessed.length === 0 ? '(none)' : JSON.stringify(request.accessed),
    '',
    'Decide the operations for this trajectory.',
    ...request.note === undefined ? [] : ['', request.note],
  ]
  return parts.join('\n')
}

/**
 * Read the operation plan out of a model answer.
 *
 * The answer is expected to be one JSON object. Prose around it is tolerated
 * because models add it despite instructions, but nothing is guessed: if no
 * object can be parsed, the batch fails rather than being read as "no
 * operations", which would silently mark the window consumed.
 * @param text - the model's answer.
 * @returns the parsed plan.
 * @throws when no JSON object can be read.
 */
export function parsePlan(text: string) {
  const raw = String(text ?? '').trim()
  if (raw === '') throw new Error('dsh-reflection: the consolidation model returned nothing')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) {
    // The answer is not repeated: a model that answers in prose can restate the
    // trajectory, and this message reaches the plugin's log. Length, stage, and
    // completion are enough to diagnose it.
    throw new Error(`dsh-reflection: the consolidation model returned no JSON object (${String(raw.length)} characters of text)`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    // V8's parse error quotes the input it choked on, which is the model's text.
    // The length and the stage are what a diagnosis needs from here.
    throw new Error(`dsh-reflection: the consolidation model returned invalid JSON (${String(raw.length)} characters of text)`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('dsh-reflection: the consolidation plan must be a JSON object')
  }
  if (parsed.operations !== undefined && !Array.isArray(parsed.operations)) {
    throw new Error('dsh-reflection: the consolidation plan operations must be an array')
  }
  if (parsed.feedback !== undefined && !Array.isArray(parsed.feedback)) {
    throw new Error('dsh-reflection: the consolidation plan feedback must be an array')
  }
  return { operations: parsed.operations ?? [], feedback: parsed.feedback ?? [] }
}
