/**
 * L1: retrieval regression over a frozen synthetic corpus.
 *
 * Keyless and deterministic: it runs the plugin's own `searchRecords` over a
 * labeled corpus and reports Recall@3 / Recall@8 / MRR / nDCG plus the
 * no-answer false-positive count. It answers "did retrieval get worse", not
 * "is the agent useful" — the behavior suite (run-behavior.mjs) owns that.
 *
 * Usage:
 *   node --import tsx/esm eval/run-retrieval.mjs            # table + report
 *   node --import tsx/esm eval/run-retrieval.mjs --json     # JSON only
 *   node --import tsx/esm eval/run-retrieval.mjs --update-baseline
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderRetrievalReport } from './report.mjs'

const EVAL = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(EVAL, '..')
const DATA = JSON.parse(readFileSync(join(EVAL, 'data/retrieval.json'), 'utf8'))
const BASELINE_PATH = join(EVAL, 'baseline.json')
const REPORT_PATH = join(EVAL, 'report-retrieval.json')
const REPORT_MD = join(EVAL, 'report-retrieval.md')

/** Tolerance below the baseline before a metric counts as a regression. */
const TOLERANCE = 0.03

const { searchRecords } = await import(pathToFileURL(join(PLUGIN, 'src/retrieval.ts')).href)

const PROJECT_IDS = DATA.projects
const records = DATA.records.map(record => ({
  ...record,
  status: 'active',
  project_id: record.scope === 'project' ? PROJECT_IDS[record.project] : null,
  evidence: [],
  project: undefined,
}))

/**
 * Rank one query the way the plugin does, for the project it runs in.
 * @param query - the labeled query.
 * @returns ranked record ids, best first.
 */
function rank(query) {
  const projectId = PROJECT_IDS[query.project]
  return searchRecords(records, { query: query.q, topK: records.length, projectId }).results.map(row => row.id)
}

/**
 * Score one ranked list against its labels.
 * @param ranked - ranked ids.
 * @param targets - expected ids.
 * @returns recall@3, recall@8, reciprocal rank, nDCG@8.
 */
function score(ranked, targets) {
  if (targets.length === 0) return { recall3: null, recall8: null, mrr: null, ndcg: null, top1: ranked[0] ?? null }
  const at = rank => targets.filter(id => ranked.slice(0, rank).includes(id)).length / targets.length
  const first = ranked.findIndex(id => targets.includes(id))
  const dcg = targets.reduce((sum, id) => {
    const index = ranked.slice(0, 8).indexOf(id)
    return index < 0 ? sum : sum + 1 / Math.log2(index + 2)
  }, 0)
  const ideal = targets.slice(0, 8).reduce((sum, _, index) => sum + 1 / Math.log2(index + 2), 0)
  return {
    recall3: at(3),
    recall8: at(8),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg: ideal === 0 ? 0 : dcg / ideal,
    top1: ranked[0] ?? null,
  }
}

const answerable = DATA.queries.filter(query => query.targets.length > 0)
const noAnswer = DATA.queries.filter(query => query.targets.length === 0)
const results = []
for (const query of DATA.queries) {
  const ranked = rank(query)
  results.push({ query: query.q, kind: query.kind, project: query.project, targets: query.targets, ranked: ranked.slice(0, 8), ...score(ranked, query.targets) })
}

const mean = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / (rows.length || 1)
const metrics = {
  recall3: mean(results.filter(row => row.recall3 !== null), 'recall3'),
  recall8: mean(results.filter(row => row.recall8 !== null), 'recall8'),
  mrr: mean(results.filter(row => row.mrr !== null), 'mrr'),
  ndcg: mean(results.filter(row => row.ndcg !== null), 'ndcg'),
  noAnswerFalsePositives: noAnswer.filter(row => row.top1 !== null).length,
  answerable: answerable.length,
  noAnswer: noAnswer.length,
}
const byKind = Object.fromEntries([...new Set(answerable.map(query => query.kind))].map(kind => {
  const rows = results.filter(row => row.kind === kind && row.recall3 !== null)
  return [kind, { n: rows.length, recall3: mean(rows, 'recall3'), mrr: mean(rows, 'mrr') }]
}))

const report = {
  version: 1,
  ...process.env.GITHUB_SHA === undefined ? {} : { gitSha: process.env.GITHUB_SHA },
  dataset: DATA.version,
  metrics,
  byKind,
  results,
}
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : undefined
writeFileSync(REPORT_MD, renderRetrievalReport(report, baseline))
if (process.argv.includes('--update-baseline')) {
  const next = { ...baseline, version: 1, retrieval: metrics }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`baseline updated: ${BASELINE_PATH}`)
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ metrics, byKind }, null, 2))
} else {
  console.log(`retrieval corpus: ${String(metrics.answerable)} answerable + ${String(metrics.noAnswer)} no-answer queries, ${String(records.length)} records`)
  console.log(`recall@3 ${metrics.recall3.toFixed(3)}  recall@8 ${metrics.recall8.toFixed(3)}  MRR ${metrics.mrr.toFixed(3)}  nDCG ${metrics.ndcg.toFixed(3)}  no-answer FP ${String(metrics.noAnswerFalsePositives)}`)
  for (const [kind, row] of Object.entries(byKind)) {
    console.log(`  ${kind.padEnd(9)} n=${String(row.n).padStart(2)}  recall@3 ${row.recall3.toFixed(3)}  MRR ${row.mrr.toFixed(3)}`)
  }
  const misses = results.filter(row => row.recall8 !== null && row.recall8 < 1)
  for (const miss of misses) {
    console.log(`  MISS ${miss.kind.padEnd(9)} "${miss.query}" → ${miss.targets.join(',')} (got ${miss.ranked.slice(0, 3).join(',') || 'none'})`)
  }
}

if (baseline?.retrieval !== undefined && !process.argv.includes('--update-baseline')) {
  const regressions = []
  for (const key of ['recall3', 'recall8', 'mrr', 'ndcg']) {
    const before = baseline.retrieval[key]
    const after = metrics[key]
    if (typeof before === 'number' && after < before - TOLERANCE) {
      regressions.push(`${key}: ${before.toFixed(3)} → ${after.toFixed(3)}`)
    }
  }
  if (typeof baseline.retrieval.noAnswerFalsePositives === 'number'
    && metrics.noAnswerFalsePositives > baseline.retrieval.noAnswerFalsePositives) {
    regressions.push(`no-answer FP: ${String(baseline.retrieval.noAnswerFalsePositives)} → ${String(metrics.noAnswerFalsePositives)}`)
  }
  if (regressions.length > 0) {
    console.error(`\nretrieval regressed beyond ${String(TOLERANCE)}:\n  ${regressions.join('\n  ')}`)
    process.exitCode = 1
  } else if (!process.argv.includes('--json')) {
    console.log('\nwithin baseline tolerance')
  }
}
