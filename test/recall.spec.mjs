/**
 * Automatic-recall suite: user text extraction, query recall, summary dedupe,
 * and the injected block.
 *
 * Usage: `node --import tsx/esm test/recall.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { memoryRecord } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const recall = await import(pathToFileURL(join(PLUGIN, 'src/recall.ts')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const NOW = Date.parse('2026-10-30T00:00:00.000Z')

console.log('user text extraction')
{
  const user = recall.userTextFromEvent({
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这个项目用什么包管理器？' }] },
  })
  check('a user message is extracted', user === '这个项目用什么包管理器？')
  check('an assistant message is ignored', recall.userTextFromEvent({
    type: 'assistant/message', data: { content: [{ type: 'text', text: 'pnpm' }] },
  }) === undefined)
  check('a title-agent message is ignored', recall.userTextFromEvent({
    type: 'user/message', data: { source: { kind: 'dsh-session-title-llm' }, content: [{ type: 'text', text: 'title' }] },
  }) === undefined)
}

console.log('recall selection')
{
  const records = [
    memoryRecord({ id: 'mem_a', title: '项目用 pnpm', content: '这个项目用 pnpm 管理依赖。', confidence: 1, updated_at: new Date(NOW).toISOString() }),
    memoryRecord({ id: 'mem_b', title: '项目用 vitest', content: '这个项目用 vitest 跑测试。', confidence: 1, updated_at: new Date(NOW).toISOString() }),
    memoryRecord({ id: 'mem_c', title: '端口 3000', content: '本地开发端口是 3000。', confidence: 1, updated_at: new Date(NOW).toISOString() }),
    memoryRecord({ id: 'mem_d', title: '发布分支', content: '发布分支是 release/2026。', confidence: 1, updated_at: new Date(NOW).toISOString() }),
  ]
  const picked = recall.selectRecall(records, '', '这个项目用什么包管理器', null, NOW, 3)
  check('the matching record is recalled', picked.some(entry => entry.id === 'mem_a'), JSON.stringify(picked))
  check('the list is bounded', picked.length <= 3)
  const deduped = recall.selectRecall(records, '项目用 pnpm', '这个项目用什么包管理器', null, NOW, 3)
  check('a title already in the summary is not repeated', !deduped.some(entry => entry.id === 'mem_a'), JSON.stringify(deduped))
  check('an empty query recalls nothing', recall.selectRecall(records, '', '  ', null, NOW, 3).length === 0)
}

console.log('the block renders ids and titles')
{
  const block = recall.renderRecall([{ id: 'mem_a', title: '项目用 pnpm', scope: 'user', project_id: null }])
  check('the id is present', block.includes('mem_a'))
  check('the title is present', block.includes('项目用 pnpm'))
  check('an empty list renders nothing', recall.renderRecall([]) === '')
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
