/**
 * L1.5: keyless pipeline check for digest -> apply -> injection.
 *
 * The behavior suite owns "does the agent use it"; this suite owns the plumbing
 * in between: a scripted model produces a two-workspace practice, the digest
 * validates it, apply promotes it and archives only its sources, and the user
 * summary input carries the result. No network and no key.
 *
 * Usage: `node --import tsx/esm eval/run-pipeline.mjs`
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVAL = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(EVAL, '..')

const { userLayout, projectLayout, registryLayout, tombstoneLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.ts')).href)
const { withStore, readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.ts')).href)
const { writeSummaryDocument, buildSummaryPrompt, renderMemorySummary } = await import(pathToFileURL(join(PLUGIN, 'src/summary.ts')).href)
const { runDigest } = await import(pathToFileURL(join(PLUGIN, 'src/digest/index.ts')).href)
const { applyDigest } = await import(pathToFileURL(join(PLUGIN, 'src/digest/apply.ts')).href)

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const AT = new Date(NOW).toISOString()
const PROJECT_A = 'proj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROJECT_B = 'proj_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** Build a disposable memory root with two projects and one record each. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-reflection-pipeline-'))
  const memoryDir = join(root, 'memory')
  const registry = registryLayout(memoryDir)
  mkdirSync(registry.dir, { recursive: true })
  writeFileSync(registry.registryPath, `${JSON.stringify({
    schema_version: 1,
    revision: 1,
    projects: [PROJECT_A, PROJECT_B].map(projectId => ({
      project_id: projectId,
      canonical_root: `/tmp/${projectId}`,
      aliases: [],
      workspace_ids: [],
      created_at: AT,
      updated_at: AT,
    })),
  }, null, 2)}\n`)
  return { root, memoryDir }
}

/** Add one record and a summary to one project. */
async function seedProject(memoryDir, projectId, title, content, summary) {
  const layout = projectLayout(memoryDir, projectId)
  const record = {
    id: `mem_${projectId.slice(5, 13)}-1111-4111-8111-111111111111`,
    scope: 'project',
    project_id: projectId,
    source: 'agent',
    title,
    status: 'active',
    content,
    confidence: 0.9,
    created_at: AT,
    updated_at: AT,
    evidence: [],
    superseded_by: null,
  }
  const outcome = await withStore({
    storePath: layout.storePath,
    lockPath: layout.lockPath,
    recordsDir: layout.recordsDir,
    lockTimeoutMs: 2000,
    staleLockMs: 60000,
  }, current => ({ changed: true, records: [...current.records, record] }))
  writeSummaryDocument(layout.summaryPath, {
    content: summary,
    revision: outcome.revision,
    generated_at: AT,
    model: 'scripted',
    budget: 2400,
  })
  return record
}

/** Wiring shared by runDigest and applyDigest. */
function depsFor(memoryDir, llmScope) {
  return {
    config: { memoryDir, lockTimeoutMs: 2000, staleLockMs: 60000, maxEvidencePerMemory: 8 },
    scopes: { user: userLayout(memoryDir), project: id => projectLayout(memoryDir, id) },
    registry: registryLayout(memoryDir),
    tombstones: tombstoneLayout(memoryDir),
    logger: { warn: () => {}, info: () => {} },
    projectFor: () => null,
    resolveProjectFor: async () => {},
    isEnabled: () => true,
    setEnabled: async () => {},
    consolidationEnabled: () => true,
    llmScope,
    now: () => NOW,
    evidenceFor: () => ({ evidence: undefined }),
    consolidate: async () => ({ status: 'nothing-pending' }),
  }
}

/** A scripted model context: answers phase one then phase two. */
function scriptedModel(candidates) {
  const seen = []
  return {
    seen,
    ctx: {
      llm: {
        async *stream(options) {
          const text = String(options.messages?.[0]?.content?.[0]?.text ?? '')
          seen.push(text)
          const answer = text.includes('Active record index')
            ? JSON.stringify({ expand: candidates.flatMap(candidate => candidate.derived_from.map(source => source.record_id)) })
            : JSON.stringify({ candidates })
          yield { type: 'text-delta', index: 0, text: answer }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      },
    },
  }
}

const agent = { session: { id: 'eval-pipeline', requestHeader: () => ({ config: { provider: 'scripted', model: 'scripted' } }) } }
const PREFERENCE = {
  title: '会话日志压缩时先解压再检索',
  content: '会话转录若是 zstd 压缩，直接 grep 永远零命中；先 zstd -dc 再搜，零结果不代表不存在。',
}

console.log('a two-workspace practice becomes a pending candidate')
const run = makeRoot()
const { memoryDir } = run
const recordA = await seedProject(memoryDir, PROJECT_A, '会话日志先解压', '日志是 zstd 压缩，先解压。', '本项目记录了 zstd 日志的处理方式；检索前先解压。')
const recordB = await seedProject(memoryDir, PROJECT_B, '压缩日志要先解压', '压缩文件里 grep 零命中。', '另一个项目也遇到压缩日志：先解压再搜。')
const scripted = scriptedModel([{
  ...PREFERENCE,
  scope: 'practice',
  derived_from: [
    { project_id: PROJECT_A, record_id: recordA.id },
    { project_id: PROJECT_B, record_id: recordB.id },
  ],
}])
const deps = depsFor(memoryDir, () => scripted.ctx)
const digestOutcome = await runDigest(deps, agent, { force: true })
check('the digest proposes one candidate', digestOutcome.status === 'proposed' && digestOutcome.candidates === 1, JSON.stringify(digestOutcome))
check('the candidate spans two projects', digestOutcome.preview[0]?.derived_from.length === 2)
const pending = JSON.parse(readFileSync(join(memoryDir, 'digest/pending.json'), 'utf8'))
check('pending carries practice scope', pending.candidates[0]?.scope === 'practice')

console.log('apply promotes it and archives only its sources')
const applied = await applyDigest(deps, agent)
check('one candidate is applied', applied.status === 'applied' && applied.applied === 1, JSON.stringify(applied))
check('two sources are archived', applied.archived === 2)
const userStore = readStore(userLayout(memoryDir).storePath)
const promoted = userStore.records.find(record => record.title === PREFERENCE.title)
check('the user record exists', promoted !== undefined)
check('the user record is agent-sourced', promoted?.source === 'agent')
const projectStore = readStore(projectLayout(memoryDir, PROJECT_A).storePath)
check('the source is archived with a promotion comment',
  projectStore.records[0]?.status === 'archived' && String(projectStore.records[0]?.comment).includes('Promoted to user-scope experience'))
check('pending moved to history', existsSync(join(memoryDir, 'digest/history')) && !existsSync(join(memoryDir, 'digest/pending.json')))

console.log('the promoted record reaches the summary input and the user envelope')
const summaryPrompt = buildSummaryPrompt({ records: userStore.records, scopeLabel: 'user', budgetBytes: 1800 })
check('the summary prompt includes the experience', summaryPrompt.includes(PREFERENCE.title) && summaryPrompt.includes(PREFERENCE.content))
check('the summary prompt sees it as agent experience', summaryPrompt.includes('[agent]'))
const envelope = renderMemorySummary({
  summaryText: `本次经验：${PREFERENCE.title}。${PREFERENCE.content}`,
  counts: { user: userStore.records.length, project: 0, updatedAt: AT },
  paths: { user: userLayout(memoryDir).storePath },
  budgetBytes: 2400,
})
check('the injected envelope carries the experience', envelope.includes(PREFERENCE.title))
check('the injected envelope carries the index path', envelope.includes(userLayout(memoryDir).storePath))

console.log('a single-workspace candidate is rejected')
const single = makeRoot()
const onlyA = await seedProject(single.memoryDir, PROJECT_A, '仅一个项目', '只在一处出现。', '只有一个项目出现这个模式。')
const singleScripted = scriptedModel([{
  title: '只在一个项目出现', content: '这条不应通过。', scope: 'practice',
  derived_from: [{ project_id: PROJECT_A, record_id: onlyA.id }],
}])
const singleDeps = depsFor(single.memoryDir, () => singleScripted.ctx)
const singleOutcome = await runDigest(singleDeps, agent, { force: true })
check('no candidate is accepted', singleOutcome.status === 'proposed' && singleOutcome.candidates === 0, JSON.stringify(singleOutcome))
check('the rejection says why', singleOutcome.rejectedDetails.some(entry => entry.reason === 'fewer than two workspaces'))
rmSync(single.root, { recursive: true, force: true })

console.log('a project-scoped candidate is rejected')
const projectScoped = makeRoot()
const scopedA = await seedProject(projectScoped.memoryDir, PROJECT_A, '项目决策', '使用 Python 作为模块入口。', '项目选择 Python。')
const scopedB = await seedProject(projectScoped.memoryDir, PROJECT_B, '另一个项目决策', '同样选择 Python。', '另一个项目也选择 Python。')
const scopedScripted = scriptedModel([{
  title: '用 Python 暴露函数', content: '不写 CLI 和 HTTP。', scope: 'project',
  derived_from: [
    { project_id: PROJECT_A, record_id: scopedA.id },
    { project_id: PROJECT_B, record_id: scopedB.id },
  ],
}])
const scopedDeps = depsFor(projectScoped.memoryDir, () => scopedScripted.ctx)
const scopedOutcome = await runDigest(scopedDeps, agent, { force: true })
check('no candidate is accepted', scopedOutcome.status === 'proposed' && scopedOutcome.candidates === 0, JSON.stringify(scopedOutcome))
check('the rejection says why', scopedOutcome.rejectedDetails.some(entry => entry.reason === 'project-specific'))
rmSync(projectScoped.root, { recursive: true, force: true })

console.log('apply without a pending file fails')
const empty = makeRoot()
const emptyDeps = depsFor(empty.memoryDir, () => scriptedModel([]).ctx)
const noPending = await applyDigest(emptyDeps, agent)
check('apply reports the missing pending', noPending.status === 'error', JSON.stringify(noPending))
rmSync(empty.root, { recursive: true, force: true })
rmSync(run.root, { recursive: true, force: true })

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
