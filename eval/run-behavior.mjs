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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EVAL = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(EVAL, '..')
const REPO = process.env.DSH_REPO ?? resolve(PLUGIN, '../..')
const CLI = process.env.DSH_CLI ?? join(REPO, 'apps/cli/src/bin.ts')
const DATA = JSON.parse(readFileSync(join(EVAL, 'data/scenarios.json'), 'utf8'))
const BASELINE_PATH = join(EVAL, 'baseline.json')
const REPORT_PATH = join(EVAL, 'report-behavior.json')
const SESSION_TIMEOUT_MS = 180_000

const CONFIG_ONLY = process.argv.includes('--check')
const UPDATE_BASELINE = process.argv.includes('--update-baseline')
const MOCK = process.argv.includes('--mock')
/** Route the scripted adapter owns; used by `--mock` to check the plumbing without a key. */
const MOCK_MODEL = { provider: 'dsh-reflection-mock', model: 'dsh-reflection-mock', reasoningEffort: undefined }

const { userLayout, projectLayout, registryLayout, tombstoneLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.ts')).href)
const { bindProject } = await import(pathToFileURL(join(PLUGIN, 'src/registry.ts')).href)
const { addMemory, supersedeMemory } = await import(pathToFileURL(join(PLUGIN, 'src/actions.ts')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.ts')).href)

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
function writeOverlay({ projectDir, home, model, dir }) {
  const lines = [
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
  ]
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
async function runSession({ task, projectDir, home, model, dir }) {
  const patch = writeOverlay({ projectDir, home, model, dir })
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    ...MOCK ? { DSH_MEMORY_MOCK_TRIGGER: '记住' } : {},
  }
  const args = ['--import', 'tsx/esm', CLI, '--profile', 'headless', '--patch', patch, '--json', task]
  const cwd = existsSync(join(REPO, 'apps/cli/src/bin.ts')) ? REPO : PLUGIN
  const outcome = await new Promise(settle => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const guard = setTimeout(() => child.kill('SIGKILL'), SESSION_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(guard); settle({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` }) })
    child.on('close', code => { clearTimeout(guard); settle({ code, stdout, stderr }) })
  })
  const events = outcome.stdout.split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const final = events.filter(event => event.type === 'final').at(-1)
  const tools = events.filter(event => event.type === 'tool_call').map(event => String(event.name))
  const failure = final?.reason?.kind === 'error' ? String(final.reason.error?.message ?? 'model call failed') : undefined
  return { code: outcome.code, answer: String(final?.text ?? '').trim(), tools, stderr: outcome.stderr.trim(), failure }
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
function checkStore({ home, scope, project, projectId, contains }) {
  const storePath = scope === 'user' ? userLayout(join(home, 'memory')).storePath : projectLayout(join(home, 'memory'), projectId(project)).storePath
  const records = readStore(storePath).records.filter(record => record.status === 'active')
  for (const needle of contains) {
    if (!records.some(record => record.content.includes(needle))) {
      return fail(`store ${scope}${project === undefined ? '' : `/${project}`} has no active record containing ${JSON.stringify(needle)}`)
    }
  }
  return pass()
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
  await supersedeMemory(options, { id: record.id, content: to, ...scope === 'project' ? { projectId } : {} })
}

/**
 * Run one scenario end to end.
 * @param scenario - the labeled scenario.
 * @param index - its position, used to name the scratch directory.
 * @returns the scenario result.
 */
async function runScenario(scenario, index) {
  const dir = join(ROOT, `${String(index)}-${scenario.name}`)
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
  const steps = []
  const started = Date.now()
  for (const [stepIndex, step] of scenario.steps.entries()) {
    const label = `${String(stepIndex + 1)}.${Object.keys(step).join('+')}`
    try {
      if (step.seed !== undefined) {
        await seed({ home, ...step.seed, ...step.seed.project === undefined ? {} : { projectId: projectIds.get(step.seed.project) } })
        steps.push({ label, pass: true })
      } else if (step.supersede !== undefined) {
        await supersede({ home, ...step.supersede, ...step.supersede.project === undefined ? {} : { projectId: projectIds.get(step.supersede.project) } })
        steps.push({ label, pass: true })
      } else if (step.assertStore !== undefined) {
        const result = checkStore({ home, ...step.assertStore, projectId: name => projectIds.get(name) })
        steps.push({ label, ...result })
      } else if (step.session !== undefined) {
        const projectDir = projectDirs.get(step.session.project)
        if (projectDir === undefined) throw new Error(`eval: ${scenario.name} names an unknown project ${step.session.project}`)
        const session = await runSession({ task: step.session.task, projectDir, home, model: MOCK ? MOCK_MODEL : DATA.model, dir })
        if (session.failure !== undefined) {
          steps.push({ label, ...fail(session.failure) })
        } else if (session.code !== 0) {
          steps.push({ label, ...fail(`exit ${String(session.code)}: ${session.stderr.slice(0, 300)}`) })
        } else if (step.expect !== undefined) {
          const result = checkAnswer(session.answer, step.expect)
          steps.push({ label, ...result, answer: session.answer, tools: session.tools })
        } else {
          steps.push({ label, pass: true, answer: session.answer, tools: session.tools })
        }
      } else {
        throw new Error(`eval: unknown step ${JSON.stringify(step)}`)
      }
    } catch (error) {
      steps.push({ label, ...fail(error instanceof Error ? error.message : String(error)) })
    }
  }
  return { name: scenario.name, pass: steps.every(step => step.pass), durationMs: Date.now() - started, steps }
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
for (const [index, scenario] of DATA.scenarios.entries()) {
  process.stdout.write(`\n=== ${scenario.name} ===\n`)
  const result = await runScenario(scenario, index)
  scenarios.push(result)
  for (const step of result.steps) {
    console.log(`  ${step.pass ? 'ok  ' : 'FAIL'} ${step.label}${step.detail === undefined ? '' : ` — ${step.detail}`}`)
    if (step.answer !== undefined && !step.pass) console.log(`       answer: ${step.answer.slice(0, 300)}`)
  }
  console.log(`  ${result.pass ? 'PASS' : 'FAIL'} ${scenario.name} (${String(result.durationMs)} ms)`)
}
rmSync(ROOT, { recursive: true, force: true })

const passed = scenarios.filter(scenario => scenario.pass).length
const report = {
  version: 1,
  model: MOCK ? MOCK_MODEL : DATA.model,
  dataset: DATA.version,
  scenarios,
  passRate: passed / scenarios.length,
  passed,
  total: scenarios.length,
}
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
console.log(`\n${String(passed)}/${String(scenarios.length)} scenarios passed`)

const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : undefined
if (UPDATE_BASELINE) {
  const next = { ...baseline, version: 1, behavior: { passed: scenarios.filter(scenario => scenario.pass).map(scenario => scenario.name) } }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`baseline updated: ${BASELINE_PATH}`)
}
if (!UPDATE_BASELINE && Array.isArray(baseline?.behavior?.passed)) {
  const regressed = baseline.behavior.passed.filter(name => !scenarios.find(scenario => scenario.name === name)?.pass)
  if (regressed.length > 0) {
    console.error(`\nbehavior regressed: ${regressed.join(', ')}`)
    process.exitCode = 1
  }
}
if (passed < scenarios.length) process.exitCode = 1
