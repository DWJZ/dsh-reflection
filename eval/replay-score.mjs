/**
 * Replay the score model over the live Memory stores.
 *
 * This is a calibration aid, not a CI gate: it reads whatever is in
 * `$DSH_HOME/memory` and reports whether the new score separates records the
 * consolidator confirmed from records nobody ever confirmed, and whether the
 * corrected bucket (archived) is gone from service.
 *
 * Usage: `node --import tsx/esm eval/replay-score.mjs`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { userLayout, projectLayout } from '../src/paths.js'
import { readStore } from '../src/jsonstore.js'
import { score } from '../src/priority.js'

const memoryDir = join(homedir(), '.dsh', 'memory')
const now = Date.now()

/** Percentile of a sorted number array. */
const percentile = (values, fraction) => values.length === 0
  ? 0
  : values[Math.min(values.length - 1, Math.floor(fraction * (values.length - 1)))]

const rows = []
const collect = (store, label) => {
  for (const record of store.records) {
    if (record.status !== 'active') continue
    rows.push({
      label,
      id: record.id,
      title: record.title,
      confidence: record.confidence,
      score: score(record, now),
      confirmed: record.feedback_confirmed ?? record.effective_count ?? 0,
      reads: record.access_count ?? 0,
      effectiveAt: record.last_effective_at ?? record.last_feedback_at ?? null,
    })
  }
}

collect(readStore(userLayout(memoryDir).storePath), 'user')
for (const dir of readdirSync(join(memoryDir, 'projects'))) {
  const index = join(memoryDir, 'projects', dir, 'memories.json')
  if (!existsSync(index)) continue
  const first = JSON.parse(readFileSync(index, 'utf8')).records?.[0]
  if (first?.project_id === undefined || first?.project_id === null) continue
  collect(readStore(projectLayout(memoryDir, first.project_id).storePath), first.project_id.slice(0, 12))
}

const active = rows
console.log(`active records: ${String(active.length)}`)
console.log(`score p10/p50/p90: ${percentile(active.map(row => row.score).sort((a, b) => a - b), 0.1).toFixed(3)} / ${percentile(active.map(row => row.score).sort((a, b) => a - b), 0.5).toFixed(3)} / ${percentile(active.map(row => row.score).sort((a, b) => a - b), 0.9).toFixed(3)}`)

const bucket = (row) => row.confirmed > 0 ? 'confirmed' : 'never-confirmed'
for (const name of ['confirmed', 'never-confirmed']) {
  const group = active.filter(row => bucket(row) === name).map(row => row.score).sort((a, b) => a - b)
  if (group.length === 0) continue
  console.log(`${name}: n=${String(group.length)} median=${percentile(group, 0.5).toFixed(3)} p90=${percentile(group, 0.9).toFixed(3)}`)
}

const below = active.filter(row => row.score < 0.5)
console.log(`below the 0.5 summary threshold: ${String(below.length)}`)

const confirmedScores = active.filter(row => row.confirmed > 0).map(row => row.score)
const untouchedScores = active.filter(row => row.confirmed === 0).map(row => row.score)
if (confirmedScores.length > 0 && untouchedScores.length > 0) {
  const confirmedMedian = percentile(confirmedScores.sort((a, b) => a - b), 0.5)
  const untouchedMedian = percentile(untouchedScores.sort((a, b) => a - b), 0.5)
  console.log(`calibration: confirmed median (${confirmedMedian.toFixed(3)}) ${confirmedMedian > untouchedMedian ? '>' : '<='} never-confirmed median (${untouchedMedian.toFixed(3)})`)
}

// A record whose confirmation is old should score lower than an identical fresh
// one; the replay prints the extremes so a bad parameter set is visible.
const worst = [...active].sort((left, right) => left.score - right.score).slice(0, 3)
for (const row of worst) console.log(`low: ${row.score.toFixed(3)} confidence=${row.confidence} confirmed=${row.confirmed} ${row.title.slice(0, 40)}`)
