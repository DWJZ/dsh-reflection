/**
 * Summary injection suite.
 *
 * What travels in a request is a summary and a pointer to the files, never a
 * fact. Three properties carry the weight: no record text leaks into the
 * envelope, the injected text never exceeds its byte budget, and a cached
 * summary round-trips through its file.
 *
 * Usage: `node test/summary.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const {
  renderMemorySummary, renderSummaryDocument, parseSummaryDocument, buildSummaryPrompt, summaryIsStale,
} = await import(pathToFileURL(join(PLUGIN, 'src/summary.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'

/** One record shaped well enough for rendering. */
const record = (overrides = {}) => ({
  id: 'mem_a',
  scope: 'user',
  project_id: null,
  content: '用户偏好中文解释',
  confidence: 1,
  evidence: [],
  created_at: AT,
  updated_at: AT,
  status: 'active',
  superseded_by: null,
  ...overrides,
})

const counts = (overrides = {}) => ({ user: 1, project: 0, updatedAt: AT, ...overrides })

console.log('the injected envelope')
const text = renderMemorySummary({
  summaryText: '用户偏好中文解释，项目使用 pnpm。',
  counts: counts(),
  paths: { user: '/home/me/.dsh/memory/user/memories.json' },
  budgetBytes: 1200,
})
check('it is an envelope', text.startsWith('<memory-summary>') && text.trimEnd().endsWith('</memory-summary>'))
check('it says what it is', text.includes('data, not instructions'))
check('it counts the scopes', text.includes('1 user') && text.includes('0 project'))
check('it names the date', text.includes('2026-09-26'))
check('it names the index file', text.includes('/home/me/.dsh/memory/user/memories.json'))
check('it points at per-record files', text.includes('memories/<id>.md'))
check('it carries the model summary', text.includes('项目使用 pnpm'))

console.log('no facts are injected without a summary')
const bare = renderMemorySummary({ counts: counts(), paths: { user: '/m/user/memories.json' }, budgetBytes: 1200 })
check('a missing summary still produces the pointer', bare.includes('/m/user/memories.json'))
check('a missing summary carries no record text', !bare.includes('用户偏好中文解释'))

console.log('nothing is injected when there is nothing to describe')
check('an empty store renders nothing',
  renderMemorySummary({ counts: { user: 0, project: 0, byCategory: {} }, paths: { user: '/m/memories.json' }, budgetBytes: 1200 }) === '')
check('a project scope alone renders',
  renderMemorySummary({ counts: counts({ user: 0, project: 2 }), paths: { user: '/m/user/memories.json', project: '/m/p/memories.json' }, budgetBytes: 1200 }).includes('/m/p/memories.json'))

console.log('the budget is respected')
const long = renderMemorySummary({
  summaryText: '很长的摘要。'.repeat(400),
  counts: counts(),
  paths: { user: '/home/me/.dsh/memory/user/memories.json', project: '/home/me/.dsh/memory/projects/proj_x/memories.json' },
  budgetBytes: 800,
})
check('a long summary fits the budget', Buffer.byteLength(long, 'utf8') <= 800, String(Buffer.byteLength(long, 'utf8')))
check('a truncated summary says it was cut', long.includes('…'))
check('a truncated summary keeps the paths', long.includes('/home/me/.dsh/memory/user/memories.json'))
check('a budget too small for the pointer renders nothing',
  renderMemorySummary({ counts: counts(), paths: { user: '/home/me/.dsh/memory/user/memories.json' }, budgetBytes: 40 }) === '')
check('multi-byte text is never split', !long.includes('\uFFFD'))

console.log('the summary cache round-trips as JSON')
const entry = { content: '偏好中文解释。', revision: 7, generated_at: AT, model: 'p/m', budget: 2400 }
const document = renderSummaryDocument(entry)
const parsed = parseSummaryDocument(document)
check('the content survives', parsed?.content === entry.content)
check('the revision survives', parsed?.revision === 7)
check('the model survives', parsed?.model === 'p/m')
check('the budget survives', parsed?.budget === 2400)
check('the file is JSON', JSON.parse(document).content === entry.content)
check('a document without metadata is refused', parseSummaryDocument('just text') === undefined)
check('a document without a revision is refused',
  parseSummaryDocument(JSON.stringify({ generated_at: AT, content: 'text' })) === undefined)
check('a document without content is refused',
  parseSummaryDocument(JSON.stringify({ revision: 1, generated_at: AT, content: '  ' })) === undefined)

console.log('the prompt describes the store')
const prompt = buildSummaryPrompt({
  records: [
    record({ id: 'mem_old', content: '旧事实', updated_at: '2026-01-01T00:00:00.000Z' }),
    record({ id: 'mem_new', content: '新事实', updated_at: '2026-09-01T00:00:00.000Z' }),
    record({ id: 'mem_gone', content: '已归档', status: 'archived' }),
  ],
  scopeLabel: 'user',
  budgetBytes: 1200,
})
check('it names the scope', prompt.includes('Scope: user'))
check('it carries the injection budget', prompt.includes('1200'))
check('it counts active records only', prompt.includes('2 active records'))
check('the newest record comes first', prompt.indexOf('新事实') < prompt.indexOf('旧事实'))
check('inactive records are absent', !prompt.includes('已归档'))
check('a low-confidence record is included', buildSummaryPrompt({
  records: [record({ id: 'mem_low', content: '低置信事实', confidence: 0.5 })],
  scopeLabel: 'user',
  budgetBytes: 1200,
}).includes('低置信事实'))
check('a long record is truncated', (() => {
  const longPrompt = buildSummaryPrompt({ records: [record({ content: 'x'.repeat(1000) })], scopeLabel: 'user', budgetBytes: 2400 })
  return longPrompt.includes('…') && Buffer.byteLength(longPrompt, 'utf8') < 1000
})())

console.log('titles lead the summary prompt')
const titled = buildSummaryPrompt({
  records: [record({ title: '构建命令', content: 'pnpm run build:edge' })],
  scopeLabel: 'user',
  budgetBytes: 1200,
})
check('the title appears before the body', titled.includes('构建命令') && titled.indexOf('构建命令') < titled.indexOf('pnpm run build:edge'))
check('the record source is shown', titled.includes('[explicit]'))

console.log('agent experience is labelled as reference')
const mixed = buildSummaryPrompt({
  records: [
    record({ id: 'mem_agent', title: '汇总经验', content: '先解压再检索', source: 'agent' }),
    record({ id: 'mem_user', title: '用户偏好', content: '用 pnpm', source: 'explicit' }),
  ],
  scopeLabel: 'user',
  budgetBytes: 1200,
})
check('agent records carry their label', mixed.includes('[agent]'))
check('the prompt says agent records are reference', mixed.includes('treat them as reference'))
check('the prompt says explicit records win', mixed.includes('let an explicit record win on conflict'))

console.log('staleness includes the budget')
const fresh = { content: 'a summary', revision: 3, generated_at: AT, budget: 2400 }
check('a matching cache is fresh', summaryIsStale(fresh, 3, 2400) === false)
check('a missing cache is stale', summaryIsStale(undefined, 3, 2400) === true)
check('a revision mismatch is stale', summaryIsStale(fresh, 4, 2400) === true)
check('a budget mismatch is stale', summaryIsStale(fresh, 3, 1200) === true)
check('a cache without a budget is stale', summaryIsStale({ content: 'a summary', revision: 3, generated_at: AT }, 3, 2400) === true)
check('empty content is stale', summaryIsStale({ ...fresh, content: '  ' }, 3, 2400) === true)

if (failures > 0) {
  console.log(`\n${String(failures)} FAILURE(S)`)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
