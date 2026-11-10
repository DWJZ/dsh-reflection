/**
 * The pending queue as the Settings page reads and changes it.
 *
 * The page shows candidates, applies a selection, or drops one. Everything here
 * works on the same `digest/pending.json` the command surface uses, so the two
 * entry points cannot disagree about what is pending: the page never keeps its
 * own copy and every call re-reads the file.
 *
 * Applying goes through `applyDigest`, because that is where the promotion and
 * archival rules live. Dropping has no prior implementation; it keeps the
 * dropped candidates under `digest/discarded/` so a review decision stays
 * auditable after the queue is empty.
 *
 * @module dsh-reflection/digest/review
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { writeAtomic } from '../jsonstore.js'
import { digestLayout } from '../paths.js'
import { readRegistry } from '../registry.js'
import { failureMessage } from '../errors.js'
import { applyDigest } from './apply.js'
import { readPending, renderPendingDocument, renderPendingMarkdown } from './pending.js'
import type { PendingDigest } from './pending.js'
import { readDigestState } from './state.js'
import type { MemoryDeps } from '../types/deps.js'

/** One record a pending candidate was derived from, named for display. */
export interface ReviewSource {
  project_id: string
  /** Short project name, or the id when the registry cannot name it. */
  project: string
  /** Canonical project root, for a tooltip; null when the registry cannot name it. */
  project_root: string | null
  record_id: string
}

/** One candidate as the page renders it. */
export interface ReviewCandidate {
  /** 1-based position, the number an apply or discard selection names. */
  index: number
  title: string
  content: string
  sources: ReviewSource[]
}

/** One candidate the validation dropped. */
export interface ReviewRejected {
  title: string
  reason: string
  workspaces?: number
}

/** One pending queue as the page renders it. */
export interface ReviewPending {
  created_at: string
  scan_from: string | null
  scan_to: string
  model?: string
  usage?: { inputTokens: number; outputTokens: number; totalTokens?: number }
  candidates: ReviewCandidate[]
  rejected: ReviewRejected[]
}

/** What the page reads in one request. */
export interface ReviewState {
  /** Whether Memory itself is on; a disabled plugin offers no actions. */
  enabled: boolean
  /** Start of the last successful scan, or null before one. */
  lastScanAt: string | null
  /** The queue, or null when nothing is pending. */
  pending: ReviewPending | null
  /** Why the pending file cannot be read, when it exists but is unusable. */
  problem?: string
}

/** Which failed step a review failure reports. */
export type ReviewFailureCode = 'disabled' | 'no-pending' | 'unreadable' | 'invalid-selection' | 'stale' | 'failed'

/** One refused review action. */
export interface ReviewFailure {
  status: 'error'
  code: ReviewFailureCode
  message: string
}

/** A selection request as the browser sends it. */
export interface ReviewRequest {
  /** 1-based candidate numbers; absent or empty means every candidate. */
  selection?: unknown
  /** The `scan_to` the browser read, so a changed queue is refused instead of misapplied. */
  expectedScanTo?: unknown
}

/** What one apply produced. */
export type ReviewApplyResult = {
  status: 'applied'
  applied: number
  archived: number
  skipped: number
  remaining: number
  /** Where the consumed batch went when the queue emptied. */
  historyPath?: string
  /** Whether a Session audit record was written; false when no agent was available. */
  audited: boolean
} | ReviewFailure

/** What one discard produced. */
export type ReviewDiscardResult = {
  status: 'discarded'
  discarded: number
  remaining: number
} | ReviewFailure

/**
 * Read the current queue for the review page.
 * @param deps - the plugin wiring the queue and the registry live behind.
 * @returns the switch, the last scan, and the queue or why it is unusable.
 */
export function readReviewState(deps: MemoryDeps): ReviewState {
  const layout = digestLayout(deps.config.memoryDir)
  const lastScanAt = readDigestState(layout.statePath).lastScanAt ?? null
  const enabled = deps.isEnabled()
  const read = readPending(layout.pendingPath)
  if (read.status === 'none') return { enabled, lastScanAt, pending: null }
  if (read.status === 'invalid') return { enabled, lastScanAt, pending: null, problem: read.reason }
  return { enabled, lastScanAt, pending: describePending(deps, read.entry) }
}

/**
 * Promote the selected candidates to user-scope Memory.
 * @param deps - the plugin wiring, including the write options.
 * @param agent - the Session whose audit record and summary refresh are used; absent when none is available.
 * @param request - the selection and the queue generation it was read from.
 * @returns what was written, or why nothing was.
 */
export async function applyReview(
  deps: MemoryDeps,
  agent: MemoryAgent | undefined,
  request: ReviewRequest,
): Promise<ReviewApplyResult> {
  const checked = readQueue(deps, request)
  if ('status' in checked) return checked
  const chosen = normalizeSelection(request.selection, checked.entry.candidates.length)
  if (chosen === undefined) {
    return refused('invalid-selection', selectionMessage(checked.entry.candidates.length))
  }
  const outcome = await applyDigest(deps, agent, chosen.map(number => String(number)).join(','))
  if (outcome.status === 'error') return refused('failed', outcome.message ?? 'apply failed')
  const audited = agent?.session !== undefined
  return {
    status: 'applied',
    applied: outcome.applied,
    archived: outcome.archived,
    skipped: outcome.skipped,
    remaining: outcome.remaining,
    audited,
    ...outcome.historyPath === undefined ? {} : { historyPath: outcome.historyPath },
  }
}

/**
 * Drop the selected candidates without promoting them.
 *
 * The dropped candidates are written to `digest/discarded/` first, so the
 * decision is recoverable; only then is the pending file rewritten or removed.
 * @param deps - the plugin wiring the queue lives behind.
 * @param request - the selection and the queue generation it was read from.
 * @returns how many were dropped and how many remain, or why nothing was.
 */
export function discardReview(deps: MemoryDeps, request: ReviewRequest): ReviewDiscardResult {
  const checked = readQueue(deps, request)
  if ('status' in checked) return checked
  const entry = checked.entry
  const chosen = normalizeSelection(request.selection, entry.candidates.length)
  if (chosen === undefined) return refused('invalid-selection', selectionMessage(entry.candidates.length))
  const selected = new Set(chosen)
  const dropped = entry.candidates.filter((_candidate, index) => selected.has(index + 1))
  const remaining = entry.candidates.filter((_candidate, index) => !selected.has(index + 1))
  const layout = digestLayout(deps.config.memoryDir)
  const discardedDir = join(layout.dir, 'discarded')
  try {
    mkdirSync(discardedDir, { recursive: true })
    const at = new Date((deps.now ?? Date.now)()).toISOString()
    const stamp = at.replace(/[:.]/gu, '-')
    writeAtomic(join(discardedDir, `${stamp}.json`), renderDiscarded(dropped, entry, at))
    if (remaining.length === 0) {
      if (existsSync(layout.pendingPath)) unlinkSync(layout.pendingPath)
      if (existsSync(layout.pendingMarkdownPath)) unlinkSync(layout.pendingMarkdownPath)
    } else {
      const next: PendingDigest = { ...entry, candidates: remaining }
      writeAtomic(layout.pendingPath, renderPendingDocument(next))
      writeAtomic(layout.pendingMarkdownPath, renderPendingMarkdown(next))
    }
  } catch (failure) {
    return refused('failed', `could not drop the selection: ${failureMessage(failure)}`)
  }
  return { status: 'discarded', discarded: dropped.length, remaining: remaining.length }
}

/**
 * Read and validate the queue one action was aimed at.
 * @param deps - the plugin wiring the queue lives behind.
 * @param request - the generation the caller read.
 * @returns the parsed queue, or the failure to report.
 */
function readQueue(deps: MemoryDeps, request: ReviewRequest): { entry: PendingDigest } | ReviewFailure {
  if (!deps.isEnabled()) return refused('disabled', 'Memory is off; run /memory enable first')
  const layout = digestLayout(deps.config.memoryDir)
  const read = readPending(layout.pendingPath)
  if (read.status === 'none') return refused('no-pending', 'there is no pending digest to review')
  if (read.status === 'invalid') return refused('unreadable', read.reason)
  if (request.expectedScanTo !== undefined && request.expectedScanTo !== read.entry.scan_to) {
    return refused('stale', 'the pending queue changed since it was read; reload the page and choose again')
  }
  return { entry: read.entry }
}

/**
 * Turn one stored queue into the display form, naming each source's project.
 * @param deps - the plugin wiring the registry lives behind.
 * @param entry - the parsed pending document.
 * @returns the queue as the page renders it.
 */
function describePending(deps: MemoryDeps, entry: PendingDigest): ReviewPending {
  const projects = projectNames(deps)
  return {
    created_at: entry.created_at,
    scan_from: entry.scan_from,
    scan_to: entry.scan_to,
    ...entry.model === undefined ? {} : { model: entry.model },
    ...entry.usage === undefined ? {} : { usage: entry.usage },
    candidates: entry.candidates.map((candidate, index) => ({
      index: index + 1,
      title: candidate.title,
      content: candidate.content,
      sources: candidate.derived_from.map(source => {
        const project = projects.get(source.project_id)
        return {
          project_id: source.project_id,
          project: project?.name ?? source.project_id,
          project_root: project?.root ?? null,
          record_id: source.record_id,
        }
      }),
    })),
    rejected: (entry.rejected ?? []).map(rejected => ({
      title: rejected.title === undefined || rejected.title === '' ? '(no title)' : rejected.title,
      reason: rejected.reason,
      ...rejected.workspaces === undefined ? {} : { workspaces: rejected.workspaces },
    })),
  }
}

/**
 * Name every registered project, so a candidate's sources read as project names.
 * @param deps - the plugin wiring the registry lives behind.
 * @returns project id to short name and canonical root; empty when the registry is unreadable.
 */
function projectNames(deps: MemoryDeps): Map<string, { name: string; root: string }> {
  const names = new Map<string, { name: string; root: string }>()
  try {
    for (const project of readRegistry(deps.registry.registryPath).projects) {
      names.set(project.project_id, { name: basename(project.canonical_root) || project.project_id, root: project.canonical_root })
    }
  } catch (failure) {
    // A broken registry only costs the display names; the queue still reads and applies by id.
    deps.logger.warn(`dsh-reflection: could not name the digest sources: ${failureMessage(failure)}`)
  }
  return names
}

/**
 * Validate a selection against the queue.
 * @param value - the request field, as sent.
 * @param total - how many candidates the queue holds.
 * @returns the chosen 1-based numbers in dispatch order, or undefined when the selection is unusable.
 */
function normalizeSelection(value: unknown, total: number): number[] | undefined {
  if (value === undefined || value === null) return total === 0 ? undefined : Array.from({ length: total }, (_unused, index) => index + 1)
  if (!Array.isArray(value) || value.length === 0) return undefined
  const chosen = new Set<number>()
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > total) return undefined
    chosen.add(item)
  }
  return [...chosen].sort((left, right) => left - right)
}

/**
 * The message one invalid selection reports.
 * @param total - how many candidates the queue holds.
 * @returns the user-facing sentence.
 */
function selectionMessage(total: number): string {
  return total === 0 ? 'the pending queue holds no candidates' : `a selection must name candidates between 1 and ${String(total)}`
}

/**
 * Render the archive of one discard decision.
 * @param dropped - the candidates removed from the queue.
 * @param entry - the queue they came from.
 * @param at - the decision time, ISO-8601.
 * @returns the file content.
 */
function renderDiscarded(dropped: PendingDigest['candidates'], entry: PendingDigest, at: string): string {
  return `${JSON.stringify({ version: 1, discarded_at: at, scan_from: entry.scan_from, scan_to: entry.scan_to, candidates: dropped }, null, 2)}\n`
}

/**
 * Build one review failure.
 * @param code - the failed step.
 * @param message - the user-facing reason.
 * @returns the failure result.
 */
function refused(code: ReviewFailureCode, message: string): ReviewFailure {
  return { status: 'error', code, message }
}
