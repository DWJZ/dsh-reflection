/**
 * One model call, and the two callers that make it.
 *
 * Both consolidation and the Memory summary ask the Session's own model a
 * question and read back text. The route — whatever provider and model the
 * conversation is already using — is reused rather than named in configuration:
 * a call that reads a trajectory the same model produced, or summarizes the
 * Memory that model will see, needs no second opinion and no second credential.
 *
 * `purpose` is deliberately not passed: its type is a closed set of the harness's
 * own special call sites, and these are ordinary calls.
 *
 * Usage: `const answer = await callConsolidator(ctx, request)`, or
 * `await streamModelText(ctx, { … })` directly.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CONSOLIDATION_SYSTEM_PROMPT, buildRequest } from './policy.js'
import { failureCode, failureMessage } from '../errors.js'

/** The terminal reason a stream reports, as far as this call reads it. */
interface StreamFinish {
  readonly kind: string
  readonly failure?: { readonly code?: string; readonly message?: string } | undefined
}

/** The route a Session resolved, which the call reuses. */
interface SessionRoute {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/**
 * What the Session must offer: its resolved route.
 *
 * `requestHeader` is called unconditionally, not probed: a Session that has not
 * started yet raises its own error from that call, and replacing it with this
 * plugin's "no route" message would hide why the call could not be made.
 */
export interface ConsolidationSession {
  requestHeader(): { readonly config?: SessionRoute | undefined } | undefined
}

/** The tokens one call spent, as the provider reported them. */
export interface ConsolidationUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number | undefined
}

/** What a call produced: the answer, what it cost, and which route answered. */
export interface ModelTextAnswer {
  text: string
  usage?: ConsolidationUsage | undefined
  provider: string
  model: string
}

/** One plain text call. */
export interface ModelTextRequest {
  /** The Session whose route is reused, when the caller has one. */
  session?: ConsolidationSession | undefined
  /** Its id, stamped onto the call so the adapter can attribute it. */
  sessionId: string
  /** The system instruction. */
  system: string
  /** The user message. */
  prompt: string
  /** Largest answer to accept; omitted leaves the provider's own limit. */
  maxTokens?: number | undefined
  /** Cancellation from the caller. */
  signal?: AbortSignal | undefined
  /** Source kind recorded on the message, and the name used in failure messages. */
  label: string
}

/** What one consolidation call produced: the answer, and what it cost. */
export interface ConsolidationAnswer {
  text: string
  usage?: ConsolidationUsage | undefined
}

/** One request to the consolidation model. */
export interface ConsolidationRequest {
  /**
   * The Session being consolidated, when the caller has one. An absent Session
   * and a Session without a resolved route both end as "no resolved model route",
   * which is why the lookup short-circuits here rather than throwing.
   */
  session?: ConsolidationSession | undefined
  /** Its id, stamped onto the call so the adapter can attribute it. */
  sessionId: string
  /** First seq in the window. */
  fromSeq: number
  /** Last seq in the window. */
  toSeq: number
  /** The normalized trajectory, as `batchWindow` produced it. */
  entries: readonly unknown[]
  /** Active Memory the model may target. */
  existing: readonly unknown[]
  /** An extra instruction appended to the call, used for a corrective retry. */
  note?: string | undefined
  /** Cancellation from the maintenance task. */
  signal?: AbortSignal | undefined
}

/**
 * Ask one model for plain text and read the stream to its terminal reason.
 *
 * Streaming is consumed rather than collected through a helper: this plugin
 * carries no harness dependency at runtime, so it reads the chunk sequence the
 * adapter produces and keeps the text.
 * @param ctx - Cordis context carrying `llm`.
 * @param request - the call description.
 * @returns the answer text, its usage, and the route that answered.
 * @throws when the route is unknown, the call fails, or it produces no text.
 */
export async function streamModelText(ctx: Context, request: ModelTextRequest): Promise<ModelTextAnswer> {
  const route = request.session?.requestHeader()?.config
  const provider = route?.provider
  const model = route?.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error(`dsh-reflection: this Session has no resolved model route for the ${request.label} call`)
  }

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: request.prompt }],
    source: { kind: `dsh-reflection-${request.label}` },
  }

  let text = ''
  let reason: StreamFinish | undefined
  let usage: ConsolidationUsage | undefined
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    system: request.system,
    messages: [userMessage],
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
    sessionId: request.sessionId,
    signal: request.signal,
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    // Adapters emit usage before the terminal finish; a provider that reports none
    // leaves it absent, which the audit records as "not reported" rather than zero.
    if (chunk.type === 'usage' && chunk.usage !== undefined) {
      usage = {
        inputTokens: chunk.usage.inputTokens,
        outputTokens: chunk.usage.outputTokens,
        totalTokens: chunk.usage.totalTokens,
      }
    }
    if (chunk.type === 'finish') reason = chunk.reason
  }
  // A stream can end having already produced parseable JSON and still not have
  // succeeded: a provider failure is normalized into a terminal `error` or
  // `aborted` finish, and a truncated answer arrives as `max-tokens`. Reading the
  // text without the reason would accept an answer the model never finished making.
  if (reason === undefined) throw new Error(`dsh-reflection: the ${request.label} call ended without a finish reason`)
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    const failure = reason.failure
    throw new Error(`dsh-reflection: the ${request.label} call ended as ${reason.kind}: ${failureCode(failure) ?? 'unknown'}: ${failureMessage(failure)}`)
  }
  // Neither caller declares tools, so `tool-calls` is as unfinished as a
  // truncation. The reason map is merge-extensible, so anything not named here
  // fails the call rather than being treated as success by default.
  if (reason.kind !== 'stop') {
    throw new Error(`dsh-reflection: the ${request.label} call ended as ${String(reason.kind)}, which is not a completed answer`)
  }
  if (text.trim() === '') throw new Error(`dsh-reflection: the ${request.label} model produced no text`)
  return { text, usage, provider, model }
}

/**
 * Ask the model for one operation plan.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param request - the consolidation request.
 * @returns the model's answer text.
 * @throws when the route is unknown, the call fails, or it produces no text.
 */
export async function callConsolidator(ctx: Context, request: ConsolidationRequest): Promise<ConsolidationAnswer> {
  const answer = await streamModelText(ctx, {
    ...request.session === undefined ? {} : { session: request.session },
    sessionId: request.sessionId,
    system: CONSOLIDATION_SYSTEM_PROMPT,
    prompt: buildRequest(request),
    ...request.signal === undefined ? {} : { signal: request.signal },
    label: 'consolidation',
  })
  return {
    text: answer.text,
    ...answer.usage === undefined ? {} : { usage: answer.usage },
  }
}
