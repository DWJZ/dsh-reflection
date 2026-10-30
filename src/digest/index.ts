/**
 * The manual cross-project digest.
 *
 * Reads the project summaries that moved since the checkpoint, lets the model
 * read a few records, and writes pending candidates. It never writes Memory: the
 * pending file is what a person reviews before an apply.
 *
 * @module dsh-reflection/digest
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { digestLayout } from '../paths.js'
import { writeAtomic } from '../jsonstore.js'
import { streamModelText } from '../consolidation/model.js'
import type { ConsolidationUsage } from '../consolidation/model.js'
import { collectScopes } from './collect.js'
import { DIGEST_SYSTEM, expansionPrompt, parseCandidates, parseExpansion, synthesisPrompt } from './prompt.js'
import type { DigestCandidate } from './prompt.js'
import type { ExpandedRecord } from './prompt.js'
import { renderPendingDocument, renderPendingMarkdown } from './pending.js'
import type { PendingDigest } from './pending.js'
import { defaultSince, readDigestState, writeDigestState } from './state.js'
import type { MemoryDeps } from '../types/deps.js'
import { failureMessage } from '../errors.js'

/** What one digest invocation produced. */
export type DigestResult =
  | { status: 'nothing-new'; since: string | undefined }
  | {
    status: 'proposed'
    since: string | undefined
    to: string
    candidates: number
    rejected: number
    pendingPath: string
    preview: DigestCandidate[]
  }
  | { status: 'error'; message: string }

/**
 * Run one digest for the agent whose route the calls reuse.
 * @param deps - command wiring: registry, scopes, logger, clock, and LLM scope.
 * @param agent - the Session whose model route the calls reuse.
 * @param options - `force` ignores the checkpoint and takes every summary.
 * @returns what the run produced.
 */
export async function runDigest(
  deps: MemoryDeps,
  agent: MemoryAgent,
  options: { force?: boolean } = {},
): Promise<DigestResult> {
  const llm = deps.llmScope()
  if (llm === undefined) return { status: 'error', message: 'no model service is mounted, so the digest has nothing to ask' }
  const session = agent?.session
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { status: 'error', message: 'the digest needs a Session with a resolved model route' }
  }
  const nowMs = (deps.now ?? Date.now)()
  const now = new Date(nowMs).toISOString()
  const layout = digestLayout(deps.config.memoryDir)
  const state = readDigestState(layout.statePath)
  const since = options.force === true ? undefined : state.lastScanAt ?? defaultSince(nowMs)
  const scopes = collectScopes(deps, since)
  if (scopes.length === 0) return { status: 'nothing-new', since }
  if (options.force !== true && existsSync(layout.pendingPath)) {
    return { status: 'error', message: 'a pending digest already exists; review and apply it, or rerun with --force to replace it' }
  }

  const ask = (prompt: string) => streamModelText(llm, {
    session,
    sessionId,
    system: DIGEST_SYSTEM,
    prompt,
    label: 'digest',
  })
  const usages: (ConsolidationUsage | undefined)[] = []
  const allowedIds = new Set(scopes.flatMap(scope => scope.records.map(record => record.id)))
  const phaseOnePrompt = expansionPrompt(scopes, since, now)
  let phaseOne = await ask(phaseOnePrompt)
  usages.push(phaseOne.usage)
  let expand: string[]
  try {
    expand = parseExpansion(phaseOne.text, allowedIds)
  } catch (failure) {
    phaseOne = await ask(`${phaseOnePrompt}\n\nYour previous answer was not valid JSON: ${failureMessage(failure).slice(0, 120)}\nReturn only {"expand":[...]}.`)
    usages.push(phaseOne.usage)
    expand = parseExpansion(phaseOne.text, allowedIds)
  }
  const expanded: ExpandedRecord[] = []
  for (const scope of scopes) {
    for (const record of scope.records) {
      if (expand.includes(record.id)) expanded.push({ projectId: scope.projectId, record })
    }
  }
  const synthesisBase = synthesisPrompt(scopes, expanded, since, now)
  const allowedSources = new Set(scopes.flatMap(scope => scope.records.map(record => `${scope.projectId}/${record.id}`)))
  let phaseTwo = await ask(synthesisBase)
  usages.push(phaseTwo.usage)
  let checked
  try {
    checked = parseCandidates(phaseTwo.text, allowedSources)
  } catch (failure) {
    // Keep the raw answer for diagnosis; a truncated or malformed plan is the
    // common failure when the provider caps output, and the retry asks for less.
    writeAtomic(join(layout.dir, 'last-answer.txt'), phaseTwo.text)
    phaseTwo = await ask(`${synthesisBase}\n\nYour previous answer was not valid JSON: ${failureMessage(failure).slice(0, 120)}\nReturn one compact JSON object only, at most 6 candidates, each content under 200 characters, escaped quotes, no fences.`)
    usages.push(phaseTwo.usage)
    checked = parseCandidates(phaseTwo.text, allowedSources)
  }
  const usage = sumUsage(phaseOne.usage, phaseTwo.usage)
  const pending: PendingDigest = {
    version: 1,
    created_at: now,
    scan_from: since ?? null,
    scan_to: now,
    model: `${phaseTwo.provider}/${phaseTwo.model}`,
    ...usage === undefined ? {} : { usage },
    candidates: checked.accepted,
  }
  writeAtomic(layout.pendingPath, renderPendingDocument(pending))
  writeAtomic(layout.pendingMarkdownPath, renderPendingMarkdown(pending))
  writeDigestState(layout.statePath, { lastScanAt: now })
  deps.logger.info?.(`dsh-reflection: digest proposed ${String(checked.accepted.length)} candidate(s) in ${layout.pendingPath}`)
  return {
    status: 'proposed',
    since,
    to: now,
    candidates: checked.accepted.length,
    rejected: checked.rejected.length,
    pendingPath: layout.pendingPath,
    preview: checked.accepted,
  }
}

/**
 * Add two calls' usage.
 * @param left - first call usage.
 * @param right - second call usage.
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
