/**
 * The routes the Settings review page calls.
 *
 * Three exact routes under the Web host's own server, not the plugin's UI: the
 * page renders inside the Harness shell as a React component, so the browser and
 * the Host need one small channel to read the queue and act on it. The route set
 * is deliberately narrow — read, apply a selection, drop a selection — and every
 * request is checked to come from this machine on this origin before it may see
 * Memory content.
 *
 * The page is fed by request/response rather than by Session events because the
 * pending queue is global: it is written by the daily scan and is read by
 * whichever page is open, so it belongs to no Session and the Session log
 * deliberately carries no copy of the candidates.
 *
 * @module dsh-reflection/web
 */

import { failureMessage } from './errors.js'
import { applyReview, discardReview, readReviewState } from './digest/review.js'
import type { ReviewRequest } from './digest/review.js'
import type { MemoryDeps } from './types/deps.js'
import type { Context } from '@deepseek-ai/cordis'

/** Exact path the page reads the queue from. */
export const REVIEW_PATH = '/dsh-reflection/digest'

/** Exact path one apply is posted to. */
export const REVIEW_APPLY_PATH = '/dsh-reflection/digest/apply'

/** Exact path one discard is posted to. */
export const REVIEW_DISCARD_PATH = '/dsh-reflection/digest/discard'

/** Largest request body a review action may carry. */
const MAX_BODY_BYTES = 64 * 1024

/** What one mount needs from the plugin. */
export interface ReviewRoutesOptions {
  /** The wiring the queue, the registry and the switches live behind. */
  deps: MemoryDeps
  /**
   * The Session an apply borrows for its audit record and summary refresh.
   * Absent means the apply still writes Memory and skips the Session record.
   */
  agent(): MemoryAgent | undefined
}

/**
 * Register the review routes while the profile serves a browser.
 *
 * A profile without the Web host leaves the injection pending, so the plugin
 * keeps working headless and the page is simply unavailable there.
 * @param ctx - this plugin's context.
 * @param options - the wiring and the agent source.
 * @returns the fiber that owns the routes; disposing it removes them.
 */
export function mountReviewRoutes(ctx: Context, options: ReviewRoutesOptions): { dispose(): Promise<void> } {
  return ctx.inject(['webServer'], (scope) => {
    const serialize = createQueue()
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: REVIEW_PATH,
      handler: (request, response) => { readRoute(options, request, response) },
    }), 'dsh-reflection: digest review route')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: REVIEW_APPLY_PATH,
      handler: (request, response) => { void actionRoute(options, serialize, 'apply', request, response) },
    }), 'dsh-reflection: digest apply route')
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: REVIEW_DISCARD_PATH,
      handler: (request, response) => { void actionRoute(options, serialize, 'discard', request, response) },
    }), 'dsh-reflection: digest discard route')
  })
}

/**
 * Answer one read of the queue.
 * @param options - the wiring to read through.
 * @param request - the incoming request.
 * @param response - the response this handler owns.
 * @returns nothing.
 */
function readRoute(options: ReviewRoutesOptions, request: MemoryWebRequest, response: MemoryWebResponse): void {
  if (!sameOriginLoopback(request)) {
    sendText(response, 403, 'the digest queue is limited to same-origin loopback requests')
    return
  }
  if (request.method !== 'GET') {
    sendText(response, 405, 'this route answers GET only', { allow: 'GET' })
    return
  }
  try {
    sendJson(response, 200, { ok: true, state: readReviewState(options.deps) })
  } catch (failure) {
    sendJson(response, 500, { ok: false, code: 'failed', message: failureMessage(failure) })
  }
}

/**
 * Answer one apply or discard, serialized against the other actions.
 * @param options - the wiring to act through.
 * @param serialize - the queue that keeps one action from interleaving with another.
 * @param action - which action this route performs.
 * @param request - the incoming request.
 * @param response - the response this handler owns.
 * @returns fulfillment once the response is sent.
 */
async function actionRoute(
  options: ReviewRoutesOptions,
  serialize: <T>(work: () => Promise<T> | T) => Promise<T>,
  action: 'apply' | 'discard',
  request: MemoryWebRequest,
  response: MemoryWebResponse,
): Promise<void> {
  if (!sameOriginLoopback(request)) {
    sendText(response, 403, 'the digest queue is limited to same-origin loopback requests')
    return
  }
  if (request.method !== 'POST') {
    sendText(response, 405, 'this route answers POST only', { allow: 'POST' })
    return
  }
  const body = await readJsonBody(request)
  if (!body.ok) {
    sendJson(response, body.status, { ok: false, code: 'bad-request', message: body.message })
    return
  }
  const payload = body.value as ReviewRequest
  try {
    await serialize(async () => {
      if (action === 'apply') {
        const result = await applyReview(options.deps, options.agent(), payload)
        if (result.status === 'error') sendJson(response, failureStatus(result.code), { ok: false, code: result.code, message: result.message })
        else sendJson(response, 200, { ok: true, ...result })
        return
      }
      const result = discardReview(options.deps, payload)
      if (result.status === 'error') sendJson(response, failureStatus(result.code), { ok: false, code: result.code, message: result.message })
      else sendJson(response, 200, { ok: true, ...result })
    })
  } catch (failure) {
    sendJson(response, 500, { ok: false, code: 'failed', message: failureMessage(failure) })
  }
}

/**
 * Map one refused action onto the HTTP status the page reads.
 * @param code - the failed step.
 * @returns the status code.
 */
function failureStatus(code: string): number {
  switch (code) {
    case 'invalid-selection': return 400
    case 'disabled':
    case 'no-pending':
    case 'unreadable':
    case 'stale': return 409
    default: return 500
  }
}

/**
 * Whether a request came from this machine, same origin, with no proxy in front.
 *
 * This is the rule the other local plugins' control routes follow. The cookie
 * layer is not used here on purpose: the page is served from the same origin, so
 * the browser sends no cross-site credentials to begin with, and the queue is
 * readable by anything running as this user regardless.
 * @param request - the incoming request.
 * @returns true when the request may see the queue.
 */
function sameOriginLoopback(request: MemoryWebRequest): boolean {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const headers = request.headers
  if (headers.forwarded !== undefined || headers['x-forwarded-for'] !== undefined || headers['x-real-ip'] !== undefined) return false
  const host = headerText(headers.host)
  const origin = headerText(headers.origin)
  if (origin === '') return host !== ''
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Read one header that may arrive as a single value or a list.
 * @param value - the header value.
 * @returns the text, or the empty string when the header is absent.
 */
function headerText(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value
  return Array.isArray(value) && value.length > 0 ? value[0] ?? '' : ''
}

/**
 * Read and parse one JSON request body.
 * @param request - the incoming request.
 * @returns the parsed value, or the status and reason to send.
 */
async function readJsonBody(request: MemoryWebRequest): Promise<
  { ok: true; value: unknown } | { ok: false; status: number; message: string }
> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += buffer.length
      if (size > MAX_BODY_BYTES) return { ok: false, status: 413, message: 'the request body is too large' }
      chunks.push(buffer)
    }
  } catch (failure) {
    return { ok: false, status: 400, message: `the request body could not be read: ${failureMessage(failure)}` }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, status: 400, message: 'the request body is not valid JSON' }
  }
}

/**
 * Serialize actions so two tabs cannot interleave a read and a rewrite.
 * @returns a function that runs one action after the previous one settled.
 */
function createQueue(): <T>(work: () => Promise<T> | T) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(work: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * Send one JSON response.
 * @param response - the response this handler owns.
 * @param status - the HTTP status.
 * @param payload - the JSON body.
 * @returns nothing.
 */
function sendJson(response: MemoryWebResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(payload))
}

/**
 * Send one plain-text response.
 * @param response - the response this handler owns.
 * @param status - the HTTP status.
 * @param message - the body.
 * @param headers - extra headers, such as `allow`.
 * @returns nothing.
 */
function sendText(response: MemoryWebResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
  response.end(message)
}
