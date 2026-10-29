/**
 * Negative control for the concurrent write suite: a read-modify-write that
 * takes no lock.
 *
 * Its only purpose is to show that the hazard the store lock prevents is real
 * and that the suite can observe it. The write itself is still atomic, so the
 * only thing missing is the lock.
 *
 * Usage: `node test/fixtures/mutate-worker-unsafe.mjs <storePath> <prefix> <holdMs>`.
 */
import { readStore, writeAtomic } from '../../src/jsonstore.js'
import { memoryRecord } from './records.mjs'

const [storePath, prefix, rawHold] = process.argv.slice(2)
const holdMs = Number(rawHold)

const store = readStore(storePath)
// The pause is the whole point: the second writer reads the same revision.
await new Promise(resolve => { setTimeout(resolve, holdMs) })
// Version 1 carries text in the index, so the control needs no body files; the
// hazard under test is the missing lock, not the layout.
writeAtomic(storePath, `${JSON.stringify({
  schema_version: 1,
  revision: store.revision + 1,
  records: [...store.records, memoryRecord({ content: `${prefix}-0` })],
}, null, 2)}\n`)
