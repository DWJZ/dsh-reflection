/**
 * The digest's Session audit records.
 *
 * Counts, ids, and the scan window only: the candidates' text already lives in
 * the pending file, and the Session log should not carry a second copy.
 *
 * @module dsh-reflection/digest/types
 */

import type { ConsolidationUsage } from '../consolidation/model.js'

/** One digest run, as recorded in the Session log. */
export interface DigestRunAudit {
  kind: 'run'
  /** When the run started, ISO-8601. */
  at: string
  /** Exclusive lower bound of the summary window, or null for every summary. */
  scan_from: string | null
  /** Scan time, ISO-8601. */
  scan_to: string
  /** The project summaries that entered the run. */
  projects: { project_id: string; summary_revision: number; summary_generated_at: string }[]
  /** Record ids the model asked to read. */
  expanded: string[]
  /** Accepted candidates. */
  candidates: number
  /** Candidates dropped by validation. */
  rejected: number
  /** Why each was dropped, with the candidate title when one existed. */
  rejected_details?: { reason: string; title?: string | undefined; workspaces?: number | undefined }[] | undefined
  /** Provider/model of the synthesis call. */
  model?: string | undefined
  /** Token usage of the calls. */
  usage?: ConsolidationUsage | undefined
}

/** One apply, as recorded in the Session log. */
export interface DigestApplyAudit {
  kind: 'apply'
  /** When the apply started, ISO-8601. */
  at: string
  /** The candidates that became user records. */
  applied: { index: number; title: string; record_id: string }[]
  /** Project record ids archived because they were promoted. */
  archived: string[]
  /** Sources that were already out of service. */
  skipped: number
  /** Candidates left in pending. */
  remaining: number
}

/** The digest Session record payload. */
export type DigestAudit = DigestRunAudit | DigestApplyAudit

/** The Session record type this plugin appends for digest work. */
export const DIGEST_EVENT_TYPE = 'plugin:dsh-reflection/digest'
