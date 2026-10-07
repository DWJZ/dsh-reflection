/**
 * Instruction replay suite.
 *
 * The replay exists because workspace instructions travel as `user/message`, so a
 * compaction folds the older copies into its summary. These assertions drive the
 * slot the way the event feed does and the context the way the assembler does, so
 * the newest-copy rule, the byte budget, and the once-only delivery are exercised
 * rather than assumed.
 *
 * Usage: `node test/replay.spec.mjs`.
 */
import { createStubContext } from './fixtures/stub-context.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createInstructionReplay, registerInstructionReplay, REPLAY_NAME, REPLAY_ORDER, REPLAY_HEADING } =
  await import(pathToFileURL(join(PLUGIN, 'src/replay.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const SESSION = 'session-replay'
const agent = { session: { id: SESSION, header: { id: SESSION, cwd: '/tmp/project' } } }

/** One instruction publication, shaped as the agent-instructions layer writes it. */
const publication = (seq, scope, text, digest) => ({
  type: 'user/message',
  seq,
  data: {
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'replace', scope, path: 'AGENTS.md', digest }] },
    content: [{ type: 'text', text }],
  },
})

/** One compaction that consumed [start, end]. */
const compaction = (start, end) => ({
  type: 'compaction/summary',
  seq: end + 1,
  data: { compactionId: 'c1', shadowedRange: { start, end } },
})

console.log('the newest copy per scope is what gets replayed')
const scope = '.\u0000AGENTS.md'
const replay = createInstructionReplay()
check('a publication alone queues nothing', replay.observe(SESSION, publication(5, scope, '旧规则', 'd1')) === null)
check('nothing is queued before a compaction', replay.render(agent, 10_000) === '')
const queued = replay.observe(SESSION, compaction(1, 10))
check('a compaction that consumed the copy queues a replay',
  queued !== null && queued.scope === scope && queued.seq === 5)
check('the replay carries the instruction text and the heading',
  replay.render(agent, 10_000).includes('旧规则') && replay.render(agent, 10_000).includes(REPLAY_HEADING))

replay.observe(SESSION, publication(7, scope, '新规则', 'd2'))
const replaced = replay.observe(SESSION, compaction(1, 12))
check('a newer copy of the same scope replaces the older one',
  replaced !== null && replaced.digest === 'd2' && replay.render(agent, 10_000).includes('新规则'))
check('the retired copy is not replayed too', !replay.render(agent, 10_000).includes('旧规则'))

console.log('only what the compaction consumed is replayed')
const untouched = createInstructionReplay()
untouched.observe(SESSION, publication(50, scope, '近期规则', 'd3'))
check('a copy outside the shadowed range queues nothing', untouched.observe(SESSION, compaction(1, 10)) === null)
check('and renders nothing', untouched.render(agent, 10_000) === '')

console.log('delivery is once, and identical content is not re-queued')
const once = createInstructionReplay()
once.observe(SESSION, publication(5, scope, '规则', 'd4'))
check('the first compaction queues it', once.observe(SESSION, compaction(1, 10)) !== null)
check('the same digest is not queued twice', once.observe(SESSION, compaction(1, 10)) === null)
check('it is still pending until delivered', once.render(agent, 10_000) !== '')
once.clear(SESSION)
check('clear drops it, so it is delivered once', once.render(agent, 10_000) === '')

console.log('the budget counts UTF-8 bytes, not code points')
const bytes = createInstructionReplay()
// 20 CJK characters: 20 code points, 60 UTF-8 bytes.
const wide = '中'.repeat(20)
bytes.observe(SESSION, publication(5, scope, wide, 'd5'))
bytes.observe(SESSION, compaction(1, 10))
// Budget the heading plus room for exactly two CJK characters: three bytes each.
const budget = Buffer.byteLength(REPLAY_HEADING, 'utf8') + 6
const trimmed = bytes.render(agent, budget)
check('the trimmed replay fits its byte budget', Buffer.byteLength(trimmed, 'utf8') <= budget,
  `${String(Buffer.byteLength(trimmed, 'utf8'))} bytes`)
check('it kept one CJK character (the separator costs two bytes), which a code-point cap would not',
  Array.from(trimmed).filter(character => character === '中').length === 1,
  `${String(Array.from(trimmed).filter(character => character === '中').length)} characters`)

console.log('the registered context is what the assembler calls')
const ctx = createStubContext()
const wired = createInstructionReplay()
registerInstructionReplay(ctx, wired, 10_000)
const entry = ctx.registrations.contexts.find(context => context.name === REPLAY_NAME)
check('the context is registered under its name', entry !== undefined && entry.order === REPLAY_ORDER)
check('a bare assemble renders nothing', entry.text({}) === '')
wired.observe(SESSION, publication(5, scope, '装配期规则', 'd6'))
wired.observe(SESSION, compaction(1, 10))
check('the assembler sees the replay', entry.text({ agent }).includes('装配期规则'))
check('an agent for another Session sees nothing', entry.text({ agent: { session: { id: 'other' } } }) === '')

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
