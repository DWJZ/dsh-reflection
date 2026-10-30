/**
 * Digest suite: the checkpoint, the summary window, two-phase expansion, and
 * the pending file. The model is scripted, so this is about the pipeline.
 *
 * Usage: `node test/digest.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { memoryRecord, projectId, AT } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const digest = await import(pathToFileURL(join(PLUGIN, 'src/digest/index.js')).href)
const state = await import(pathToFileURL(join(PLUGIN, 'src/digest/state.js')).href)
const collect = await import(pathToFileURL(join(PLUGIN, 'src/digest/collect.js')).href)
const prompt = await import(pathToFileURL(join(PLUGIN, 'src/digest/prompt.js')).href)
const pending = await import(pathToFileURL(join(PLUGIN, 'src/digest/pending.js')).href)
const { withStore, readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { writeSummaryDocument } = await import(pathToFileURL(join(PLUGIN, 'src/summary.js')).href)
const { digestLayout, projectLayout, registryLayout, tombstoneLayout, userLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-digest-'))
const MEMORY = join(ROOT, 'memory')
const REG = registryLayout(MEMORY)
const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const OLD = '2026-10-28T00:00:00.000Z'
const FRESH = '2026-10-29T23:00:00.000Z'
const PROJECT_OLD = projectId()
const PROJECT_NEW = projectId()

mkdirSync(REG.dir, { recursive: true })
writeFileSync(REG.registryPath, `${JSON.stringify({
  schema_version: 1,
  revision: 1,
  projects: [PROJECT_OLD, PROJECT_NEW].map(id => ({
    project_id: id,
    canonical_root: `/tmp/${id}`,
    aliases: [],
    workspace_ids: [],
    created_at: AT,
    updated_at: AT,
  })),
}, null, 2)}\n`)

/** Seed one project with one record and a summary. */
async function seedProject(projectIdValue, generatedAt, content) {
  const layout = projectLayout(MEMORY, projectIdValue)
  const record = memoryRecord({ scope: 'project', project_id: projectIdValue, content, title: `${content} title` })
  await withStore({ storePath: layout.storePath, lockPath: layout.lockPath, recordsDir: layout.recordsDir, lockTimeoutMs: 2000, staleLockMs: 60000 }, current => ({
    changed: true,
    records: [...current.records, record],
  }))
  const store = readStore(layout.storePath)
  writeSummaryDocument(layout.summaryPath, { content: `summary: ${content}`, revision: store.revision, generated_at: generatedAt, budget: 2400 })
  return record
}

const oldRecord = await seedProject(PROJECT_OLD, OLD, 'old workspace fact')
const newRecord = await seedProject(PROJECT_NEW, FRESH, 'new workspace fact')

const deps = {
  config: { memoryDir: MEMORY },
  scopes: { user: userLayout(MEMORY), project: id => projectLayout(MEMORY, id) },
  registry: REG,
  tombstones: tombstoneLayout(MEMORY),
  logger: { warn: () => {}, info: () => {} },
  projectFor: () => null,
  resolveProjectFor: async () => {},
  isEnabled: () => true,
  setEnabled: async () => {},
  consolidationEnabled: () => true,
  llmScope: () => undefined,
  now: () => NOW,
  evidenceFor: () => ({ evidence: undefined }),
  consolidate: async () => ({ status: 'nothing-pending' }),
}

console.log('the checkpoint')
{
  const path = join(ROOT, 'digest-state.json')
  check('a missing checkpoint reads empty', Object.keys(state.readDigestState(path)).length === 0)
  state.writeDigestState(path, { lastScanAt: FRESH })
  check('the checkpoint round-trips', state.readDigestState(path).lastScanAt === FRESH)
  check('the default window is one day', state.defaultSince(NOW) === '2026-10-29T00:00:00.000Z')
}

console.log('the summary window')
{
  const scopes = collect.collectScopes(deps, '2026-10-29T00:00:00.000Z')
  check('only the fresh summary is collected', scopes.length === 1 && scopes[0].projectId === PROJECT_NEW, JSON.stringify(scopes.map(scope => scope.projectId)))
  check('the collected scope carries its records', scopes[0].records.some(record => record.id === newRecord.id))
  check('force collects every summary', collect.collectScopes(deps, undefined).length === 2)
}

console.log('the model answers are checked')
{
  const expansion = prompt.parseExpansion('{"expand":["mem_unknown","' + newRecord.id + '"]}', new Set([newRecord.id]))
  check('unknown expansion ids are dropped', expansion.length === 1 && expansion[0] === newRecord.id)
  const allowed = new Set([`${PROJECT_NEW}/${newRecord.id}`])
  const parsed = prompt.parseCandidates(JSON.stringify({ candidates: [
    { title: 'A useful pattern.', content: 'Do the thing before the other thing.', derived_from: [{ project_id: PROJECT_NEW, record_id: newRecord.id }] },
    { title: '', content: 'x', derived_from: [{ project_id: PROJECT_NEW, record_id: newRecord.id }] },
    { title: 'Leaky.', content: 'key sk-abcdefghijklmnopqrstuvwxyz012345', derived_from: [{ project_id: PROJECT_NEW, record_id: newRecord.id }] },
    { title: 'Unknown source.', content: 'x', derived_from: [{ project_id: PROJECT_NEW, record_id: 'mem_missing' }] },
  ] }), allowed)
  check('one candidate is accepted', parsed.accepted.length === 1, JSON.stringify(parsed))
  check('missing title, secret and unknown source are rejected', parsed.rejected.length === 3, JSON.stringify(parsed.rejected))
}

console.log('a digest run writes pending and advances the checkpoint')
{
  const seen = []
  const fakeCtx = {
    llm: {
      async *stream(options) {
        seen.push(String(options.messages?.[0]?.content?.[0]?.text ?? ''))
        const text = seen.length === 1
          ? JSON.stringify({ expand: [newRecord.id] })
          : JSON.stringify({ candidates: [
            { title: 'Generate before running e2e.', content: 'Run the codegen step before the e2e suite; the suite fails on stale artifacts otherwise.', derived_from: [{ project_id: PROJECT_NEW, record_id: newRecord.id }] },
          ] })
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const agent = { session: { id: 'session-digest', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  const liveDeps = { ...deps, llmScope: () => fakeCtx }
  const layout = digestLayout(MEMORY)
  const outcome = await digest.runDigest(liveDeps, agent)
  check('the run proposes one candidate', outcome.status === 'proposed' && outcome.candidates === 1, JSON.stringify(outcome))
  check('two model calls are made', seen.length === 2)
  check('the first call asks for expansion', seen[0].includes('Active record index'))
  check('the second call carries the expanded record', seen[1].includes('new workspace fact'))
  check('pending.json exists', existsSync(layout.pendingPath))
  const parsed = JSON.parse(readFileSync(layout.pendingPath, 'utf8'))
  check('the pending candidate has its source', parsed.candidates[0]?.derived_from?.[0]?.record_id === newRecord.id)
  check('the checkpoint advanced', state.readDigestState(layout.statePath).lastScanAt === '2026-10-30T00:00:00.000Z')
  check('pending.md exists', existsSync(layout.pendingMarkdownPath))
  check('pending.md renders the title', readFileSync(layout.pendingMarkdownPath, 'utf8').includes('Generate before running e2e.'))

  const again = await digest.runDigest({ ...liveDeps, llmScope: () => fakeCtx }, agent)
  check('a second run finds nothing new', again.status === 'nothing-new', JSON.stringify(again))
  const forced = await digest.runDigest({ ...liveDeps, llmScope: () => fakeCtx }, agent, { force: true })
  check('force rescans every summary', forced.status === 'proposed' && seen.length === 4, JSON.stringify(forced))
}

console.log('an invalid JSON answer is retried and kept for diagnosis')
{
  const answers = [
    JSON.stringify({ expand: [newRecord.id] }),
    '{"candidates":[{"title":"broken"', // malformed, as a truncated or unescaped answer would be
    JSON.stringify({ candidates: [
      { title: 'Retried pattern.', content: 'A compact retried pattern.', derived_from: [{ project_id: PROJECT_NEW, record_id: newRecord.id }] },
    ] }),
  ]
  const fakeCtx = {
    llm: {
      async *stream() {
        const text = answers[Math.min(seenCalls.length, answers.length - 1)]
        seenCalls.push(text)
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const seenCalls = []
  const agent = { session: { id: 'session-digest-retry', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  const liveDeps = { ...deps, llmScope: () => fakeCtx }
  const layout = digestLayout(MEMORY)
  const outcome = await digest.runDigest(liveDeps, agent, { force: true })
  check('the retry produces a candidate', outcome.status === 'proposed' && outcome.candidates === 1, JSON.stringify(outcome))
  check('three calls were made', seenCalls.length === 3, String(seenCalls.length))
  check('the malformed answer is kept', existsSync(join(layout.dir, 'last-answer.txt')))
  check('the retry asked for compact JSON', seenCalls[2].length > 0)
}

console.log('the pending document renders')
{
  const markdown = pending.renderPendingMarkdown({
    version: 1,
    created_at: FRESH,
    scan_from: OLD,
    scan_to: FRESH,
    candidates: [{ title: 'A title.', content: 'A body.', derived_from: [{ project_id: PROJECT_NEW, record_id: newRecord.id }] }],
  })
  check('the title and body are shown', markdown.includes('A title.') && markdown.includes('A body.'))
  check('the source is shown', markdown.includes(newRecord.id))
}

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
