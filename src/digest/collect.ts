/**
 * The project summaries one digest run consumes.
 *
 * Only moves since the checkpoint matter: a project whose summary was generated
 * after it, plus that project's active records for the expansion step.
 *
 * @module dsh-reflection/digest/collect
 */

import { readStore } from '../jsonstore.js'
import { readRegistry } from '../registry.js'
import { readSummaryDocument } from '../summary.js'
import type { CachedSummary } from '../summary.js'
import type { MemoryDeps } from '../types/deps.js'
import type { MemoryRecord } from '../types/memory.js'

/** One project summary inside a digest window. */
export interface DigestScope {
  /** The project the summary belongs to. */
  projectId: string
  /** The model-written summary. */
  summary: CachedSummary
  /** The project's active records, available for expansion. */
  records: MemoryRecord[]
}

/**
 * Collect the project summaries updated since one checkpoint.
 * @param deps - command wiring: registry and scope layouts.
 * @param since - exclusive lower bound, ISO-8601; undefined to take every summary.
 * @returns one entry per project whose summary moved, in registry order.
 */
export function collectScopes(deps: MemoryDeps, since: string | undefined): DigestScope[] {
  const projects = readRegistry(deps.registry.registryPath).projects
  const scopes: DigestScope[] = []
  for (const entry of projects) {
    const layout = deps.scopes.project(entry.project_id)
    const summary = readSummaryDocument(layout.summaryPath)
    if (summary === undefined) continue
    if (since !== undefined && summary.generated_at <= since) continue
    scopes.push({
      projectId: entry.project_id,
      summary,
      records: readStore(layout.storePath).records.filter(record => record.status === 'active'),
    })
  }
  return scopes
}
