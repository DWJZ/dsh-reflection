/**
 * Session-history backfill suite.
 *
 * The reader turns the harness session-query window into the events a batch may
 * read, and refuses anything partial: a hole folded in half-read would be
 * consumed without the rest of it ever reaching the model.
 *
 * Usage: `node test/history.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createHistoryReader } = await import(pathToFileURL(join(PLUGIN, 'src/history.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** A context whose only service is the given session-query stand-in. */
const contextWith = service => ({ get: name => (name === 'sessionQuery' ? service : undefined) })

/** One raw event as the harness returns it. */
const raw = (seq, type = 'assistant/message', extra = {}) => ({ seq, type, time: 1000 + seq, data: { seq }, ...extra })

console.log('what the reader accepts')
{
  const service = { readEvent: async request => ({ events: [raw(1), raw(2), raw(3)] }) }
  const reader = createHistoryReader(contextWith(service))
  const events = await reader.read('session_a', 1, 3)
  check('a whole range comes back', events?.length === 3, JSON.stringify(events))
  check('the events carry seq, type, and data',
    events?.[0]?.seq === 1 && events?.[0]?.type === 'assistant/message' && events?.[0]?.data?.seq === 1)
  check('they are ordered by seq', events?.map(event => event.seq).join(',') === '1,2,3')
}

console.log('the window is asked for exactly the hole')
{
  const requests = []
  const service = { readEvent: async request => { requests.push(request); return { events: [raw(5), raw(6)] } } }
  const reader = createHistoryReader(contextWith(service))
  await reader.read('session_a', 5, 6)
  check('it targets the end of the range', requests[0]?.seq === 6, JSON.stringify(requests))
  check('it asks for the events before it', requests[0]?.before === 1 && requests[0]?.after === 0, JSON.stringify(requests))
  check('it names the Session', requests[0]?.sessionId === 'session_a')
}

console.log('an ignorable marker survives the read')
{
  const service = { readEvent: async () => ({ events: [raw(1, 'dsh-allow/check', { ignorable: true })] }) }
  const events = await createHistoryReader(contextWith(service)).read('session_a', 1, 1)
  check('the marker is kept', events?.[0]?.ignorable === true)
}

console.log('a partial range is refused')
{
  const short = { readEvent: async () => ({ events: [raw(2), raw(3)] }) }
  check('a missing head is refused', await createHistoryReader(contextWith(short)).read('session_a', 1, 3) === undefined)
  const missingTail = { readEvent: async () => ({ events: [raw(1), raw(2)] }) }
  check('a missing tail is refused', await createHistoryReader(contextWith(missingTail)).read('session_a', 1, 3) === undefined)
  const extra = { readEvent: async () => ({ events: [raw(0), raw(1), raw(2), raw(3), raw(4)] }) }
  const trimmed = await createHistoryReader(contextWith(extra)).read('session_a', 1, 3)
  check('events outside the range are dropped', trimmed?.map(event => event.seq).join(',') === '1,2,3', JSON.stringify(trimmed))
  const hole = { readEvent: async () => ({ events: [raw(1), raw(3)] }) }
  check('an interior hole is refused', await createHistoryReader(contextWith(hole)).read('session_a', 1, 3) === undefined)
}

console.log('a missing service keeps the old behavior')
{
  check('no context service', await createHistoryReader(contextWith(undefined)).read('session_a', 1, 3) === undefined)
  check('a service without readEvent', await createHistoryReader(contextWith({})).read('session_a', 1, 3) === undefined)
  check('a context without a resolver',
    await createHistoryReader({}).read('session_a', 1, 3) === undefined)
  const failing = { readEvent: async () => { throw new Error('storage is gone') } }
  check('a failed read is treated as unreadable',
    await createHistoryReader(contextWith(failing)).read('session_a', 1, 3) === undefined)
  const malformed = { readEvent: async () => ({ events: 'nope' }) }
  check('a malformed answer is refused',
    await createHistoryReader(contextWith(malformed)).read('session_a', 1, 3) === undefined)
}

console.log('a hole larger than the read cap stays a gap')
{
  let called = 0
  const service = { readEvent: async () => { called += 1; return { events: [] } } }
  const reader = createHistoryReader(contextWith(service))
  check('the oversized range is refused', await reader.read('session_a', 0, 5000) === undefined)
  check('and no read is attempted', called === 0)
}

console.log('a degenerate range asks nothing')
{
  let called = 0
  const service = { readEvent: async () => { called += 1; return { events: [] } } }
  const reader = createHistoryReader(contextWith(service))
  check('an inverted range reads nothing', (await reader.read('session_a', 3, 1))?.length === 0)
  check('and no model or storage call is made', called === 0)
}

if (failures > 0) {
  console.log(`\n${String(failures)} FAILURE(S)`)
  process.exitCode = 1
} else {
  console.log('\nPASS')
}
