/**
 * One consolidation run, from the progress mark to the next one.
 *
 * The order below is the whole design, and each step exists because skipping it
 * loses something:
 *
 * 1. Reconcile the mark with what this process actually observed. Events from
 *    before the plugin mounted, or from a Session resumed elsewhere, are not in
 *    the buffer and cannot be read back; the range is recorded as a gap so "not
 *    observed" never reads as "read and held nothing".
 * 2. Take the bounded window. Ignorable and internal events are counted and
 *    consumed; an unknown event stops the run and names itself.
 * 3. Require a human turn. An idle period with no human input is not a reason to
 *    ask a model anything, and the window is consumed so it is not re-examined.
 * 4. Ask once, review the answer, commit through Phase 1, then move the mark.
 *
 * A failure anywhere before the commit leaves the mark alone, so the next
 * eligible idle period retries the same window. A partial commit does too, and
 * the retry re-reads Memory and decides again rather than replaying a plan that
 * was formed against state that has since moved.
 *
 * Usage: `const outcome = await consolidation.consolidate(agent)`.
 */

import { readStore } from '../jsonstore.js'
import { createTrigger } from './trigger.js'
import { batchWindow } from './normalize.js'
import { buildRequest } from './policy.js'
import { callConsolidator } from './model.js'
import type { ConsolidationAnswer, ConsolidationUsage } from './model.js'
import { parsePlan } from './policy.js'
import { reviewPlan } from './validate.js'
import { commitOperations } from './commit.js'
import { advanceHwm, lastProcessedSeq, NO_PROGRESS, progressFor, readState, recordGap, withState } from './state.js'
import { failureMessage } from '../errors.js'
import type { ConsolidationRequest } from './model.js'
import type { ObservedEvent } from '../types/trajectory.js'
import { MAX_BACKFILL_EVENTS } from '../history.js'
import type { HistoryReader } from '../history.js'
import { createCollector } from './collector.js'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { StateLockOptions } from './state.js'
import type { ProjectEntry } from '../types/identity.js'
import type { MemoryConsolidationSettings } from '../types/config.js'
import type { ActionOptions, KillProbe } from '../types/memory.js'

/** Session record name carrying this plugin's consolidation audit. */
export const AUDIT_EVENT_TYPE = 'plugin:dsh-reflection/consolidation'

/**
 * Build the consolidation orchestrator.
 *
 * @param {object} options - wiring.
 * @param options.llmScope - the injection scope carrying `llm`, or a getter for it.
 * @param options.collector - the observed-event buffer.
 * @param options.scopes - Phase 1 scope layouts.
 * @param options.state - consolidation state location and lock.
 * @param options.actionOptions - Phase 1 action options for committing.
 * @param options.config - consolidation policy.
 * @param options.logger - optional `{ info, warn }` sink.
 * @param options.now - clock, injectable for tests.
 * @param options.callModel - the model call seam, injectable for tests.
 * @returns the orchestrator.
 */
/**
 * The compact result of one run, as it is recorded on the Session and rendered.
 *
 * A dry run reports what it would have done — the accepted proposals and the refusals —
 * while a run that settled reports counts. The two share the window fields, and
 * `rejected` means a list in the first case and a count in the second.
 */
export interface DryRunAudit {
  status: 'dry-run'
  /** The window the run covered. */
  from_seq?: number | undefined
  to_seq?: number | undefined
  /** How many events the window held, by disposition. */
  relevant_events?: number | undefined
  ignored_events?: number | undefined
  /** The operations the review accepted, as the model proposed them. */
  accepted: readonly AcceptedProposal[]
  /** The proposals the review refused, with their position in the plan. */
  rejected: readonly { index?: number | undefined; reason?: string | undefined }[]
  /** Why accepted proposals became no-ops. */
  noopReasons: readonly string[]
  /** The model's own answer, kept only for a dry run that asked for it. */
  model_raw?: string | undefined
  /** What asked for the run. */
  trigger?: string | undefined
  /** What the model call cost, when the provider reported it. */
  usage?: ConsolidationUsage | undefined
}

/** One proposal a dry run would have written. */
export interface AcceptedProposal {
  /** The record it targets, when it changes one. */
  target_id?: string | undefined
  action: string
  /** Inherited from the reviewed record, so a `target_id`-less proposal may lack it. */
  scope?: string | undefined
  /** Inherited, as `scope` is. */
  category?: string | undefined
  content: string
  confidence: number
  evidence_event_seqs: readonly number[]
  quote: string
}

/** The statuses a run that settled reports. */
export type SettledStatus =
  | 'success'
  | 'partial'
  | 'gap'
  | 'no-human-turn'
  | 'nothing-pending'
  | 'nothing-observed'
  | 'no-session'

/** What a run that settled reports: counts, not proposals. */
export interface SettledAudit {
  status: SettledStatus
  from_seq?: number | undefined
  to_seq?: number | undefined
  relevant_events?: number | undefined
  ignored_events?: number | undefined
  /** Proposed, performed and skipped operations, by action. */
  operations?: { add: number; update: number; supersede: number; noop: number; skipped?: number; failed?: number } | undefined
  /** How many proposals the review refused. */
  rejected?: number | undefined
  /** How many writes did not happen. */
  failures?: number | undefined
  /** What the commit changed. */
  committed?: { add: number; update: number; supersede: number } | undefined
  /** Why proposals were refused, by code. */
  rejected_reasons?: Record<string, number> | undefined
  /** What asked for the run. */
  trigger?: string | undefined
  /** What the model call cost, when the provider reported it. */
  usage?: ConsolidationUsage | undefined
}

/** One run's record, discriminated by whether it wrote anything. */
export type RunAudit = DryRunAudit | SettledAudit

/** The policy one run follows, plus the thresholds it locks and cites with. */
export interface RunConfig extends MemoryConsolidationSettings {
  lockTimeoutMs: number
  staleLockMs: number
  maxEvidencePerMemory: number
  quoteMaxChars: number
}

/** What one consolidation orchestrator is given. */
export interface ConsolidationOptions {
  llmScope: Context | (() => Context | undefined)
  collector: ReturnType<typeof createCollector>
  scopes: ActionOptions['scopes']
  state: StateLockOptions
  actionOptions: ActionOptions
  config: RunConfig
  logger?: { warn(message: string | Error): void; info?(message: string): void; debug?(message: string): void } | undefined
  now?(): number
  host: string
  kill?: KillProbe | undefined
  sessionEvents: boolean
  /** Reads ranges this process never observed; absent when the harness cannot. */
  history?: HistoryReader | undefined
  projectFor(agent: MemoryAgent): ProjectEntry | null
  callModel?(request: ConsolidationRequest): Promise<ConsolidationAnswer>
  /** Refresh the scope summaries after a run that wrote Memory. */
  refreshSummary?(agent: MemoryAgent): Promise<void>
  schedule?(run: () => void, ms: number): ReturnType<typeof setTimeout>
  cancelSchedule?(handle: ReturnType<typeof setTimeout>): void
}

export function createConsolidation(options: ConsolidationOptions) {
  const { collector, scopes, logger, config } = options
  /**
   * Every consolidation run still executing, automatic or driven by a command.
   *
   * A single slot would only know about the most recent one: two Sessions run
   * concurrently, and the one that started last can finish first, leaving the
   * earlier run writing Memory, an audit and a mark after teardown had already
   * decided that nothing was in flight.
   */
  const runs = new Set()

  /**
   * One queue per Session, so two entry points cannot process the same window.
   *
   * `runMaintenance()` serializes one agent, but several agents can share a
   * Session, and the command path does not go through the trigger's `running`
   * set at all. Two runs that both read the same mark would each build the same
   * window, ask the model, and commit — the state lock only protects the
   * individual writes, not the read-decide-commit sequence.
   */
  const queues = new Map()

  /**
   * Run one piece of work after everything already queued for a Session.
   * @param sessionId - the Session whose window the work will read.
   * @param work - the work to run.
   * @returns the work's own outcome.
   */
  const inSessionOrder = <T>(sessionId: string, work: () => T | Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve()
    const next = previous.then(work, work)
    let tail: Promise<T> | undefined
    const done = () => { if (queues.get(sessionId) === tail) queues.delete(sessionId) }
    tail = next.then(done, done)
    queues.set(sessionId, tail)
    return next
  }

  /**
   * Remember a run until it settles.
   * @param run - the promise for one run.
   * @returns the same promise, so callers keep the outcome.
   */
  const track = <T>(run: Promise<T>): Promise<T> => {
    let tracked: Promise<T> | undefined
    tracked = run.finally(() => { runs.delete(tracked) })
    runs.add(tracked)
    return tracked
  }
  const now = options.now ?? Date.now
  const callModel = options.callModel ?? ((request: ConsolidationRequest) => {
    const scope = typeof options.llmScope === 'function' ? options.llmScope() : options.llmScope
    if (scope === undefined || scope === null) {
      throw new Error('dsh-reflection: no model service is mounted, so consolidation has nothing to ask')
    }
    return callConsolidator(scope, request)
  })
  const stateOptions = { ...options.state, lockTimeoutMs: config.lockTimeoutMs, staleLockMs: config.staleLockMs, logger, now, host: options.host, kill: options.kill }

  /**
   * The active Memory a run may target, from both visible scopes.
   * @param projectId - the Session's project, or null.
   * @returns the active records.
   */
  const activeMemory = (projectId: string | null | undefined) => {
    const user = readStore(scopes.user.storePath).records
    const project = projectId === null || projectId === undefined
      ? []
      : readStore(scopes.project(projectId).storePath).records
    return [...user, ...project].filter(record => record.status === 'active')
  }

  /**
   * Read a hole in chunks small enough for one history call.
   * @param sessionId - the Session to read.
   * @param fromSeq - first seq wanted, inclusive.
   * @param toSeq - last seq wanted, inclusive.
   * @returns every event, or undefined when any chunk cannot be read whole.
   */
  const readHole = async (sessionId: string, fromSeq: number, toSeq: number): Promise<ObservedEvent[] | undefined> => {
    if (options.history === undefined) return undefined
    const events: ObservedEvent[] = []
    let cursor = fromSeq
    while (cursor <= toSeq) {
      const end = Math.min(cursor + MAX_BACKFILL_EVENTS - 1, toSeq)
      const chunk = await options.history.read(sessionId, cursor, end)
      if (chunk === undefined || chunk.length !== end - cursor + 1) return undefined
      events.push(...chunk)
      cursor = end + 1
    }
    return events
  }

  /**
   * Reconcile the stored mark with the first seq this process can offer.
   *
   * Returns the mark to start from. A gap is recorded when the buffer begins
   * later than the mark requires, which is the only honest way to say those
   * events were never seen.
   * @param sessionId - the Session being consolidated.
   * @returns the seq to collect after.
   */
  const reconcile = async (sessionId: string) => {
    const first = collector.firstSeq(sessionId)
    const state = readState(options.state.statePath)
    const mark = lastProcessedSeq(state, sessionId)
    // A Session this process has consumed and dropped everything for still has a
    // mark, which is a different thing from a Session it has never seen.
    if (first === undefined) return { afterSeq: mark === NO_PROGRESS ? undefined : mark }
    if (first <= mark + 1) return { afterSeq: mark }
    // The harness may still be able to read a range this process never saw, so
    // ask before writing the hole down as a gap. Read it in chunks: one read's
    // cap must not turn a long backlog into a gap.
    const backfilled = await readHole(sessionId, mark + 1, first - 1)
    if (backfilled !== undefined && backfilled.length > 0) {
      logger?.info?.(`dsh-reflection: backfilled seqs ${String(mark + 1)}..${String(first - 1)} of ${sessionId} from session history`)
      return { afterSeq: mark, backfilled }
    }
    // Everything between the mark and the first event this process can still
    // offer was unavailable, whatever the reason: a mount that came late, a
    // Session resumed elsewhere, or events the buffer had to evict under its
    // cap. The gap is the same range in all three cases; what differs is only
    // why, which is worth saying in the log.
    const droppedThrough = collector.droppedThrough(sessionId)
    const at = new Date(now()).toISOString()
    // The range is decided against the state as it is inside the lock. Another
    // process may have consumed part of it between the read above and here, and
    // a gap written from the older mark would call events somebody else read
    // "never observed".
    let gap: { from_seq: number; to_seq: number } | undefined
    const written = await withState(stateOptions, (current) => {
      const currentMark = lastProcessedSeq(current, sessionId)
      if (first <= currentMark + 1) return { changed: false, state: current }
      gap = { from_seq: currentMark + 1, to_seq: first - 1 }
      return { changed: true, state: recordGap(current, sessionId, gap, at) }
    })
    if (gap === undefined) return { afterSeq: lastProcessedSeq(written.state, sessionId) }
    const reason = droppedThrough >= gap.from_seq - 1 ? 'the buffer evicted them' : 'this process was not observing yet'
    logger?.info?.(`dsh-reflection: consolidation skipped seqs ${String(gap.from_seq)}..${String(gap.to_seq)} of ${sessionId} (${reason})`)
    return { afterSeq: lastProcessedSeq(written.state, sessionId), gap }
  }

  /**
   * Record one run's result on the Session, without letting the trace decide
   * whether the run succeeded.
   * @param session - the Session to record against.
   * @param audit - the compact result.
   * @returns nothing.
   */
  const recordAudit = (session: MemorySession, audit: RunAudit): void => {
    // The plugin's single switch for writing the audit row into the Session log.
    // It is off by default; a deployment that wants the trajectory row turns it on.
    if (options.sessionEvents !== true) return
    // The commit is the guarantee; the audit is a trace of it. A failed append
    // must not hold the mark back, because the next run would commit the same
    // operations again.
    try {
      // A record is losslessly JSON by contract, and the writer refuses a payload
      // a JSON round trip cannot preserve — an optional field left `undefined` is
      // exactly that, whether it sits at the top level or inside a nested usage
      // summary. The audit holds counts and labels, so its JSON projection IS the
      // payload; normalizing once here keeps every construction site from having
      // to spell each absent field correctly.
      appendPluginRecord(session, AUDIT_EVENT_TYPE, JSON.parse(JSON.stringify(audit)))
    } catch (failure) {
      logger?.warn?.(`dsh-reflection: could not record the consolidation audit: ${failureMessage(failure)}`)
    }
  }

  /**
   * Run one consolidation inside the agent's maintenance phase.
   *
   * The phase claim is what keeps a new user turn from starting in the middle of
   * a run, and it is what makes `whenIdle()` — and therefore the owner's flush
   * and dispose — wait for the run to settle. Working outside it would let a turn
   * interleave, and would let the Session be flushed or torn down while the
   * result was still being written.
   *
   * The claim throws when a turn or another maintenance task already owns the
   * agent. That is not a failure: the caller retries on the next idle period,
   * with the mark untouched.
   * @param agent - the agent to consolidate.
   * @param {object} runOptions - run options.
   * @param runOptions.dryRun - review the plan without committing or advancing.
   * @returns a compact outcome.
   */
  const consolidate = async (
    agent: MemoryAgent,
    runOptions: { dryRun?: boolean; trigger?: string; signal?: AbortSignal; showRaw?: boolean } = {},
  ): Promise<RunAudit> => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return { status: 'no-session' }
    // The maintenance claim is taken when the run actually starts, not while it
    // waits its turn, so a queued run does not hold an agent's phase open.
    return track(inSessionOrder(sessionId, () =>
      agent.runMaintenance((signal: AbortSignal) => runOnce(agent, { ...runOptions, signal }))))
  }

  /**
   * Do the work for one consolidation run.
   * @param agent - the agent being consolidated.
   * @param runOptions - run options, including the maintenance signal.
   * @returns a compact outcome.
   */
  const runOnce = async (
    agent: MemoryAgent,
    runOptions: {
      dryRun?: boolean | undefined
      trigger?: string | undefined
      signal?: AbortSignal | undefined
      showRaw?: boolean | undefined
    },
  ): Promise<RunAudit> => {
    const session = agent?.session
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return { status: 'no-session' }

    const { afterSeq, gap, backfilled } = await reconcile(sessionId)
    if (afterSeq === undefined) return { status: 'nothing-observed' }
    if (gap !== undefined) {
      // Recorded as soon as it is durable, not with this run's outcome: a window
      // that cannot be read, or a model that fails, would otherwise leave a gap in
      // the state that no audit ever mentions, and the retry no longer reports it
      // because the mark has already moved past.
      recordAudit(session, { status: 'gap', ...gap, trigger: runOptions.trigger ?? 'direct' })
    }
    const observed = mergeEvents(backfilled ?? [], collector.eventsFor(sessionId))
    let cursor = afterSeq
    let batches = 0
    let last: SettledAudit | undefined
    const totals = {
      fromSeq: cursor + 1,
      relevant: 0,
      ignored: 0,
      operations: { add: 0, update: 0, supersede: 0, noop: 0, skipped: 0, failed: 0 },
      rejected: 0,
      usage: undefined as ConsolidationUsage | undefined,
    }
    /**
     * Add one call's usage to the run total.
     * @param usage - the call's usage, when the provider reported it.
     * @returns nothing.
     */
    const addUsage = (usage: ConsolidationUsage | undefined): void => {
      if (usage === undefined) return
      const previous = totals.usage
      totals.usage = {
        inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
        outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
        ...usage.totalTokens === undefined
          ? previous?.totalTokens === undefined ? {} : { totalTokens: previous.totalTokens }
          : { totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens },
      }
    }
    /**
     * Consume one window without asking a model.
     * @param auditBase - the window's counts.
     * @param status - why nothing was asked.
     * @returns the outcome.
     */
    const consume = async (
      auditBase: { from_seq: number; to_seq: number; relevant_events: number; ignored_events: number },
      status: SettledStatus,
    ) => {
      await withState(stateOptions, current => ({
        changed: true,
        state: advanceHwm(current, sessionId, auditBase.to_seq, new Date(now()).toISOString()),
      }))
      collector.dropConsumed(sessionId, auditBase.to_seq)
      // A window with nothing relevant in it taught nothing, and writing an audit
      // for it would be self-defeating: an audit is appended to the Session, which
      // publishes it back to this collector, so auditing an empty window puts the
      // audit itself in the next window.
      if (auditBase.relevant_events === 0) {
        logger?.debug?.(`dsh-reflection: consolidation of ${sessionId} consumed seqs ${String(auditBase.from_seq)}..${String(auditBase.to_seq)} without asking anything (${status})`)
        return { ...auditBase, status }
      }
      recordAudit(session, { ...auditBase, status, operations: { add: 0, update: 0, supersede: 0, noop: 0 } })
      return { ...auditBase, status }
    }

    while (batches < config.maxBatchesPerRun) {
      const window = batchWindow(observed, {
        afterSeq: cursor,
        maxEvents: config.maxRelevantEventsPerBatch,
        maxBytes: config.maxTrajectoryBytesPerBatch,
      })
      if (window.unsupported !== undefined) {
        throw new Error(`dsh-reflection: consolidation cannot read ${String(window.unsupported.type)} events (seq ${String(window.unsupported.seq)})`)
      }
      if (window.toSeq === undefined) break
      const toSeq = window.toSeq
      const auditBase = {
        from_seq: cursor + 1,
        to_seq: toSeq,
        relevant_events: window.counts.relevant,
        ignored_events: window.counts.ignored + window.counts.internal + window.counts.skipped,
        trigger: runOptions.trigger ?? 'direct',
      }
      if (!window.humanTurn) {
        last = await consume(auditBase, 'no-human-turn')
        totals.relevant += auditBase.relevant_events
        totals.ignored += auditBase.ignored_events
        cursor = toSeq
        batches += 1
        continue
      }

      const projectId = options.projectFor(agent)?.project_id ?? null
      const existing = activeMemory(projectId)
      const request = {
        session,
        sessionId,
        fromSeq: cursor + 1,
        toSeq: toSeq,
        entries: window.entries,
        existing: existing.map(record => ({
          id: record.id,
          scope: record.scope,
          content: record.content,
        })),
        signal: runOptions.signal,
      }
      let answer = await callModel(request)
      let plan = parsePlan(answer.text)
      let usage = answer.usage
      let modelRaw = answer.text
      if (planNeedsTitle(plan)) {
        // The plan is sent back once with the missing-title complaint, so a valid
        // plan is not rejected for a fixable omission. A retry that fails keeps
        // the first plan; the review then rejects the untitled operations.
        try {
          const retried = await callModel({ ...request, note: TITLE_RETRY_NOTE })
          plan = parsePlan(retried.text)
          modelRaw = retried.text
          usage = sumUsage(usage, retried.usage)
        } catch (failure) {
          logger?.warn(`dsh-reflection: the consolidation title retry failed: ${failureMessage(failure)}`)
        }
      }
      // The usage belongs to the call, not the window, so it rides along with the
      // window fields every audit construction already spreads.
      const extras = auditBase as { usage?: ConsolidationUsage | undefined; model_raw?: string }
      extras.usage = usage
      // The raw answer can quote the conversation, so it is kept only when a person
      // asks for it with a dry run.
      if (runOptions.dryRun === true && runOptions.showRaw === true) extras.model_raw = modelRaw
      const reviewed = reviewPlan(plan, {
        fromSeq: cursor + 1,
        toSeq: toSeq,
        visibleSeqs: new Set(window.entries.map(entry => entry.seq)),
        eventsBySeq: new Map(observed.map((event: ObservedEvent) => [event.seq, event])),
        existing,
        projectId,
        sessionId,
        minConfidence: config.minConfidence,
        quoteMaxChars: config.quoteMaxChars,
        maxEvidencePerMemory: config.maxEvidencePerMemory,
        now,
      })

      if (runOptions.dryRun === true) {
        return {
          ...auditBase,
          status: 'dry-run',
          accepted: reviewed.accepted.map(operation => ({
            action: operation.action,
            scope: operation.scope,
            content: operation.content,
            confidence: operation.confidence,
            // Only an update or a supersede names a record; `add` has none.
            target_id: operation.action === 'add' ? undefined : operation.target_id,
            evidence_event_seqs: operation.evidence.event_seqs,
            quote: operation.evidence.quote,
          })),
          rejected: reviewed.rejected,
          noopReasons: reviewed.noopReasons,
        }
      }

      const rejectedCount = reviewed.rejected.length
      const rejected = countRejections(reviewed.rejected)
      const operations = {
        add: 0,
        update: 0,
        supersede: 0,
        noop: reviewed.noopReasons.length,
        skipped: 0,
        failed: 0,
      }

      const outcome = await commitOperations(options.actionOptions, reviewed.accepted)

      if (outcome.failures.length > 0) {
        // Something a review accepted could not be written. The mark stays put, so
        // the window is retried and the plan is formed again against current state.
        logger?.warn?.(`dsh-reflection: consolidation left ${String(outcome.failures.length)} operation(s) unwritten for ${sessionId}`)
        // Everything a plan contained is accounted for: written + duplicate-or-
        // conflict + failed + no-op adds up to what the review accepted plus what
        // it proposed nothing for.
        recordAudit(session, {
          ...auditBase,
          status: 'partial',
          operations: {
            ...operations,
            ...outcome.committed,
            skipped: outcome.skipped.length,
            failed: outcome.failures.length,
          },
          rejected: rejectedCount,
          ...rejected,
        })
        return { ...auditBase, status: 'partial', committed: outcome.committed, failures: outcome.failures.length }
      }

      await withState(stateOptions, current => ({
        changed: true,
        state: advanceHwm(current, sessionId, toSeq, new Date(now()).toISOString()),
      }))
      collector.dropConsumed(sessionId, toSeq)
      const written = { ...operations, ...outcome.committed, skipped: outcome.skipped.length }
      recordAudit(session, { ...auditBase, status: 'success', operations: written, rejected: rejectedCount, ...rejected })
      const wrote = written.add + written.update + written.supersede
      logger?.info?.(`dsh-reflection: consolidation of ${sessionId} consumed ${String(auditBase.relevant_events)} event(s) and wrote ${String(wrote)}`)
      last = { ...auditBase, status: 'success', operations: written, rejected: rejectedCount, ...rejected }
      totals.relevant += auditBase.relevant_events
      totals.ignored += auditBase.ignored_events
      totals.operations.add += written.add
      totals.operations.update += written.update
      totals.operations.supersede += written.supersede
      totals.operations.noop += written.noop
      totals.operations.skipped += written.skipped
      totals.operations.failed += written.failed
      totals.rejected += rejectedCount
      addUsage(answer.usage)
      cursor = toSeq
      batches += 1
    }

    if (last === undefined) return { status: 'nothing-pending' }
    const wroteSomething = totals.operations.add + totals.operations.update + totals.operations.supersede > 0
    if (wroteSomething) {
      // A consolidation that wrote Memory has invalidated the summary; refresh it
      // now so the next request does not serve text written before the commit.
      try {
        await options.refreshSummary?.(agent)
      } catch (failure) {
        logger?.warn(`dsh-reflection: could not refresh the Memory summary after consolidation: ${failureMessage(failure)}`)
      }
    }
    if (batches >= config.maxBatchesPerRun && observed.some(event => event.seq > cursor)) {
      logger?.info?.(`dsh-reflection: consolidation of ${sessionId} stopped after ${String(batches)} window(s); more events remain`)
    }
    return {
      ...last,
      from_seq: totals.fromSeq,
      to_seq: cursor,
      relevant_events: totals.relevant,
      ignored_events: totals.ignored,
      operations: totals.operations,
      rejected: totals.rejected,
      ...totals.usage === undefined ? {} : { usage: totals.usage },
    }
  }

  const trigger = createTrigger({
    debounceMs: config.debounceMs,
    logger,
    ...options.schedule === undefined ? {} : { schedule: options.schedule },
    ...options.cancelSchedule === undefined ? {} : { cancelSchedule: options.cancelSchedule },
    task: (agent: MemoryAgent) => consolidate(agent, { trigger: 'idle-debounce' }),
  })

  return {
    /**
     * Record one committed Session event for later consolidation.
     * @param session - the Session it belongs to.
     * @param event - the committed event.
     * @returns nothing.
     */
    observe(session: MemorySession, event: ObservedEvent) {
      collector.observe(session, event)
    },

    /**
     * React to an agent status change by scheduling or cancelling the debounce.
     * @param agent - the agent.
     * @param status - its new status.
     * @returns nothing.
     */
    statusChanged(agent: MemoryAgent, status: string) {
      trigger.statusChanged(agent, status)
    },

    /**
     * Consolidate one agent now, outside the debounce.
     * @param agent - the agent.
     * @param runOptions - `{ dryRun }`.
     * @returns the outcome.
     */
    consolidate,

    /**
     * The progress recorded for one Session.
     * @param sessionId - the Session.
     * @returns its mark and gaps, or undefined.
     */
    progressFor(sessionId: string) {
      return progressFor(readState(options.state.statePath), sessionId)
    },

    /**
     * Cancel debounces that have not fired yet.
     *
     * Called when Memory is switched off: nothing new may be collected, asked,
     * written, or marked after that returns, and a timer already waiting would
     * do all four.
     * @returns nothing.
     */
    cancelPending() {
      trigger.dispose()
    },

    /**
     * Wait for the automatic run in flight, if there is one.
     *
     * A run already past the point of being cancelled still has to settle before
     * the caller can claim that switching off stopped it.
     * @returns fulfillment once no automatic run is executing.
     */
    async whenSettled() {
      // Every run, not the most recent one: admission is already blocked and
      // debounces are cancelled by the caller, so this set only shrinks.
      const settled = await Promise.allSettled([...runs])
      for (const result of settled) {
        if (result.status === 'rejected') {
          // The trigger has already reported this failure and left the mark
          // alone. Waiting is about knowing runs have finished, not about their
          // outcome, so re-raising would surface a consolidation error as a
          // failed `/memory disable` or a failure escaping from unload.
          logger?.debug?.(`dsh-reflection: a consolidation run ended in failure: ${String(result.reason?.message ?? result.reason)}`)
        }
      }
    },

    /**
     * Drop pending timers.
     * @returns nothing.
     */
    dispose() {
      trigger.dispose()
    },
  }
}

/**
 * Merge the events a batch may read into one ascending sequence.
 *
 * The collector's copy wins over a backfilled one: it is the event this process
 * observed live, and the two can only differ if the log was rewritten under a
 * running process, which the harness does not do.
 * @param backfilled - events read from Session history.
 * @param observed - events this process saw.
 * @returns every distinct seq once, ascending.
 */
function mergeEvents(backfilled: readonly ObservedEvent[], observed: readonly ObservedEvent[]): ObservedEvent[] {
  const bySeq = new Map<number, ObservedEvent>()
  for (const event of backfilled) bySeq.set(event.seq, event)
  for (const event of observed) bySeq.set(event.seq, event)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * Count rejections by the code the reviewer assigned.
 *
 * The codes are this plugin's own, so an audit can say why operations were
 * refused without repeating anything a model wrote. A rejection's `reason` is
 * human prose that can quote the model's own action, scope and target names, and
 * an audit is a count of what happened, not a place for the turn's text.
 * @param rejected - the rejections recorded during review.
 * @returns `{ rejected_reasons }` when there were any, otherwise an empty object.
 */
/** The instruction that sends a title-less plan back to the model once. */
const TITLE_RETRY_NOTE = 'Your previous plan omitted a title for one or more operations. Every add, update and supersede needs a one-line title. Return the full plan again, with a title on each operation.'

/**
 * Whether a plan has an operation that must carry a title but does not.
 * @param plan - the parsed plan.
 * @returns true when a corrective retry is needed.
 */
function planNeedsTitle(plan: { operations?: unknown[] }): boolean {
  if (!Array.isArray(plan.operations)) return false
  return plan.operations.some((operation) => {
    if (typeof operation !== 'object' || operation === null) return false
    const action = (operation as { action?: unknown }).action
    if (action !== 'add' && action !== 'update' && action !== 'supersede') return false
    const title = (operation as { title?: unknown }).title
    return typeof title !== 'string' || title.trim() === ''
  })
}

/**
 * Add two calls' usage, keeping what the provider reported.
 * @param left - the first call's usage.
 * @param right - the second call's usage.
 * @returns the sum, or whichever side exists.
 */
function sumUsage(left: ConsolidationUsage | undefined, right: ConsolidationUsage | undefined): ConsolidationUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...left.totalTokens === undefined && right.totalTokens === undefined
      ? {}
      : { totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0) },
  }
}

function countRejections(
  rejected: readonly { code?: unknown }[],
): { rejected_reasons?: Record<string, number> } {
  if (rejected.length === 0) return {}
  const counts: Record<string, number> = {}
  for (const entry of rejected) {
    const code = typeof entry.code === 'string' ? entry.code : 'other'
    counts[code] = (counts[code] ?? 0) + 1
  }
  return { rejected_reasons: counts }
}

/**
 * Render one run's outcome for a person.
 * @param outcome - the outcome from {@link createConsolidation}.
 * @returns the text to show.
 */
export function describeOutcome(outcome: RunAudit): string {
  if (outcome.status === 'dry-run') {
    const lines = [
      `Dry run over seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)} (${String(outcome.relevant_events)} relevant, ${String(outcome.ignored_events)} ignored).`,
      `Proposed operations: ${String(outcome.accepted.length)}`,
      ...(outcome.usage === undefined
        ? []
        : [`Model tokens: ${String(outcome.usage.inputTokens)} in, ${String(outcome.usage.outputTokens)} out${outcome.usage.totalTokens === undefined ? '' : ` (${String(outcome.usage.totalTokens)} total)`}`]),
    ]
    for (const operation of outcome.accepted) {
      const target = operation.target_id === undefined ? '' : ` -> ${operation.target_id}`
      lines.push(`- ${operation.action} [${operation.scope}] ${operation.content}${target}`)
      lines.push(`  confidence ${String(operation.confidence)}; evidence ${operation.evidence_event_seqs.join(',')}; quote: ${operation.quote}`)
    }
    for (const rejected of outcome.rejected) lines.push(`- dropped (${String(rejected.index)}): ${rejected.reason}`)
    for (const reason of outcome.noopReasons) lines.push(`- noop: ${reason}`)
    if (outcome.model_raw !== undefined) lines.push('', 'Raw model answer:', outcome.model_raw)
    lines.push('Nothing was written and the progress mark is unchanged.')
    return lines.join('\n')
  }
  switch (outcome.status) {
    case 'success': {
      const { add, update, supersede, noop } = outcome.operations ?? { add: 0, update: 0, supersede: 0, noop: 0 }
      return `Consolidated seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)}: ${String(add)} added, ${String(update)} updated, ${String(supersede)} superseded, ${String(noop)} noop${outcome.rejected === 0 ? '' : `, ${String(outcome.rejected)} dropped`}.`
    }
    case 'partial':
      return `Consolidated seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)} but ${String(outcome.failures)} operation(s) could not be written; the window will be retried.`
    case 'no-human-turn':
      return `Nothing to learn from seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)}: this window holds no human turn. The window is consumed.`
    case 'nothing-pending': return 'Nothing new to consolidate.'
    case 'nothing-observed': return 'This Session has produced no events this process has observed.'
    case 'no-session': return 'dsh-reflection: this invocation has no Session to consolidate.'
    default: return `Consolidation did not run: ${String(outcome.status)}`
  }
}
