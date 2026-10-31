/**
 * Priority suite: confidence decides the starting decay scale, the power law
 * leaves a long tail, and access nudges stability by a small amount.
 *
 * Usage: `node --import tsx/esm test/priority.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { memoryRecord } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const priority = await import(pathToFileURL(join(PLUGIN, 'src/priority.ts')).href)
const { searchRecords } = await import(pathToFileURL(join(PLUGIN, 'src/retrieval.ts')).href)
const { buildSummaryPrompt } = await import(pathToFileURL(join(PLUGIN, 'src/summary.ts')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 86_400_000
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString()

console.log('stability starts from confidence')
{
  const low = priority.initialStability(0.5)
  const mid = priority.initialStability(0.8)
  const high = priority.initialStability(1)
  check('higher confidence has a longer stability', low < mid && mid < high, `${String(low)} / ${String(mid)} / ${String(high)}`)
  check('the scale is bounded', priority.initialStability(-1) === priority.MIN_STABILITY_DAYS && priority.initialStability(2) === 180)
  check('a confident record starts around six months', high === 180, String(high))
}

console.log('the power law has a long tail')
{
  const record = memoryRecord({ confidence: 0.8, updated_at: iso(0) })
  const fresh = priority.retrievability(record, NOW)
  const atStability = priority.retrievability({ ...record, last_access_at: iso(priority.stabilityDays(record)) }, NOW)
  const old = priority.retrievability({ ...record, last_access_at: iso(priority.stabilityDays(record) * 10) }, NOW)
  check('a fresh record is fully retrievable', Math.abs(fresh - 1) < 1e-9)
  check('one stability period is the half-life', Math.abs(atStability - 0.5) < 1e-9, String(atStability))
  check('ten periods still leave a tail', old > 0.05 && old < 0.2, String(old))
}

console.log('priority orders by confidence and age')
{
  const confident = memoryRecord({ id: 'mem_confident', confidence: 1, updated_at: iso(0) })
  const unsure = memoryRecord({ id: 'mem_unsure', confidence: 0.5, updated_at: iso(0) })
  const old = memoryRecord({ id: 'mem_old', confidence: 1, updated_at: iso(200) })
  check('confidence raises priority', priority.priority(confident, NOW) > priority.priority(unsure, NOW))
  check('age lowers priority', priority.priority(confident, NOW) > priority.priority(old, NOW))
}

console.log('access is a small stability nudge')
{
  const record = memoryRecord({ confidence: 0.8, updated_at: iso(0) })
  const after = { ...record, ...priority.accessUpdate(record, 1, iso(0)) }
  check('one strong access increments the count', after.access_count === 1)
  check('one access grows stability by about one percent',
    after.stability_days > priority.stabilityDays(record) && after.stability_days < priority.stabilityDays(record) * 1.02)
  const weak = { ...record, ...priority.accessUpdate(record, 0.25, iso(0)) }
  check('a search hit is weaker than a read', weak.stability_days < after.stability_days)
  check('stability is capped', priority.accessUpdate({ ...record, stability_days: 365 }, 100, iso(0)).stability_days === 365)
}

console.log('search and summary use the same priority')
{
  const records = [
    memoryRecord({ id: 'mem_high', title: 'high', content: 'pnpm build', confidence: 1, updated_at: iso(0) }),
    memoryRecord({ id: 'mem_low', title: 'low', content: 'pnpm build', confidence: 0.5, updated_at: iso(0) }),
  ]
  const found = searchRecords(records, { query: 'pnpm', topK: 2, now: NOW })
  check('search puts the confident record first', found.results[0]?.id === 'mem_high', JSON.stringify(found.results))
  const prompt = buildSummaryPrompt({ records, scopeLabel: 'user', budgetBytes: 2000, now: NOW })
  check('summary puts the confident record first', prompt.indexOf('high') < prompt.indexOf('low'))
}

console.log('all confidence levels are eligible')
{
  const low = memoryRecord({ id: 'mem_low_conf', title: '低置信', content: '低置信 pnpm', confidence: 0.2, updated_at: iso(0) })
  const found = searchRecords([low], { query: 'pnpm', topK: 1, now: NOW })
  check('a low-confidence record is still searchable', found.results.length === 1)
  const prompt = buildSummaryPrompt({ records: [low], scopeLabel: 'user', budgetBytes: 2000, now: NOW })
  check('a low-confidence record is still summarised', prompt.includes('低置信'))
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
