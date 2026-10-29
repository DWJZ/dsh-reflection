/**
 * Keeping each scope's cached summary in step with its store.
 *
 * Injection reads the cache and never waits for a model. When a read notices the
 * cache describes an older revision — the store changed since it was written —
 * it asks this service to catch up in the background. One refresh per scope runs
 * at a time; a request that arrives while one is running is satisfied by it,
 * because the run reads the store itself and always describes the latest
 * revision it saw.
 *
 * @module dsh-reflection/summary-service
 */

import { readStore } from './jsonstore.js'
import { SUMMARY_SYSTEM_PROMPT, buildSummaryPrompt, readSummaryDocument, writeSummaryDocument } from './summary.js'
import { streamModelText } from './consolidation/model.js'
import { failureMessage } from './errors.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ProjectEntry } from './types/identity.js'
import type { MemoryRecord, ScopeLayout } from './types/memory.js'

/** What one summary service is given. */
export interface SummaryServiceOptions {
  /** The two scope layouts, resolved per project id. */
  scopes: { user: ScopeLayout; project(projectId: string | null | undefined): ScopeLayout }
  /** The project a Session's directory belongs to, or null when none is known. */
  projectFor(agent: MemoryAgent): ProjectEntry | null
  /** The injection scope carrying `llm`, resolved when a call is made. */
  llmScope(): Context | undefined
  /** Diagnostic sink. */
  logger?: { warn(message: string | Error): void; debug?(message: string): void } | undefined
  /** Injection budget the summary is written for. */
  summaryBudgetBytes: number
  /** Injectable clock, in epoch milliseconds. */
  now?(): number
}

/**
 * Build the summary refresher.
 * @param options - scopes, the model seam, and the clock.
 * @returns the refresher.
 */
export function createSummaryService(options: SummaryServiceOptions) {
  /** One run per summary file, so two renders cannot ask the same question twice. */
  const inFlight = new Map<string, Promise<void>>()
  /** Summary files whose last failure has been reported, so a broken route warns once. */
  const warned = new Set<string>()
  /** Every run still executing, so teardown can wait for them. */
  const runs = new Set<Promise<void>>()

  /**
   * Refresh one scope when its cache is behind its store.
   * @param agent - the agent whose route the call reuses.
   * @param layout - the scope to describe.
   * @param scopeLabel - `user` or `project`, named in the prompt.
   * @param projectPath - the project root, when the scope is a project.
   * @returns fulfillment once the cache is current or the attempt is abandoned.
   */
  const refreshOne = async (
    agent: MemoryAgent,
    layout: ScopeLayout,
    scopeLabel: string,
    projectPath?: string | undefined,
  ): Promise<void> => {
    const llm = options.llmScope()
    if (llm === undefined) return
    const store = readStore(layout.storePath)
    if (!store.records.some((record: MemoryRecord) => record.status === 'active')) return
    const cached = readSummaryDocument(layout.summaryPath)
    if (cached !== undefined && cached.revision === store.revision && cached.text.trim() !== ''
      && cached.budget === options.summaryBudgetBytes) return
    const session = agent?.session
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const answer = await streamModelText(llm, {
      session,
      sessionId,
      system: SUMMARY_SYSTEM_PROMPT,
      prompt: buildSummaryPrompt({
        records: store.records,
        scopeLabel,
        ...projectPath === undefined ? {} : { projectPath },
        budgetBytes: options.summaryBudgetBytes,
      }),
      label: 'summary',
    })
    writeSummaryDocument(layout.summaryPath, {
      text: answer.text,
      revision: store.revision,
      generated_at: new Date((options.now ?? Date.now)()).toISOString(),
      model: `${answer.provider}/${answer.model}`,
      budget: options.summaryBudgetBytes,
    })
  }

  /**
   * Start a refresh for one scope, unless one is already running.
   * @param agent - the agent whose route the call reuses.
   * @param layout - the scope to describe.
   * @param scopeLabel - `user` or `project`.
   * @param projectPath - the project root, when the scope is a project.
   * @returns nothing.
   */
  const schedule = (
    agent: MemoryAgent,
    layout: ScopeLayout,
    scopeLabel: string,
    projectPath?: string | undefined,
  ): Promise<void> => {
    const key = layout.summaryPath
    const existing = inFlight.get(key)
    if (existing !== undefined) return existing
    let failed = false
    const run = refreshOne(agent, layout, scopeLabel, projectPath)
      .catch((failure: unknown) => {
        // A summary that cannot be written is a stale cache, not a failed turn:
        // injection keeps serving the previous text and the next read retries.
        // The first failure is visible; repeated retries stay at debug so a
        // broken route does not flood the log.
        failed = true
        const message = `dsh-reflection: could not refresh the Memory summary at ${key}: ${failureMessage(failure)}`
        if (warned.has(key)) options.logger?.debug?.(message)
        else {
          warned.add(key)
          options.logger?.warn?.(message)
        }
      })
      .finally(() => {
        inFlight.delete(key)
        if (!failed) warned.delete(key)
      })
    inFlight.set(key, run)
    runs.add(run)
    void run.then(() => runs.delete(run))
    return run
  }

  return {
    /**
     * Bring both scopes' summaries up to date.
     *
     * A writer awaits this so the summary it just invalidated is current before
     * the turn ends; a render calls it without awaiting, because the request it
     * is assembling must not wait for a model call.
     * @param agent - the agent whose route the calls reuse.
     * @returns fulfillment once both scopes are current or their attempts ended.
     */
    async refresh(agent: MemoryAgent): Promise<void> {
      const pending = [schedule(agent, options.scopes.user, 'user')]
      const project = options.projectFor(agent)
      if (project !== null) {
        pending.push(schedule(agent, options.scopes.project(project.project_id), 'project', project.canonical_root))
      }
      await Promise.allSettled(pending)
    },

    /**
     * Wait for every refresh still running.
     * @returns fulfillment once none is executing.
     */
    async whenSettled(): Promise<void> {
      await Promise.allSettled([...runs])
    },
  }
}
