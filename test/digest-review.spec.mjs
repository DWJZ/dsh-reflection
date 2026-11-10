/**
 * Review suite: the pending queue the Settings page reads, the two actions it
 * offers, and the routes that carry them.
 *
 * The queue is a file, so these assertions drive the real one: a candidate list is
 * written, a selection is applied or dropped, and the files are read back. The
 * route section drives the handlers the way the Web host does, including the
 * requests a browser on another origin would send.
 *
 * Usage: `node --import tsx/esm test/digest-review.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStubContext, disposeEffects } from './fixtures/stub-context.mjs'
import { memoryRecord, projectId, AT } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const review = await import(pathToFileURL(join(PLUGIN, 'src/digest/review.js')).href)
const web = await import(pathToFileURL(join(PLUGIN, 'src/web.js')).href)
const { readStore, withStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { digestLayout, projectLayout, registryLayout, tombstoneLayout, userLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { writeDigestState } = await import(pathToFileURL(join(PLUGIN, 'src/digest/state.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-review-'))
const MEMORY = join(ROOT, 'memory')
const REG = registryLayout(MEMORY)
const DIGEST = digestLayout(MEMORY)
const NOW = Date.parse('2026-11-08T00:00:00.000Z')
const PROJECT_A = projectId()
const PROJECT_B = projectId()

mkdirSync(REG.dir, { recursive: true })
writeFileSync(REG.registryPath, `${JSON.stringify({
  schema_version: 1,
  revision: 1,
  projects: [PROJECT_A, PROJECT_B].map((id, index) => ({
    project_id: id,
    canonical_root: `/tmp/project-${String(index)}`,
    aliases: [],
    workspace_ids: [],
    created_at: AT,
    updated_at: AT,
  })),
}, null, 2)}\n`)

/** Seed one project with one record, so apply has a real source to archive. */
async function seedProject(projectIdValue, content) {
  const layout = projectLayout(MEMORY, projectIdValue)
  const record = memoryRecord({ scope: 'project', project_id: projectIdValue, content, title: `${content} title` })
  await withStore({ storePath: layout.storePath, lockPath: layout.lockPath, recordsDir: layout.recordsDir, lockTimeoutMs: 2000, staleLockMs: 60000 }, current => ({
    changed: true,
    records: [...current.records, record],
  }))
  return record
}

const sourceA = await seedProject(PROJECT_A, 'alpha workspace fact')
const sourceB = await seedProject(PROJECT_B, 'beta workspace fact')

/** The wiring the plugin hands the review surface. */
const deps = {
  config: { memoryDir: MEMORY, lockTimeoutMs: 2000, staleLockMs: 60000, maxEvidencePerMemory: 8 },
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

/** One candidate naming both projects, as the digest validation would accept. */
const candidate = (index, extra = {}) => ({
  title: `Candidate ${String(index)}`,
  content: `Cross-project practice ${String(index)}.`,
  scope: 'practice',
  derived_from: [
    { project_id: PROJECT_A, record_id: sourceA.id },
    { project_id: PROJECT_B, record_id: sourceB.id },
  ],
  ...extra,
})

/**
 * Write one pending document.
 * @param candidates - the candidates it holds.
 * @param overrides - fields to replace.
 * @returns the scan time the document was written with.
 */
function writePending(candidates, overrides = {}) {
  mkdirSync(DIGEST.dir, { recursive: true })
  const document = {
    version: 1,
    created_at: '2026-11-06T16:00:00.000Z',
    scan_from: '2026-10-29T00:51:58.572Z',
    scan_to: '2026-11-06T16:00:00.000Z',
    model: 'deepseek-account/deepseek-flash',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    candidates,
    rejected: [{ title: 'One workspace', reason: 'fewer than two workspaces', workspaces: 1 }],
    ...overrides,
  }
  writeFileSync(DIGEST.pendingPath, `${JSON.stringify(document, null, 2)}\n`)
  writeFileSync(DIGEST.pendingMarkdownPath, '# pending\n')
  return document
}

/** Remove everything the digest directory holds, so each section starts clean. */
function clearDigest() {
  rmSync(DIGEST.dir, { recursive: true, force: true })
}

console.log('reading the queue')
clearDigest()
{
  writeDigestState(DIGEST.statePath, { lastScanAt: '2026-11-06T16:00:00.339Z' })
  const empty = review.readReviewState(deps)
  check('an absent pending file reads as nothing pending', empty.pending === null && empty.problem === undefined, JSON.stringify(empty))
  check('the last scan is reported even with no queue', empty.lastScanAt === '2026-11-06T16:00:00.339Z', JSON.stringify(empty.lastScanAt))
  check('the switch is reported', empty.enabled === true)

  writePending([candidate(1), candidate(2)])
  const state = review.readReviewState(deps)
  check('the queue is read with 1-based candidate numbers',
    state.pending.candidates.map(entry => entry.index).join(',') === '1,2',
    JSON.stringify(state.pending?.candidates?.map(entry => entry.index)))
  check('each source is named by its project, not only by its id',
    state.pending.candidates[0].sources.map(source => source.project).join(',') === 'project-0,project-1',
    JSON.stringify(state.pending.candidates[0].sources))
  check('the canonical root is carried for the tooltip',
    state.pending.candidates[0].sources[0].project_root === '/tmp/project-0',
    JSON.stringify(state.pending.candidates[0].sources[0]))
  check('the rejected candidates and their reason are carried',
    state.pending.rejected.length === 1 && state.pending.rejected[0].reason === 'fewer than two workspaces'
    && state.pending.rejected[0].workspaces === 1,
    JSON.stringify(state.pending.rejected))
  check('the window and the model ride along',
    state.pending.scan_to === '2026-11-06T16:00:00.000Z' && state.pending.model === 'deepseek-account/deepseek-flash')

  writeFileSync(DIGEST.pendingPath, '{"version":1,"created_at":"2026-11-06T16:00:00.000Z","scan_to":"2026-11-06T16:00:00.000Z"}\n')
  const broken = review.readReviewState(deps)
  check('a malformed queue is reported instead of thrown',
    broken.pending === null && typeof broken.problem === 'string' && broken.problem.includes('candidates'),
    JSON.stringify(broken))

  writeFileSync(DIGEST.pendingPath, 'not json\n')
  const invalid = review.readReviewState(deps)
  check('a file that is not JSON is reported too',
    invalid.pending === null && typeof invalid.problem === 'string' && invalid.problem.includes('JSON'),
    JSON.stringify(invalid.problem))
}

console.log('applying a selection')
clearDigest()
{
  writePending([candidate(1), candidate(2)])
  const applied = await review.applyReview(deps, undefined, { selection: [2], expectedScanTo: '2026-11-06T16:00:00.000Z' })
  check('the selected candidate is applied', applied.status === 'applied' && applied.applied === 1, JSON.stringify(applied))
  check('its two sources are archived', applied.status === 'applied' && applied.archived === 2, JSON.stringify(applied))
  check('the unselected candidate stays pending', applied.status === 'applied' && applied.remaining === 1, JSON.stringify(applied))
  check('no Session record is claimed without an agent', applied.status === 'applied' && applied.audited === false)
  const user = readStore(userLayout(MEMORY).storePath)
  check('the promoted record names the unselected candidate',
    user.records.length === 1 && user.records[0].title === 'Candidate 2', JSON.stringify(user.records.map(entry => entry.title)))
  const pending = JSON.parse(readFileSync(DIGEST.pendingPath, 'utf8'))
  check('the pending file keeps only the unselected candidate',
    pending.candidates.length === 1 && pending.candidates[0].title === 'Candidate 1',
    JSON.stringify(pending.candidates.map(entry => entry.title)))

  const missing = await review.applyReview(deps, undefined, { selection: [1, 2] })
  check('a selection naming a candidate that is gone is refused as stale-free but invalid',
    missing.status === 'error' && missing.code === 'invalid-selection', JSON.stringify(missing))

  const stale = await review.applyReview(deps, undefined, { selection: [1], expectedScanTo: '2026-01-01T00:00:00.000Z' })
  check('a queue that changed since it was read is refused', stale.status === 'error' && stale.code === 'stale', JSON.stringify(stale))

  const none = await review.applyReview({ ...deps, isEnabled: () => false }, undefined, { selection: [1] })
  check('a disabled plugin refuses the action', none.status === 'error' && none.code === 'disabled', JSON.stringify(none))

  const all = await review.applyReview(deps, undefined, { selection: [1] })
  check('applying the last candidate empties the queue', all.status === 'applied' && all.remaining === 0, JSON.stringify(all))
  check('the emptied queue moved to history', all.status === 'applied' && typeof all.historyPath === 'string'
    && existsSync(all.historyPath) && !existsSync(DIGEST.pendingPath), JSON.stringify(all))

  const nothing = await review.applyReview(deps, undefined, { selection: [1] })
  check('applying with no queue is refused', nothing.status === 'error' && nothing.code === 'no-pending', JSON.stringify(nothing))
}

console.log('dropping a selection')
clearDigest()
{
  writePending([candidate(1), candidate(2), candidate(3)])
  const before = readStore(userLayout(MEMORY).storePath).records.length
  const dropped = review.discardReview(deps, { selection: [1, 3], expectedScanTo: '2026-11-06T16:00:00.000Z' })
  check('the selected candidates are dropped', dropped.status === 'discarded' && dropped.discarded === 2, JSON.stringify(dropped))
  check('the rest stay pending', dropped.status === 'discarded' && dropped.remaining === 1, JSON.stringify(dropped))
  const pending = JSON.parse(readFileSync(DIGEST.pendingPath, 'utf8'))
  check('the pending file keeps the middle candidate',
    pending.candidates.length === 1 && pending.candidates[0].title === 'Candidate 2',
    JSON.stringify(pending.candidates.map(entry => entry.title)))
  check('the markdown copy follows the JSON',
    readFileSync(DIGEST.pendingMarkdownPath, 'utf8').includes('Candidate 2'))
  const archives = readdirSync(join(DIGEST.dir, 'discarded'))
  check('the decision is archived', archives.length === 1, JSON.stringify(archives))
  const archive = JSON.parse(readFileSync(join(DIGEST.dir, 'discarded', archives[0]), 'utf8'))
  check('the archive names what was dropped',
    archive.candidates.length === 2 && archive.discarded_at === new Date(NOW).toISOString(),
    JSON.stringify(archive))
  check('dropping writes no Memory', readStore(userLayout(MEMORY).storePath).records.length === before)

  const invalid = review.discardReview(deps, { selection: [] })
  check('an empty selection is refused', invalid.status === 'error' && invalid.code === 'invalid-selection', JSON.stringify(invalid))

  const rest = review.discardReview(deps, { selection: [1] })
  check('dropping the last candidate empties the queue', rest.status === 'discarded' && rest.remaining === 0, JSON.stringify(rest))
  check('no pending files remain', !existsSync(DIGEST.pendingPath) && !existsSync(DIGEST.pendingMarkdownPath))
}

console.log('the routes the page calls')
clearDigest()
{
  writePending([candidate(1), candidate(2)])

  const routes = new Map()
  const ctx = createStubContext()
  ctx.webServer = {
    register: (route) => {
      routes.set(route.path, route.handler)
      return () => { routes.delete(route.path) }
    },
  }
  const fiber = web.mountReviewRoutes(ctx, { deps, agent: () => undefined })
  check('three exact routes are registered',
    routes.has(web.REVIEW_PATH) && routes.has(web.REVIEW_APPLY_PATH) && routes.has(web.REVIEW_DISCARD_PATH),
    JSON.stringify([...routes.keys()]))

  const request = (overrides = {}) => {
    const chunks = overrides.body === undefined ? [] : [Buffer.from(overrides.body, 'utf8')]
    return {
      method: overrides.method ?? 'GET',
      url: web.REVIEW_PATH,
      headers: { host: '127.0.0.1:19388', origin: 'http://127.0.0.1:19388', ...overrides.headers },
      socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
  }
  const response = () => {
    const state = { status: 0, headers: {}, body: '' }
    let settle
    const done = new Promise((resolveDone) => { settle = resolveDone })
    return {
      state,
      done,
      writeHead(status, headers) { state.status = status; state.headers = { ...headers } },
      end(body) { state.body = body ?? ''; settle() },
    }
  }
  const call = async (routeName, overrides) => {
    const res = response()
    await routes.get(routeName)(request(overrides), res)
    await res.done
    let payload
    try { payload = JSON.parse(res.state.body) } catch { payload = undefined }
    return { status: res.state.status, headers: res.state.headers, payload }
  }

  const read = await call(web.REVIEW_PATH)
  check('the read route answers the queue', read.status === 200 && read.payload.ok === true
    && read.payload.state.pending.candidates.length === 2, JSON.stringify(read.payload))
  check('the response is JSON and never cached',
    read.headers['content-type'] === 'application/json; charset=utf-8' && read.headers['cache-control'] === 'no-store',
    JSON.stringify(read.headers))

  const offHost = await call(web.REVIEW_PATH, { remoteAddress: '10.0.0.7' })
  check('a request from another host is refused', offHost.status === 403, String(offHost.status))
  const proxied = await call(web.REVIEW_PATH, { headers: { 'x-forwarded-for': '10.0.0.7' } })
  check('a proxied request is refused', proxied.status === 403, String(proxied.status))
  const crossOrigin = await call(web.REVIEW_PATH, { headers: { origin: 'http://evil.example' } })
  check('a cross-origin request is refused', crossOrigin.status === 403, String(crossOrigin.status))
  const wrongMethod = await call(web.REVIEW_PATH, { method: 'POST' })
  check('the read route refuses another method', wrongMethod.status === 405, String(wrongMethod.status))

  const badBody = await call(web.REVIEW_APPLY_PATH, { method: 'POST', body: 'not json' })
  check('an unparseable action body is refused', badBody.status === 400 && badBody.payload.code === 'bad-request', JSON.stringify(badBody.payload))
  const stale = await call(web.REVIEW_APPLY_PATH, {
    method: 'POST',
    body: JSON.stringify({ selection: [1], expectedScanTo: '2026-01-01T00:00:00.000Z' }),
  })
  check('a stale action is refused with 409', stale.status === 409 && stale.payload.code === 'stale', JSON.stringify(stale.payload))
  const invalidSelection = await call(web.REVIEW_APPLY_PATH, { method: 'POST', body: JSON.stringify({ selection: [9] }) })
  check('an out-of-range selection is refused with 400',
    invalidSelection.status === 400 && invalidSelection.payload.code === 'invalid-selection', JSON.stringify(invalidSelection.payload))

  // Two tabs acting on the same queue at once. The first applies both candidates
  // and removes the pending file; the second must then read the queue it missed
  // rather than apply stale candidate numbers.
  const body = JSON.stringify({ selection: [1, 2] })
  const [left, right] = await Promise.all([
    call(web.REVIEW_APPLY_PATH, { method: 'POST', body }),
    call(web.REVIEW_APPLY_PATH, { method: 'POST', body }),
  ])
  const statuses = [left.status, right.status].sort()
  check('two actions never interleave: one applies, the other sees the queue it missed',
    statuses[0] === 200 && statuses[1] === 409, JSON.stringify([left.status, right.status]))
  const applied = left.status === 200 ? left : right
  check('the applied action reports what it wrote',
    applied.payload?.applied === 2 && applied.payload?.remaining === 0, JSON.stringify(applied.payload))

  // The stub records effect disposers globally rather than per injection, so the
  // route removal is proved through the disposers the mount registered.
  await disposeEffects(ctx)
  check('disposing the registrations removes the routes', routes.size === 0, JSON.stringify([...routes.keys()]))
  check('the mount returns the fiber that owns them', typeof fiber.dispose === 'function')
}

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
