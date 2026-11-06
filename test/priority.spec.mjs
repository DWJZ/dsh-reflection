/**
 * Score suite: confidence sets the starting half-life, confirmed use slows the
 * decay, and access alone changes nothing that ranking reads.
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

/** One active record with an effective time some days before NOW. */
const at = (daysAgo, overrides = {}) => memoryRecord({ confidence: 0.8, last_effective_at: iso(daysAgo), ...overrides })

console.log('the half-life starts from confidence')
{
  const low = priority.initialStability(0.5)
  const mid = priority.initialStability(0.8)
  const high = priority.initialStability(1)
  check('higher confidence has a longer half-life', low < mid && mid < high, `${String(low)} / ${String(mid)} / ${String(high)}`)
  check('the scale is bounded', priority.initialStability(-1) === priority.MIN_STABILITY_DAYS && priority.initialStability(2) === 180)
  check('a confident record starts around six months', high === 180, String(high))
}

console.log('confirmed use lengthens the half-life')
{
  const base = at(0)
  const used = at(0, { effective_count: 20 })
  const heavy = at(0, { effective_count: 100_000 })
  check('one record, one hour', priority.halfLifeDays(base) === priority.initialStability(base.confidence))
  check('twenty confirmations grow it by about a fifth',
    priority.halfLifeDays(used) > priority.halfLifeDays(base) * 1.15
    && priority.halfLifeDays(used) < priority.halfLifeDays(base) * 1.25,
    `${String(priority.halfLifeDays(base))} -> ${String(priority.halfLifeDays(used))}`)
  check('the growth is capped', priority.halfLifeDays(heavy) === priority.MAX_STABILITY_DAYS)
}

console.log('the score decays from the last effective time')
{
  const fresh = at(0)
  const halfLife = priority.halfLifeDays(fresh)
  check('a fresh record scores its confidence', Math.abs(priority.score(fresh, NOW) - fresh.confidence) < 1e-9)
  const atHalf = at(halfLife)
  check('one half-life halves the score', Math.abs(priority.score(atHalf, NOW) - fresh.confidence / 2) < 1e-9, String(priority.score(atHalf, NOW)))
  const old = at(halfLife * 4)
  check('four half-lives leave a sixteenth', Math.abs(priority.score(old, NOW) - fresh.confidence / 16) < 1e-9, String(priority.score(old, NOW)))
  check('the score stays inside [0, 1]',
    priority.score(at(10_000, { confidence: 1, effective_count: 1 }), NOW) >= 0
    && priority.score(at(0, { confidence: 1 }), NOW) <= 1)
}

console.log('confirmed use is what keeps a record scoring high')
{
  const used = at(90, { effective_count: 40 })
  const unused = at(90)
  check('after the same age, the confirmed record scores higher',
    priority.score(used, NOW) > priority.score(unused, NOW),
    `${String(priority.score(used, NOW))} > ${String(priority.score(unused, NOW))}`)
  check('higher confidence keeps a higher score', priority.score(at(30, { confidence: 0.9 }), NOW) > priority.score(at(30, { confidence: 0.5 }), NOW))
}

console.log('the effective time falls back through existing timestamps')
{
  const explicitEffective = memoryRecord({ last_effective_at: iso(1), last_feedback_at: iso(5), last_access_at: iso(9), updated_at: iso(30) })
  const feedbackOnly = memoryRecord({ last_feedback_at: iso(5), last_access_at: iso(9), updated_at: iso(30) })
  const accessOnly = memoryRecord({ last_access_at: iso(9), updated_at: iso(30) })
  const created = memoryRecord({ updated_at: iso(30) })
  check('last_effective_at wins', priority.effectiveAt(explicitEffective) === iso(1))
  check('then last_feedback_at', priority.effectiveAt(feedbackOnly) === iso(5))
  check('then last_access_at', priority.effectiveAt(accessOnly) === iso(9))
  check('then updated_at', priority.effectiveAt(created) === iso(30))
}

console.log('access is diagnostic only')
{
  const record = at(10)
  const before = priority.score(record, NOW)
  const after = { ...record, ...priority.accessUpdate(record, 1, iso(0)) }
  check('the access count moved', after.access_count === (record.access_count ?? 0) + 1)
  check('the score did not', priority.score(after, NOW) === before)
}

console.log('search and summary order by the same score')
{
  const records = [
    memoryRecord({ id: 'mem_high', title: 'high', content: 'pnpm build', confidence: 0.9, last_effective_at: iso(0) }),
    memoryRecord({ id: 'mem_low', title: 'low', content: 'pnpm build', confidence: 0.5, last_effective_at: iso(0) }),
  ]
  const found = searchRecords(records, { query: 'pnpm', topK: 2, now: NOW })
  check('search puts the higher score first', found.results[0]?.id === 'mem_high', JSON.stringify(found.results))
  const prompt = buildSummaryPrompt({ records, scopeLabel: 'user', budgetBytes: 2000, now: NOW })
  check('summary puts the higher score first', prompt.indexOf('high') < prompt.indexOf('low'))
}

console.log('a confirmed record outranks a never-confirmed one in search')
{
  const records = [
    memoryRecord({ id: 'mem_used', title: 'used', content: 'pnpm build', confidence: 0.8, effective_count: 20, last_effective_at: iso(90) }),
    memoryRecord({ id: 'mem_cold', title: 'cold', content: 'pnpm build', confidence: 0.8, last_effective_at: iso(90) }),
  ]
  const found = searchRecords(records, { query: 'pnpm', topK: 2, now: NOW })
  check('the confirmed record comes first', found.results[0]?.id === 'mem_used', JSON.stringify(found.results))
}

console.log('the score threshold filters the summary')
{
  const records = [
    memoryRecord({ id: 'mem_fresh', title: 'fresh', content: 'pnpm build', confidence: 0.9, last_effective_at: iso(0) }),
    memoryRecord({ id: 'mem_stale', title: 'stale', content: 'pnpm build', confidence: 0.9, last_effective_at: iso(1000) }),
  ]
  const prompt = buildSummaryPrompt({ records, scopeLabel: 'user', budgetBytes: 2000, minScore: 0.5, now: NOW })
  check('the fresh record is described', prompt.includes('fresh'))
  check('the stale record is not', !prompt.includes('stale'))
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
