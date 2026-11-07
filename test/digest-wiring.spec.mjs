/**
 * Daily digest wiring suite.
 *
 * The schedule module is tested on its own; this suite checks the controller
 * actually arms it: `autoDigest` decides whether one timer is created, the last
 * agent seen supplies the model route, a disabled plugin skips the scan, and
 * disposing the plugin cancels the pending timer.
 *
 * The long timers are replaced at the global boundary: the digest delay is
 * hours, so a real timer would never fire in a test, while the lock retry uses
 * short timers and keeps the real implementation.
 *
 * Usage: `node --import tsx/esm test/digest-wiring.spec.mjs`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStubContext, disposeEffects } from './fixtures/stub-context.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'src/index.js')).href)
const { nextBeijingMidnight } = await import(pathToFileURL(join(PLUGIN, 'src/digest/schedule.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-digest-wiring-'))

/** A fresh harness home: the persisted switch lives under it, so instances stay independent. */
const homeFor = (name) => {
  const home = join(ROOT, name)
  mkdirSync(join(home, 'project', '.git'), { recursive: true })
  return home
}
const DAY_MS = 86_400_000

/** One agent stub with a working directory and a resolved route. */
const agentStub = (sessionId, cwd) => ({
  status: 'running',
  session: {
    id: sessionId,
    header: { id: sessionId, cwd },
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  },
  runMaintenance: task => task(new AbortController().signal),
})

/** Start the plugin against a stub context. */
const startPlugin = (config) => {
  const ctx = createStubContext()
  plugin.apply(ctx, config)
  return ctx
}

/** Long timers the digest arms, captured instead of scheduled. */
const armed = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout

globalThis.setTimeout = (fn, ms, ...rest) => {
  // Lock acquisition retries with short sleeps; those must keep working.
  if (Number(ms) > 1000) {
    const handle = { fn, ms: Number(ms), cleared: false }
    armed.push(handle)
    return handle
  }
  return realSetTimeout(fn, ms, ...rest)
}
globalThis.clearTimeout = (handle) => {
  if (handle !== null && typeof handle === 'object' && 'cleared' in handle) {
    handle.cleared = true
    return
  }
  realClearTimeout(handle)
}

/** Fire the most recently armed digest timer and wait for the scan. */
const fireLast = async () => {
  const current = armed.at(-1)
  check('a digest timer is armed', current !== undefined)
  await current.fn()
}

try {
  console.log('the controller arms one daily timer')
  const homeA = homeFor('a')
  const a = startPlugin({ dshHome: homeA, enabled: true })
  check('one timer is armed', armed.length === 1, String(armed.length))
  const delay = armed[0]?.ms ?? 0
  check('the delay points at the next Beijing midnight',
    delay > 0 && delay <= DAY_MS
    && Math.abs(delay - (nextBeijingMidnight(Date.now()) - Date.now())) < 5_000,
    String(delay))

  console.log('no Session means no scan')
  await fireLast()
  check('the skip is logged', a.infos.some(message => message.includes('automatic digest skipped; no Session')))
  check('the timer is re-armed', armed.length === 2)

  console.log('agent/status supplies the route')
  a.emit('agent/status', { agent: agentStub('session-wiring', join(homeA, 'project')), status: 'running' })
  await fireLast()
  check('the scan was attempted',
    a.warnings.some(message => message.includes('automatic digest did not run') && message.includes('no model service')))

  console.log('disabling stops the scan at the next midnight')
  await a.registrations.commands[0].handler({ rawInput: 'disable', agent: agentStub('session-wiring', join(homeA, 'project')) })
  await fireLast()
  check('the disabled skip is logged', a.infos.some(message => message.includes('automatic digest skipped; Memory is off')))
  const before = armed.length
  await disposeEffects(a)
  check('dispose cancels the pending timer', armed.at(-1)?.cleared === true, JSON.stringify(armed.at(-1)))
  check('no new timer is armed after dispose', armed.length === before)

  console.log('agent/created supplies the route too')
  armed.length = 0
  const homeB = homeFor('b')
  const b = startPlugin({ dshHome: homeB, enabled: true })
  await b.emitAsync('agent/created', { agent: agentStub('session-created', join(homeB, 'project')) })
  await fireLast()
  check('the scan was attempted', b.warnings.some(message => message.includes('automatic digest did not run')))
  await disposeEffects(b)

  console.log('autoDigest false arms nothing')
  armed.length = 0
  const c = startPlugin({ dshHome: homeFor('c'), enabled: true, autoDigest: false })
  check('no timer is armed', armed.length === 0, String(armed.length))
  await disposeEffects(c)
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
