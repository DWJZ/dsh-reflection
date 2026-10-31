/**
 * L2: behavior evaluation against a real model.
 *
 * Each scenario boots the shipped headless profile through the real CLI with the
 * plugin mounted from this checkout, seeds or writes Memory, then asks questions
 * whose answers can only come from what was remembered. Answers are scored with
 * deterministic rules (`all` / `none` / `abstain`), so this suite needs no judge.
 *
 * This suite spends tokens: it only runs on a release tag or by hand.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=… node --import tsx/esm eval/run-behavior.mjs
 *   node --import tsx/esm eval/run-behavior.mjs --update-baseline
 *   node --import tsx/esm eval/run-behavior.mjs --check     # config only, no calls
 *
 * The CLI is `<repo>/apps/cli/src/bin.ts` by default; set DSH_CLI to another
 * entry (for example the published `@deepseek-ai/dsh` bin) and DSH_REPO to the
 * checkout it belongs to.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { renderBehaviorReport } from './report.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVAL = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(EVAL, '..')
const REPO = process.env.DSH_REPO ?? resolve(PLUGIN, '../..')
const CLI = process.env.DSH_CLI ?? join(REPO, 'apps/cli/src/bin.ts')
const DATA = JSON.parse(readFileSync(join(EVAL, 'data/scenarios.json'), 'utf8'))
const BASELINE_PATH = join(EVAL, 'baseline.json')
const REPORT_PATH = join(EVAL, 'report-behavior.json')
const REPORT_MD = join(EVAL, 'report-behavior.md')
const SESSION_TIMEOUT_MS = 240_000

/** One token per run, so the expected answer exists nowhere on disk before it runs. */
const RUN_TOKEN = randomUUID().slice(0, 8)
const CONFIG_ONLY = process.argv.includes('--check')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')
const MOCK = process.argv.includes('--mock')
/** Run only the scenarios whose name contains this fragment. */
const ONLY = (() => {
  const at = process.argv.indexOf('--only')
  return at < 0 ? undefined : process.argv[at + 1]
})()
/** Keep the scratch tree so a failed run can be inspected. */
const KEEP = process.argv.includes('--keep')
/** Run every scenario a second time with Memory switched off, as a control run. */
const CONTROL = process.argv.includes('--control')
/** Route the scripted adapter owns; used by `--mock` to check the plumbing without a key. */
const MOCK_MODEL = { provider: 'dsh-reflection-mock', model: 'dsh-reflection-mock', reasoningEffort: undefined }

const { userLayout, projectLayout, registryLayout, tombstoneLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.ts')).href)
const { bindProject } = await import(pathToFileURL(join(PLUGIN, 'src/registry.ts')).href)
const { addMemory, supersedeMemory } = await import(pathToFileURL(join(PLUGIN, 'src/actions.ts')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.ts')).href)
const { writeSummaryDocument } = await import(pathToFileURL(join(PLUGIN, 'src/summary.ts')).href)

/**
 * Replace the run token in one scenario value.
 * @param value - any JSON value from the dataset.
 * @returns the value with `{{run}}` filled in.
 */
function fillRunToken(value) {
  if (typeof value === 'string') return value.replaceAll('{{run}}', RUN_TOKEN)
  if (Array.isArray(value)) return value.map(fillRunToken)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fillRunToken(entry)]))
  }
  return value
}

const SCENARIOS = DATA.scenarios.map(fillRunToken)

/** Phrases that count as "no such memory" for an abstention question. */
const ABSTAIN_PATTERNS = [
  '不知道', '没有记录', '没有相关', '未记录', '记不得', '不清楚', '没有提到', '无法确定',
  "don't know", 'do not know', 'no memory', 'not in memory', 'no record', 'unknown', 'not sure',
]

/**
 * One failing check inside a run.
 * @param message - what failed.
 * @returns the failure record.
 */
const fail = message => ({ pass: false, detail: message })
/** One passing check. @returns the pass record. */
const pass = () => ({ pass: true })

/**
 * Assert the pieces one behavior run needs before spending a token.
 * @returns nothing; throws with an actionable message when a piece is missing.
 * @throws when the CLI, the dataset, or the key is missing.
 */
function preflight() {
  if (!existsSync(CLI)) throw new Error(`eval: CLI not found at ${CLI}; set DSH_CLI or DSH_REPO`)
  if (!existsSync(join(PLUGIN, 'src/index.ts'))) throw new Error('eval: plugin sources not found')
  if (!MOCK && !CONFIG_ONLY && !process.env.DEEPSEEK_API_KEY) {
    throw new Error('eval: DEEPSEEK_API_KEY is not set; behavior evaluation makes real model calls')
  }
  for (const scenario of DATA.scenarios) {
    for (const project of scenario.projects) {
      if (typeof project !== 'string' || project === '') throw new Error(`eval: ${scenario.name} names an empty project`)
    }
  }
}

/**
 * Write the overlay that points the profile at this checkout and the fixture project.
 * @param options - target project, harness home, model route.
 * @returns the patch path.
 */
function writeOverlay({ projectDir, home, model, dir, drive, control }) {
  const lines = [
    // Workspace instruction files are a second memory channel. Left on, a model
    // that cannot use Memory writes AGENTS.md instead, and the next session reads
    // the fact back from it — in either run.
    '- id: agent-instructions',
    '  disabled: true',
    '',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(model.provider)}`,
    `    model: ${JSON.stringify(model.model)}`,
    ...model.reasoningEffort === undefined ? [] : [`    reasoningEffort: ${JSON.stringify(model.reasoningEffort)}`],
    '',
    '- id: fs-sandbox',
    '  config:',
    `    cwd: ${JSON.stringify(projectDir)}`,
    '',
    '- insert:',
    '    - id: dsh-reflection',
    `      name: ${JSON.stringify(join(PLUGIN, 'src/index.js'))}`,
    ...control === true
      ? ['      config:', '        enabled: false']
      : drive === true ? ['      config:', '        sessionEvents: true'] : [],
    '',
    '    - id: dsh-reflection-eval-usage-spy',
    `      name: ${JSON.stringify(join(PLUGIN, 'eval/fixtures/usage-spy.ts'))}`,
  ]
  if (drive === true) {
    lines.push(
      '',
      '    - id: dsh-reflection-consolidate-on-idle',
      `      name: ${JSON.stringify(join(PLUGIN, 'test/fixtures/consolidate-on-idle.ts'))}`,
    )
  }
  if (MOCK) {
    lines.push(
      '',
      '    - id: dsh-reflection-mock-llm',
      `      name: ${JSON.stringify(join(PLUGIN, 'test/fixtures/mock-llm.ts'))}`,
    )
  }
  const path = join(dir, `overlay-${String(Date.now())}.yml`)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/**
 * Run one headless session and read back its final answer.
 * @param options - task, project directory, harness home, model route, scratch dir.
 * @returns the exit code, final text, tool names, and error text.
 */
async function runSession({ task, projectDir, home, model, dir, drive, usageLog, control }) {
  const patch = writeOverlay({ projectDir, home, model, dir, drive, control })
  // The control answers from what it has. Without this it explores the disk for
  // the fact: slower per session and a second route around Memory, even though
  // the run token makes the search fruitless.
  const controlTask = control
    ? `${task}\n\n（对照运行：不要使用任何工具，只根据当前上下文回答；不知道就说不知道。）`
    : task
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    // These scenarios test Memory, not confinement. The stock policy confines
    // shell calls with sandbox-exec, which cannot run inside a parent sandbox
    // (macOS local runs) or on runners without a working bwrap; the failure text
    // then leaks into answers and costs tokens.
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_EVAL_USAGE_LOG: usageLog,
    ...drive === true ? { DSH_MEMORY_DRIVER_LOG: `${usageLog}.driver` } : {},
    ...MOCK ? { DSH_MEMORY_MOCK_TRIGGER: '记住' } : {},
  }
  const args = ['--import', 'tsx/esm', CLI, '--profile', 'headless', '--patch', patch, '--json', controlTask]
  const cwd = existsSync(join(REPO, 'apps/cli/src/bin.ts')) ? REPO : PLUGIN
  const outcome = await new Promise(settle => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let timedOut = false
    const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, SESSION_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(guard); settle({ code: -1, stdout, stderr: `${stderr}\n${String(error)}`, timedOut }) })
    child.on('close', code => { clearTimeout(guard); settle({ code, stdout, stderr, timedOut }) })
  })
  const events = outcome.stdout.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const final = events.filter(event => event.type === 'final').at(-1)
  const sessionId = events.find(event => event.type === 'session')?.sessionId
  const tools = events.filter(event => event.type === 'tool_call').map(event => String(event.tool))
  const failure = final?.reason?.kind === 'error' ? String(final.reason.error?.message ?? 'model call failed') : undefined
  return {
    code: outcome.code,
    answer: String(final?.text ?? '').trim(),
    tools,
    stderr: outcome.stderr.trim(),
    failure,
    timedOut: outcome.timedOut === true,
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    usage: readUsage(usageLog, typeof sessionId === 'string' ? sessionId : undefined),
  }
}

/**
 * Remove everything a session left in the fixture project except its `.git`
 * marker, so a scratch file cannot carry a fact into the next session.
 * @param projectDir - the fixture project directory.
 * @returns nothing.
 */
function cleanProject(projectDir) {
  for (const name of readdirSync(projectDir)) {
    if (name === '.git') continue
    rmSync(join(projectDir, name), { recursive: true, force: true })
  }
}

/**
 * Check one answer against its expectation.
 * @param answer - the final text.
 * @param expect - `{ all?, none?, abstain? }`.
 * @returns the check result.
 */
function checkAnswer(answer, expect) {
  if (answer === '') return fail('the model returned no text')
  const text = answer.toLowerCase()
  for (const needle of expect.all ?? []) {
    if (!text.includes(needle.toLowerCase())) return fail(`missing ${JSON.stringify(needle)} in ${JSON.stringify(answer.slice(0, 200))}`)
  }
  if (expect.any !== undefined) {
    if (!expect.any.some(pattern => new RegExp(pattern, 'iu').test(answer))) {
      return fail(`none of ${JSON.stringify(expect.any)} appears in ${JSON.stringify(answer.slice(0, 200))}`)
    }
  }
  for (const pattern of expect.none ?? []) {
    if (new RegExp(pattern, 'iu').test(answer)) return fail(`forbidden ${JSON.stringify(pattern)} in ${JSON.stringify(answer.slice(0, 200))}`)
  }
  if (expect.abstain === true) {
    const declined = ABSTAIN_PATTERNS.some(pattern => text.includes(pattern.toLowerCase()))
    if (!declined) return fail(`expected an abstention, got ${JSON.stringify(answer.slice(0, 200))}`)
  }
  return pass()
}

/**
 * Check that one scope holds an active record containing each expected text.
 * @param options - harness home, scope, project, expected substrings.
 * @returns the check result.
 */
function checkStore({ home, scope, project, projectId, contains, any, excludes, excludesExact }) {
  const storePath = scope === 'user' ? userLayout(join(home, 'memory')).storePath : projectLayout(join(home, 'memory'), projectId(project)).storePath
  const records = readStore(storePath).records.filter(record => record.status === 'active')
  const where = `store ${scope}${project === undefined ? '' : `/${project}`}`
  for (const needle of contains ?? []) {
    if (!records.some(record => record.content.includes(needle))) {
      return fail(`${where} has no active record containing ${JSON.stringify(needle)}`)
    }
  }
  if (any !== undefined) {
    const matched = records.some(record => any.some(pattern => new RegExp(pattern, 'iu').test(record.content)))
    if (!matched) return fail(`${where} has no active record matching any of ${JSON.stringify(any)}`)
  }
  for (const pattern of excludes ?? []) {
    const hit = records.find(record => new RegExp(pattern, 'iu').test(record.content))
    if (hit !== undefined) {
      return fail(`${where} still holds ${JSON.stringify(hit.content.slice(0, 120))} matching ${JSON.stringify(pattern)}`)
    }
  }
  for (const exact of excludesExact ?? []) {
    if (records.some(record => record.content === exact)) {
      return fail(`${where} still holds the retired record ${JSON.stringify(exact)}`)
    }
  }
  return pass()
}

/**
 * Check the summary the model wrote for one scope.
 * @param options - harness home, scope, project, required/forbidden text, byte cap.
 * @returns the check result.
 */
function checkSummary({ home, scope, project, projectId, contains, excludes, maxBytes }) {
  const layout = scope === 'user' ? userLayout(join(home, 'memory')) : projectLayout(join(home, 'memory'), projectId(project))
  if (!existsSync(layout.summaryPath)) return fail('summary.json was not generated')
  let cached
  try {
    cached = JSON.parse(readFileSync(layout.summaryPath, 'utf8'))
  } catch {
    return fail('summary.json is not valid JSON')
  }
  const body = String(cached.content ?? '').trim()
  if (body === '') return fail('summary.json has no content')
  const where = `summary ${scope}${project === undefined ? '' : `/${project}`}`
  for (const needle of contains ?? []) {
    if (!body.toLowerCase().includes(needle.toLowerCase())) return fail(`${where} does not mention ${JSON.stringify(needle)}: ${JSON.stringify(body.slice(0, 200))}`)
  }
  for (const pattern of excludes ?? []) {
    if (new RegExp(pattern, 'iu').test(body)) return fail(`${where} mentions ${JSON.stringify(pattern)}: ${JSON.stringify(body.slice(0, 200))}`)
  }
  const budget = maxBytes ?? 1200
  if (Buffer.byteLength(body, 'utf8') > budget) return fail(`${where} is ${String(Buffer.byteLength(body, 'utf8'))} bytes, over ${String(budget)}`)
  return pass()
}

/**
 * Sum the usage one session reported.
 * @param logPath - the spy's log.
 * @param sessionId - the session to sum, or undefined for every line.
 * @returns input and output tokens, and how many records contributed.
 */
function readUsage(logPath, sessionId) {
  if (!existsSync(logPath)) return { inputTokens: 0, outputTokens: 0, records: 0 }
  let inputTokens = 0
  let outputTokens = 0
  let records = 0
  for (const line of readFileSync(logPath, 'utf8').split('\n').filter(Boolean)) {
    let entry
    try { entry = JSON.parse(line) } catch { continue }
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue
    if (typeof entry.inputTokens !== 'number' || typeof entry.outputTokens !== 'number') continue
    inputTokens += entry.inputTokens
    outputTokens += entry.outputTokens
    records += 1
  }
  return { inputTokens, outputTokens, records }
}

/**
 * Write records straight into one scope, without a model call.
 * @param options - harness home, scope, project id, records to add.
 * @returns nothing.
 */
async function seed({ home, scope, projectId, records }) {
  const options = actionOptions(home)
  for (const record of records) {
    const result = await addMemory(options, {
      content: record.content,
      title: record.title ?? record.content.slice(0, 60),
      scope,
      category: record.category ?? 'state',
      ...scope === 'project' ? { projectId } : {},
    })
    if (result.action === 'noop' && result.reason !== undefined && !String(result.reason).startsWith('duplicate')) {
      throw new Error(`eval: seed was refused: ${String(result.reason)}`)
    }
  }
}

/**
 * Build the action options one seed or supersede needs.
 * @param home - harness home.
 * @returns the options.
 */
function actionOptions(home) {
  const memoryDir = join(home, 'memory')
  return {
    scopes: { user: userLayout(memoryDir), project: id => projectLayout(memoryDir, id) },
    tombstones: tombstoneLayout(memoryDir),
    lockTimeoutMs: 10_000,
    staleLockMs: 60_000,
    maxEvidencePerMemory: 8,
    logger: { warn: message => console.warn(`eval seed: ${String(message)}`) },
    host: 'eval',
  }
}

/**
 * Replace one seeded record, so a later question can check that the retired
 * version is not what gets served.
 * @param options - harness home, scope, project id, old and new content.
 * @returns nothing; throws when the old record is not there.
 * @throws when no active record carries the old content.
 */
async function supersede({ home, scope, projectId, from, to }) {
  const options = actionOptions(home)
  const storePath = scope === 'user' ? userLayout(join(home, 'memory')).storePath : projectLayout(join(home, 'memory'), projectId).storePath
  const record = readStore(storePath).records.find(entry => entry.status === 'active' && entry.content === from)
  if (record === undefined) throw new Error(`eval: no active record to supersede: ${JSON.stringify(from)}`)
  await supersedeMemory(options, { id: record.id, content: to, title: to.slice(0, 60), ...scope === 'project' ? { projectId } : {} })
}

/**
 * Run one scenario end to end.
 * @param scenario - the labeled scenario.
 * @param index - its position, used to name the scratch directory.
 * @returns the scenario result.
 */
async function runScenario(scenario, index, control = false) {
  const dir = join(ROOT, `${String(index)}-${scenario.name}${control ? '-control' : ''}`)
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  const projectDirs = new Map()
  const projectIds = new Map()
  for (const name of scenario.projects) {
    const projectDir = join(dir, 'projects', name)
    mkdirSync(join(projectDir, '.git'), { recursive: true })
    projectDirs.set(name, projectDir)
    const bound = await bindProject({ ...registryLayout(join(home, 'memory')), lockTimeoutMs: 10_000, staleLockMs: 60_000, projectRootMarkers: ['.git'] }, projectDir)
    projectIds.set(name, bound.project.project_id)
  }
  const usageLog = join(dir, 'usage.jsonl')
  const steps = []
  const sessionDurations = []
  const tokens = { inputTokens: 0, outputTokens: 0 }
  const started = Date.now()
  for (const [stepIndex, step] of scenario.steps.entries()) {
    const label = `${String(stepIndex + 1)}.${Object.keys(step).join('+')}`
    try {
      if (step.seed !== undefined) {
        // The control run must have nothing to find: seeding it would leave the
        // facts on disk, and a model with shell access reads them.
        if (control) continue
        await seed({ home, ...step.seed, ...step.seed.project === undefined ? {} : { projectId: projectIds.get(step.seed.project) } })
        steps.push({ label, pass: true })
      } else if (step.supersede !== undefined) {
        if (control) continue
        await supersede({ home, ...step.supersede, ...step.supersede.project === undefined ? {} : { projectId: projectIds.get(step.supersede.project) } })
        steps.push({ label, pass: true })
      } else if (step.writeSummary !== undefined) {
        if (control) continue
        const { scope, project, content } = step.writeSummary
        const projectId = project === undefined ? undefined : projectIds.get(project)
        const memoryDir = join(home, 'memory')
        const layout = scope === 'user'
          ? userLayout(memoryDir)
          : projectLayout(memoryDir, projectId)
        const store = readStore(layout.storePath)
        writeSummaryDocument(layout.summaryPath, {
          content,
          revision: store.revision,
          generated_at: new Date().toISOString(),
          model: 'eval',
          budget: 2400,
        })
        steps.push({ label, pass: true })
      } else if (step.assertStore !== undefined) {
        // Artifact assertions describe what the plugin wrote; the control run has
        // no plugin, so only the session expectations are compared there.
        if (control) continue
        const result = checkStore({ home, ...step.assertStore, projectId: name => projectIds.get(name) })
        steps.push({ label, ...result })
      } else if (step.assertSummary !== undefined) {
        if (control) continue
        const result = checkSummary({ home, ...step.assertSummary, projectId: name => projectIds.get(name) })
        steps.push({ label, ...result })
      } else if (step.session !== undefined) {
        const projectDir = projectDirs.get(step.session.project)
        if (projectDir === undefined) throw new Error(`eval: ${scenario.name} names an unknown project ${step.session.project}`)
        const sessionStarted = Date.now()
        // One fresh harness home per control session: a shared home keeps earlier
        // transcripts, and a model that greps them recovers the fact without Memory.
        const sessionHome = control ? join(dir, `home-${String(stepIndex)}`) : home
        mkdirSync(sessionHome, { recursive: true })
        let session = await runSession({
          task: step.session.task,
          projectDir,
          home: sessionHome,
          model: MOCK ? MOCK_MODEL : DATA.model,
          dir,
          drive: step.drive === true,
          usageLog,
          control,
        })
        if (session.timedOut === true) {
          // A slow provider is not a Memory regression; give the session one more
          // window before the step is scored.
          mkdirSync(sessionHome, { recursive: true })
          session = await runSession({
            task: step.session.task,
            projectDir,
            home: sessionHome,
            model: MOCK ? MOCK_MODEL : DATA.model,
            dir,
            drive: step.drive === true,
            usageLog,
            control,
          })
        }
        sessionDurations.push(Date.now() - sessionStarted)
        tokens.inputTokens += session.usage.inputTokens
        tokens.outputTokens += session.usage.outputTokens
        // The control run keeps nothing: a later control session must not find
        // this transcript (and the fact its task carried) on disk. Both runs lose
        // the project's scratch files for the same reason.
        cleanProject(projectDir)
        if (control && !KEEP) rmSync(sessionHome, { recursive: true, force: true })
        const scored = step.expect !== undefined
        if (session.failure !== undefined) {
          steps.push({ label, ...fail(session.failure), scored })
        } else if (session.code !== 0) {
          steps.push({ label, ...fail(`exit ${String(session.code)}: ${session.stderr.slice(0, 2000)}`), scored })
        } else if (step.expect !== undefined) {
          const result = checkAnswer(session.answer, step.expect)
          steps.push({ label, ...result, answer: session.answer, tools: session.tools, scored })
        } else {
          steps.push({ label, pass: true, answer: session.answer, tools: session.tools, scored })
        }
      } else {
        throw new Error(`eval: unknown step ${JSON.stringify(step)}`)
      }
    } catch (error) {
      steps.push({ label, ...fail(error instanceof Error ? error.message : String(error)) })
    }
  }
  return {
    name: scenario.name,
    pass: steps.every(step => step.pass),
    durationMs: Date.now() - started,
    tokens,
    sessions: sessionDurations.length,
    sessionDurations,
    steps,
  }
}

preflight()
if (CONFIG_ONLY) {
  console.log(`cli: ${CLI}`)
  console.log(`scenarios: ${String(DATA.scenarios.length)} (${DATA.scenarios.map(scenario => scenario.name).join(', ')})`)
  console.log(`model: ${DATA.model.provider}/${DATA.model.model} (${DATA.model.reasoningEffort})`)
  process.exit(0)
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-eval-'))
const scenarios = []
const controls = new Map()
const selected = ONLY === undefined ? SCENARIOS : SCENARIOS.filter(scenario => scenario.name.includes(ONLY))

// The control pass runs first, before any memory run has written a store: a
// model with shell access walks the filesystem, and a store from another
// scenario would be as good as its own.
if (CONTROL) {
  console.log('\n## control run (Memory off)')
  for (const [index, scenario] of selected.entries()) {
    // Artifact-only scenarios have nothing the control can compare; skipping them
    // keeps the run short without weakening the comparison.
    if (!scenario.steps.some(step => step.session !== undefined && step.expect !== undefined)) continue
    const control = await runScenario(scenario, index, true)
    controls.set(scenario.name, control)
    console.log(`  ${control.pass ? 'PASS' : 'FAIL'} ${scenario.name} (${String(control.durationMs)} ms, ${String(control.tokens.inputTokens)} in / ${String(control.tokens.outputTokens)} out)`)
  }
}

for (const [index, scenario] of selected.entries()) {
  process.stdout.write(`\n=== ${scenario.name} ===\n`)
  const result = await runScenario(scenario, index)
  for (const step of result.steps) {
    console.log(`  ${step.pass ? 'ok  ' : 'FAIL'} ${step.label}${step.detail === undefined ? '' : ` — ${step.detail}`}`)
    if (step.answer !== undefined && !step.pass) console.log(`       answer: ${step.answer.slice(0, 300)}`)
  }
  console.log(`  ${result.pass ? 'PASS' : 'FAIL'} ${scenario.name} (${String(result.durationMs)} ms, ${String(result.tokens.inputTokens)} in / ${String(result.tokens.outputTokens)} out)`)
  if (CONTROL && controls.has(scenario.name)) {
    const control = controls.get(scenario.name)
    const scored = run => {
      const checks = run.steps.filter(step => step.scored === true)
      return { total: checks.length, passed: checks.filter(step => step.pass).length }
    }
    const memory = scored(result)
    const without = scored(control)
    // The control need not fail: it only must not do better than Memory.
    const better = without.passed > memory.passed
    console.log(`  memory ${String(memory.passed)}/${String(memory.total)} vs control ${String(without.passed)}/${String(without.total)}${better ? ' — CONTROL IS BETTER' : ''}`)
    result.control = {
      pass: control.pass,
      better,
      memory: memory.passed,
      without: without.passed,
      scored: memory.total,
      steps: control.steps,
      tokens: control.tokens,
      durationMs: control.durationMs,
    }
  }
  scenarios.push(result)
}
if (KEEP) console.log(`scratch kept at ${ROOT}`)
else rmSync(ROOT, { recursive: true, force: true })

const controlBetter = scenarios.filter(scenario => scenario.control?.better === true)
const passed = scenarios.filter(scenario => scenario.pass).length
const durations = scenarios.flatMap(scenario => scenario.sessionDurations).sort((left, right) => left - right)
const p50 = durations.length === 0 ? 0 : durations[Math.floor(durations.length / 2)]
const metrics = {
  inputTokens: scenarios.reduce((sum, scenario) => sum + scenario.tokens.inputTokens, 0),
  outputTokens: scenarios.reduce((sum, scenario) => sum + scenario.tokens.outputTokens, 0),
  sessions: durations.length,
  p50SessionMs: p50,
}
const report = {
  version: 1,
  ...process.env.GITHUB_SHA === undefined ? {} : { gitSha: process.env.GITHUB_SHA },
  model: MOCK ? MOCK_MODEL : DATA.model,
  dataset: DATA.version,
  scenarios,
  metrics,
  ...CONTROL && { control: { better: controlBetter.map(scenario => scenario.name), scenarios: scenarios.length } },
  passRate: passed / scenarios.length,
  passed,
  total: scenarios.length,
}
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(REPORT_MD, renderBehaviorReport(report))
console.log(`\n${String(passed)}/${String(scenarios.length)} scenarios passed`)
console.log(`tokens: ${String(metrics.inputTokens)} in / ${String(metrics.outputTokens)} out over ${String(metrics.sessions)} sessions; p50 session ${String(metrics.p50SessionMs)} ms`)
if (CONTROL) {
  console.log(`control: ${String(controlBetter.length)} scenario(s) where switching Memory off did better`)
  if (controlBetter.length > 0) console.error(`  ${controlBetter.map(scenario => `${scenario.name} (memory ${String(scenario.control.memory)}/${String(scenario.control.scored)}, control ${String(scenario.control.without)}/${String(scenario.control.scored)})`).join('; ')}`)
}
console.log('note: usage covers agent turns and consolidation audits; summary-refresh calls are not attributed to a session event')

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : undefined
if (UPDATE_BASELINE) {
  const next = { ...baseline, version: 1, behavior: { passed: scenarios.filter(scenario => scenario.pass).map(scenario => scenario.name) } }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`baseline updated: ${BASELINE_PATH}`)
}
if (!UPDATE_BASELINE && ONLY === undefined && Array.isArray(baseline?.behavior?.passed)) {
  const regressed = baseline.behavior.passed.filter(name => !scenarios.find(scenario => scenario.name === name)?.pass)
  if (regressed.length > 0) {
    console.error(`\nbehavior regressed: ${regressed.join(', ')}`)
    process.exitCode = 1
  }
}
if (passed < scenarios.length) process.exitCode = 1
if (controlBetter.length > 0) process.exitCode = 1
