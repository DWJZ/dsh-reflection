/**
 * Daily digest schedule: one scan at 00:00 Asia/Shanghai, skipped while the
 * plugin is off, and re-armed after every night whether the scan ran or not.
 *
 * Usage: `node --import tsx/esm test/digest-schedule.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { nextBeijingMidnight, createDailyDigest } = await import(pathToFileURL(join(PLUGIN, 'src/digest/schedule.ts')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('midnight arithmetic is Beijing time')
{
  check('23:59 Beijing is one minute before midnight',
    nextBeijingMidnight(Date.parse('2026-11-06T15:59:00Z')) === Date.parse('2026-11-06T16:00:00Z'),
    new Date(nextBeijingMidnight(Date.parse('2026-11-06T15:59:00Z'))).toISOString())
  check('exactly midnight schedules the next day',
    nextBeijingMidnight(Date.parse('2026-11-06T16:00:00Z')) === Date.parse('2026-11-07T16:00:00Z'))
  check('04:30 Beijing the next day is still the coming midnight',
    nextBeijingMidnight(Date.parse('2026-11-06T20:30:00Z')) === Date.parse('2026-11-07T16:00:00Z'))
  // Beijing has no daylight saving; the US change on this date must not move it.
  check('a US daylight-saving boundary does not move the schedule',
    nextBeijingMidnight(Date.parse('2026-11-01T09:00:00Z')) === Date.parse('2026-11-01T16:00:00Z'))
  const now = Date.parse('2026-11-06T03:21:00Z')
  const delay = nextBeijingMidnight(now) - now
  check('the delay is never more than a day', delay > 0 && delay <= 86_400_000, String(delay))
}

/** A timer with an injectable clock and scheduler. */
const make = (overrides = {}) => {
  const log = []
  let scheduled
  let fireCount = 0
  const timer = createDailyDigest({
    run: async () => { fireCount += 1; log.push('run') },
    enabled: () => true,
    now: () => Date.parse('2026-11-06T15:59:00Z'),
    schedule: (run, ms) => {
      scheduled = { run, ms }
      return { kind: 'timer' }
    },
    cancelSchedule: () => { log.push('cancel'); scheduled = undefined },
    logger: { info: message => log.push(`info:${message}`), warn: message => log.push(`warn:${String(message)}`) },
    ...overrides,
  })
  return {
    timer,
    log,
    /** Fire the armed timer and wait for the scan it starts. */
    async fire() {
      const current = scheduled
      scheduled = undefined
      await current.run()
    },
    /** The timer that would fire next, or undefined. */
    next: () => scheduled,
    runs: () => fireCount,
  }
}

console.log('the timer arms at the next Beijing midnight')
{
  const a = make()
  a.timer.start()
  check('one timer is armed', a.next() !== undefined)
  check('the delay points at midnight', a.next().ms === 60_000, String(a.next().ms))
}

console.log('firing runs the digest and arms tomorrow')
{
  const a = make()
  a.timer.start()
  await a.fire()
  check('the digest ran once', a.runs() === 1)
  check('the next midnight is armed', a.next() !== undefined)
  check('a second scan is not started by a stale timer', a.next().ms === 60_000)
}

console.log('a disabled plugin skips the model call')
{
  const a = make({ enabled: () => false })
  a.timer.start()
  await a.fire()
  check('nothing ran', a.runs() === 0)
  check('the skip is logged', a.log.some(entry => entry.startsWith('info:')))
  check('the next midnight still is armed', a.next() !== undefined)
}

console.log('a failed scan is a warning, and the schedule survives')
{
  const a = make({ run: async () => { throw new Error('model route gone') } })
  a.timer.start()
  await a.fire()
  check('the failure is logged', a.log.some(entry => entry.startsWith('warn:') && entry.includes('model route gone')))
  check('the next midnight is armed', a.next() !== undefined)
}

console.log('a running scan is awaited by whenSettled')
{
  let release
  const gate = new Promise(resolve => { release = resolve })
  const log = []
  let scheduled
  const timer = createDailyDigest({
    run: async () => { log.push('run'); await gate },
    enabled: () => true,
    now: () => Date.parse('2026-11-06T15:59:00Z'),
    schedule: (run, ms) => { scheduled = { run, ms }; return { kind: 'timer' } },
    cancelSchedule: () => {},
    logger: { info: () => {}, warn: () => {} },
  })
  timer.start()
  const first = scheduled
  scheduled = undefined
  const running = first.run()
  let settled = false
  const waiting = timer.whenSettled().then(() => { settled = true })
  await Promise.resolve()
  check('the scan is still running', log.length === 1 && settled === false)
  release()
  await running
  await waiting
  check('settlement resolves when the scan ends', settled === true)
  check('the next midnight is armed after settlement', scheduled !== undefined)
}

console.log('dispose stops the schedule')
{
  const a = make()
  a.timer.start()
  a.timer.dispose()
  check('the pending timer is cancelled', a.log.includes('cancel'))
  check('nothing is armed after dispose', a.next() === undefined)
  a.timer.start()
  check('start after dispose does not re-arm', a.next() === undefined)
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
