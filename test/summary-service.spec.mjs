/**
 * Summary refresh suite.
 *
 * The summary is a cache, not the truth: a failed refresh keeps serving the old
 * text, so the failure has to be visible once instead of disappearing into a
 * missing file. The call also carries no plugin-side output cap — a reasoning
 * model must spend the provider's budget, not a fixed one that truncates the
 * answer.
 *
 * Usage: `node test/summary-service.spec.mjs`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { userLayout } from '../src/paths.js'
import { memoryRecord } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createSummaryService } = await import(pathToFileURL(join(PLUGIN, 'src/summary-service.js')).href)
const { withStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** One session route the model call can reuse. */
const agent = {
  session: {
    id: 'session-summary',
    requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }),
  },
}

/**
 * Build one scope with one active record and a streamed answer.
 * @param chunks - the chunks the fake stream yields.
 * @returns the scope, its layout, and the observed data.
 */
async function scene(chunks) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reflection-summary-'))
  const layout = userLayout(root)
  await withStore({ storePath: layout.storePath, lockPath: layout.lockPath, recordsDir: layout.recordsDir, lockTimeoutMs: 2000, staleLockMs: 60000 }, current => ({
    changed: true,
    records: [...current.records, memoryRecord({ title: 'a title', content: 'a fact' })],
  }))
  const seen = []
  const warnings = []
  const debugs = []
  const service = createSummaryService({
    scopes: { user: layout, project: () => layout },
    projectFor: () => null,
    llmScope: () => ({
      llm: {
        async *stream(options) {
          seen.push(options)
          yield* chunks
        },
      },
    }),
    logger: { warn: message => warnings.push(String(message)), debug: message => debugs.push(String(message)) },
    summaryBudgetBytes: 2400,
    now: () => Date.parse('2026-10-29T00:00:00.000Z'),
  })
  return { root, layout, seen, warnings, debugs, service }
}

console.log('a failed refresh is visible once')
{
  const { root, layout, warnings, debugs, service } = await scene([
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  await service.refresh(agent)
  check('the failure is a warning', warnings.length === 1, JSON.stringify(warnings))
  check('the warning names the summary path', warnings[0]?.includes(layout.summaryPath) === true)
  check('the warning carries the finish reason', warnings[0]?.includes('max-tokens') === true)
  check('no summary was written', !existsSync(layout.summaryPath))
  await service.refresh(agent)
  check('a repeated failure does not warn again', warnings.length === 1, JSON.stringify(warnings))
  check('the repeat stays at debug', debugs.length >= 1)
  rmSync(root, { recursive: true, force: true })
}

console.log('the call has no plugin-side cap and the answer is cached')
{
  const { root, layout, seen, warnings, service } = await scene([
    { type: 'text-delta', index: 0, text: 'the summary' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  await service.refresh(agent)
  check('the call carries no maxTokens', seen.length === 1 && seen[0].maxTokens === undefined, JSON.stringify(seen[0]?.maxTokens))
  check('the prompt carries the budget', String(seen[0]?.messages?.[0]?.content?.[0]?.text ?? '').includes('2400'))
  check('the summary file exists', existsSync(layout.summaryPath))
  const text = readFileSync(layout.summaryPath, 'utf8')
  check('the model text is cached', text.includes('the summary'))
  check('the cached revision is recorded', text.includes('revision:'))
  check('no warning on success', warnings.length === 0, JSON.stringify(warnings))
  rmSync(root, { recursive: true, force: true })
}

console.log('a different budget makes the cache stale')
{
  const root = mkdtempSync(join(tmpdir(), 'dsh-reflection-summary-budget-'))
  const layout = userLayout(root)
  await withStore({ storePath: layout.storePath, lockPath: layout.lockPath, recordsDir: layout.recordsDir, lockTimeoutMs: 2000, staleLockMs: 60000 }, current => ({
    changed: true,
    records: [...current.records, memoryRecord({ title: 'a title', content: 'a fact' })],
  }))
  const seen = []
  const makeService = budget => createSummaryService({
    scopes: { user: layout, project: () => layout },
    projectFor: () => null,
    llmScope: () => ({
      llm: {
        async *stream(options) {
          seen.push(options)
          yield { type: 'text-delta', index: 0, text: `summary for ${String(budget)}` }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    }),
    logger: { warn: () => {}, debug: () => {} },
    summaryBudgetBytes: budget,
    now: () => Date.parse('2026-10-29T00:00:00.000Z'),
  })
  await makeService(2400).refresh(agent)
  check('the first budget writes a summary', seen.length === 1 && readFileSync(layout.summaryPath, 'utf8').includes('summary for 2400'))
  await makeService(2400).refresh(agent)
  check('the same budget reuses the cache', seen.length === 1)
  await makeService(3200).refresh(agent)
  check('a new budget refreshes', seen.length === 2)
  check('the new budget is cached', readFileSync(layout.summaryPath, 'utf8').includes('budget: 3200'))
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
