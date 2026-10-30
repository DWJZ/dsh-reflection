/**
 * Apply a reviewed digest.
 *
 * Each accepted candidate becomes one user-scope record. Only the project
 * records it names are archived — not the whole project — and each archived
 * record carries a comment saying it was promoted, so the removal is auditable.
 *
 * @module dsh-reflection/digest/apply
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { addMemory, archiveMemory } from '../actions.js'
import { failureMessage } from '../errors.js'
import { writeAtomic } from '../jsonstore.js'
import { digestLayout } from '../paths.js'
import { renderPendingDocument, renderPendingMarkdown } from './pending.js'
import type { PendingDigest } from './pending.js'
import type { MemoryDeps } from '../types/deps.js'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { DIGEST_EVENT_TYPE } from './types.js'

/** What one apply produced. */
export interface ApplyResult {
  status: 'applied' | 'error'
  message?: string | undefined
  applied: number
  archived: number
  skipped: number
  remaining: number
  historyPath?: string | undefined
  pendingPath?: string | undefined
}

/**
 * Apply selected candidates from the pending digest.
 * @param deps - command wiring: scopes, locks, clock, and summary refresh.
 * @param agent - the Session used for the post-apply summary refresh.
 * @param selection - comma-separated 1-based candidate numbers; undefined or empty for all.
 * @returns what was written and what remains.
 */
export async function applyDigest(
  deps: MemoryDeps,
  agent: MemoryAgent,
  selection?: string,
): Promise<ApplyResult> {
  const layout = digestLayout(deps.config.memoryDir)
  if (!existsSync(layout.pendingPath)) {
    return { status: 'error', message: 'there is no pending digest to apply', applied: 0, archived: 0, skipped: 0, remaining: 0 }
  }
  const pending = JSON.parse(readFileSync(layout.pendingPath, 'utf8')) as PendingDigest
  const total = pending.candidates.length
  const chosen = parseSelection(selection, total)
  if (chosen === undefined) {
    return { status: 'error', message: `--apply must be candidate numbers between 1 and ${String(total)}`, applied: 0, archived: 0, skipped: 0, remaining: total }
  }
  const options = {
    scopes: deps.scopes,
    tombstones: deps.tombstones,
    lockTimeoutMs: deps.config.lockTimeoutMs,
    staleLockMs: deps.config.staleLockMs,
    maxEvidencePerMemory: deps.config.maxEvidencePerMemory,
    logger: deps.logger,
  }
  let applied = 0
  let archived = 0
  let skipped = 0
  const appliedRecords: { index: number; title: string; record_id: string }[] = []
  const archivedIds: string[] = []
  const remaining: PendingDigest['candidates'] = []
  for (const [index, candidate] of pending.candidates.entries()) {
    if (!chosen.has(index + 1)) {
      remaining.push(candidate)
      continue
    }
    let recordId: string
    try {
      const outcome = await addMemory(options, {
        content: candidate.content,
        title: candidate.title,
        scope: 'user',
        source: 'agent',
        derivedFrom: candidate.derived_from,
        confidence: 0.9,
      })
      if (typeof outcome.id !== 'string') throw new Error(`no record id for candidate ${String(index + 1)}`)
      recordId = outcome.id
      applied += 1
      appliedRecords.push({ index: index + 1, title: candidate.title, record_id: recordId })
    } catch (failure) {
      deps.logger.warn(`dsh-reflection: digest candidate ${String(index + 1)} was not applied: ${failureMessage(failure)}`)
      remaining.push(candidate)
      continue
    }
    for (const source of candidate.derived_from) {
      try {
        await archiveMemory(options, {
          id: source.record_id,
          projectId: source.project_id,
          comment: `Promoted to user-scope experience ${recordId}: ${candidate.title}`,
        })
        archived += 1
        archivedIds.push(source.record_id)
      } catch {
        // A source that is already archived or superseded is already out of
        // service; it is not a reason to fail the candidate.
        skipped += 1
      }
    }
  }

  let historyPath: string | undefined
  if (remaining.length === 0) {
    const historyDir = join(layout.dir, 'history')
    mkdirSync(historyDir, { recursive: true })
    const stamp = new Date((deps.now ?? Date.now)()).toISOString().replace(/[:.]/gu, '-')
    historyPath = join(historyDir, `${stamp}.json`)
    renameSync(layout.pendingPath, historyPath)
    if (existsSync(layout.pendingMarkdownPath)) renameSync(layout.pendingMarkdownPath, join(historyDir, `${stamp}.md`))
  } else {
    const nextPending: PendingDigest = { ...pending, candidates: remaining }
    writeAtomic(layout.pendingPath, renderPendingDocument(nextPending))
    writeAtomic(layout.pendingMarkdownPath, renderPendingMarkdown(nextPending))
  }
  const session = agent?.session
  if (session !== undefined) {
    try {
      appendPluginRecord(session, DIGEST_EVENT_TYPE, {
        kind: 'apply',
        at: new Date((deps.now ?? Date.now)()).toISOString(),
        applied: appliedRecords,
        archived: archivedIds,
        skipped,
        remaining: remaining.length,
      })
    } catch (failure) {
      deps.logger.warn(`dsh-reflection: could not record the digest apply audit: ${failureMessage(failure)}`)
    }
  }
  // The writes are done; regenerating two summaries is a model call and can take
  // minutes. Leave it to the read path (which refreshes stale summaries) and
  // return, or the command looks hung.
  try {
    const refresh = deps.refreshSummary?.(agent)
    if (refresh !== undefined) {
      void refresh.catch(failure => deps.logger.warn(`dsh-reflection: summaries were not refreshed after apply: ${failureMessage(failure)}`))
    }
  } catch (failure) {
    deps.logger.warn(`dsh-reflection: summaries were not refreshed after apply: ${failureMessage(failure)}`)
  }
  return {
    status: 'applied',
    applied,
    archived,
    skipped,
    remaining: remaining.length,
    ...historyPath === undefined ? {} : { historyPath },
    ...remaining.length === 0 ? {} : { pendingPath: layout.pendingPath },
  }
}

/**
 * Parse and validate a candidate-number selection.
 * @param selection - comma-separated numbers; undefined or empty means every candidate.
 * @param total - how many candidates the pending file holds.
 * @returns the chosen 1-based numbers, or undefined when the selection is invalid.
 */
function parseSelection(selection: string | undefined, total: number): Set<number> | undefined {
  if (selection === undefined || selection.trim() === '') {
    return new Set(Array.from({ length: total }, (_, index) => index + 1))
  }
  const chosen = new Set<number>()
  for (const part of selection.split(',')) {
    const number = Number(part.trim())
    if (!Number.isInteger(number) || number < 1 || number > total) return undefined
    chosen.add(number)
  }
  return chosen
}
