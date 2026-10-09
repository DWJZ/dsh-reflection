/**
 * The Session records this plugin owns, declared to the harness's plugin record
 * map.
 *
 * `appendPluginRecord()` types each record name and its payload from this map, so
 * the appended payload and the trajectory row that folds it stay described by one
 * declaration. Record names carry the `plugin:` namespace the harness reserves
 * for ignorable records: a reader that does not know a name retains and skips it,
 * and a record never enters the model-visible surface. These records are audit
 * echoes — `$DSH_HOME/memory` holds the authoritative store, so losing one to a
 * format migration costs a displayed row, not a fact.
 *
 * Declaring them is also what keeps this file a module: only a module augments
 * the map, where a script would declare an ambient one.
 */

import type { ProjectEntry, ProjectMatch } from './identity.js'
import type { RunAudit } from '../consolidation/index.js'
import type { PluginRecordMap, PluginRecordType } from '@deepseek-ai/dsh-session/types'

/** Payload of one project attribution record: how a Session was matched to a project. */
export interface ProjectRecord {
  readonly project_id: ProjectEntry['project_id']
  readonly canonical_root: ProjectEntry['canonical_root']
  /** The harness workspace containing the directory, when one matched. */
  readonly workspace_id: string | null
  /** Which lookup decided the attribution. */
  readonly matched_by: ProjectMatch
}

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:dsh-reflection/project': ProjectRecord
    'plugin:dsh-reflection/consolidation': RunAudit
  }
}

declare module '@deepseek-ai/dsh-session' {
  /**
   * Write one of this plugin's records.
   *
   * The harness declares this writer over its own `Session`. This plugin holds a
   * Session through the `MemorySession` subset in `types/harness.d.ts`, so this
   * overload restates the call over that subset; the value behind it is the
   * harness's Session, and the record name and payload still come from the map
   * above.
   * @param session - the Session whose log receives the record.
   * @param type - declared record name.
   * @param data - JSON payload, snapshotted before it enters the log.
   * @returns the sequence number of the committed record.
   */
  export function appendPluginRecord<K extends Extract<keyof PluginRecordMap, PluginRecordType>>(
    session: MemorySession,
    type: K,
    data: PluginRecordMap[K],
  ): unknown
}
