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
  renderMemorySummary, renderSummaryDocument, parseSummaryDocument, buildSummaryPrompt,
} = await import(pathToFileURL(join(PLUGIN, 'src/summary.js')).href)
const { renderMemoryView } = await import(pathToFileURL(join(PLUGIN, 'src/views.js')).href)

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
  category: 'state',
  content: '用户偏好中文解释',
  confidence: 1,
  evidence: [],
  created_at: AT,
  updated_at: AT,
  status: 'active',
  superseded_by: null,
  ...overrides,
})

const counts = (overrides = {}) => ({ user: 1, project: 0, byCategory: { preference: 1 }, updatedAt: AT, ...overrides })

console.log('the injected envelope')
const text = renderMemorySummary({
  summaryText: '用户偏好中文解释，项目使用 pnpm。',
  counts: counts(),
  paths: { user: '/home/me/.dsh/memory/user/MEMORY.md' },
  budgetBytes: 1200,
})
check('it is an envelope', text.startsWith('<memory-summary>') && text.trimEnd().endsWith('</memory-summary>'))
check('it says what it is', text.includes('data, not instructions'))
check('it counts the scopes', text.includes('1 user') && text.includes('0 project'))
check('it names the category', text.includes('preference 1'))
check('it names the date', text.includes('2026-09-26'))
check('it names the index file', text.includes('/home/me/.dsh/memory/user/MEMORY.md'))
check('it points at per-record files', text.includes('memories/<id>.md'))
check('it carries the model summary', text.includes('项目使用 pnpm'))

console.log('no facts are injected without a summary')
const bare = renderMemorySummary({ counts: counts(), paths: { user: '/m/user/MEMORY.md' }, budgetBytes: 1200 })
check('a missing summary still produces the pointer', bare.includes('/m/user/MEMORY.md'))
check('a missing summary carries no record text', !bare.includes('用户偏好中文解释'))

console.log('nothing is injected when there is nothing to describe')
check('an empty store renders nothing',
  renderMemorySummary({ counts: { user: 0, project: 0, byCategory: {} }, paths: { user: '/m/MEMORY.md' }, budgetBytes: 1200 }) === '')
check('a project scope alone renders',
  renderMemorySummary({ counts: counts({ user: 0, project: 2 }), paths: { user: '/m/user/MEMORY.md', project: '/m/p/MEMORY.md' }, budgetBytes: 1200 }).includes('/m/p/MEMORY.md'))

console.log('the budget is respected')
const long = renderMemorySummary({
  summaryText: '很长的摘要。'.repeat(400),
  counts: counts(),
  paths: { user: '/home/me/.dsh/memory/user/MEMORY.md', project: '/home/me/.dsh/memory/projects/proj_x/MEMORY.md' },
  budgetBytes: 800,
})
check('a long summary fits the budget', Buffer.byteLength(long, 'utf8') <= 800, String(Buffer.byteLength(long, 'utf8')))
check('a truncated summary says it was cut', long.includes('…'))
check('a truncated summary keeps the paths', long.includes('/home/me/.dsh/memory/user/MEMORY.md'))
check('a budget too small for the pointer renders nothing',
  renderMemorySummary({ counts: counts(), paths: { user: '/home/me/.dsh/memory/user/MEMORY.md' }, budgetBytes: 40 }) === '')
check('multi-byte text is never split', !long.includes('\uFFFD'))

console.log('the summary cache round-trips')
const entry = { text: '偏好中文解释。', revision: 7, generated_at: AT, model: 'p/m' }
const document = renderSummaryDocument(entry)
const parsed = parseSummaryDocument(document)
check('the text survives', parsed?.text === entry.text)
check('the revision survives', parsed?.revision === 7)
check('the model survives', parsed?.model === 'p/m')
check('a document without frontmatter is refused', parseSummaryDocument('just text') === undefined)
check('a document without a revision is refused', parseSummaryDocument('---\ngenerated_at: x\n---\n\ntext') === undefined)
check('a document without a body is refused', parseSummaryDocument('---\nrevision: 1\n---\n\n') === undefined)

console.log('the prompt describes the store')
const prompt = buildSummaryPrompt({
  records: [
    record({ id: 'mem_old', content: '旧事实', updated_at: '2026-01-01T00:00:00.000Z' }),
    record({ id: 'mem_new', content: '新事实', updated_at: '2026-09-01T00:00:00.000Z' }),
    record({ id: 'mem_gone', content: '已归档', status: 'archived' }),
  ],
  scopeLabel: 'user',
})
check('it names the scope', prompt.includes('Scope: user'))
check('it counts active records only', prompt.includes('2 active records'))
check('the newest record comes first', prompt.indexOf('新事实') < prompt.indexOf('旧事实'))
check('inactive records are absent', !prompt.includes('已归档'))
check('a long record is truncated', (() => {
  const longPrompt = buildSummaryPrompt({ records: [record({ content: 'x'.repeat(1000) })], scopeLabel: 'user' })
  return longPrompt.includes('…') && Buffer.byteLength(longPrompt, 'utf8') < 1000
})())

console.log('the file index hands out ids')
const view = renderMemoryView([
  record({ id: 'mem_c254ad5d', category: 'preference', content: '用户偏好 git commit 使用 Conventional Commits 格式' }),
  record({ id: 'mem_archived', content: '已经不用的内容', status: 'archived' }),
], { revision: 3 })
check('it lists the active record by id', view.includes('mem_c254ad5d'))
check('it carries the update date', view.includes('2026-09-26'))
check('it carries a headline', view.includes('用户偏好 git commit'))
check('inactive records are absent', !view.includes('已经不用的内容'))
check('it names the revision', view.includes('revision 3'))
check('it points at the per-record files', view.includes('memories/<id>.md'))

if (failures > 0) {
  console.log(`\n${String(failures)} FAILURE(S)`)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
