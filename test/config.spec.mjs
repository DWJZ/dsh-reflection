/**
 * Configuration suite: defaults, fail-loud validation, and the cross-field rule
 * a per-field schema cannot express.
 *
 * Usage: `node test/config.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { DEFAULTS, resolveConfig } = await import(pathToFileURL(join(PLUGIN, 'src/config.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** Whether resolving this config throws a TypeError, and whether it names the field. */
const rejects = (raw, field) => {
  try {
    resolveConfig(raw, {})
    return false
  } catch (error) {
    return error instanceof TypeError && (field === undefined || error.message.includes(field))
  }
}

/** Resolve with a fixed environment so assertions never read this machine's home. */
const resolveWith = raw => resolveConfig(raw, { DSH_HOME: '/tmp/dsh-reflection-config-spec' })

console.log('defaults')
const base = resolveWith({})
check('enabled defaults to true', base.enabled === true)
check('the memory root is derived', base.memoryDir === join('/tmp/dsh-reflection-config-spec', 'memory'))
check('the summary budget defaults to 2400 bytes', base.summaryBudgetBytes === 2400)
check('retrievalTopK defaults to 8', base.retrievalTopK === 8)
check('projectRootMarkers defaults to .git',
  base.projectRootMarkers.length === 1 && base.projectRootMarkers[0] === '.git')
check('every documented default is resolved',
  Object.keys(DEFAULTS).every(key => base[key] !== undefined))

console.log('every default is overridable')
const overridden = resolveWith({
  enabled: false,
  summaryBudgetBytes: 900,
  retrievalTopK: 3,
  projectRootMarkers: ['.git', '.hg'],
  lockTimeoutMs: 250,
  staleLockMs: 500,
  maxEvidencePerMemory: 2,
  exportInlineMaxBytes: 999,
  evidenceQuoteMaxChars: 10,
})
check('enabled', overridden.enabled === false)
check('summaryBudgetBytes', overridden.summaryBudgetBytes === 900)
check('retrievalTopK', overridden.retrievalTopK === 3)
check('projectRootMarkers', overridden.projectRootMarkers.join(',') === '.git,.hg')
check('lockTimeoutMs', overridden.lockTimeoutMs === 250)
check('staleLockMs', overridden.staleLockMs === 500)
check('maxEvidencePerMemory', overridden.maxEvidencePerMemory === 2)
check('exportInlineMaxBytes', overridden.exportInlineMaxBytes === 999)
check('evidenceQuoteMaxChars', overridden.evidenceQuoteMaxChars === 10)

console.log('invalid values fail loud and name the field')
check('enabled rejects a non-boolean', rejects({ enabled: 'yes' }, 'enabled'))
check('summaryBudgetBytes rejects a negative value', rejects({ summaryBudgetBytes: -1 }, 'summaryBudgetBytes'))
check('retrievalTopK rejects zero', rejects({ retrievalTopK: 0 }, 'retrievalTopK'))
check('retrievalTopK rejects a fraction below the minimum', rejects({ retrievalTopK: 0.5 }, 'retrievalTopK'))
check('lockTimeoutMs rejects zero', rejects({ lockTimeoutMs: 0 }, 'lockTimeoutMs'))
check('staleLockMs rejects a negative value', rejects({ staleLockMs: -5 }, 'staleLockMs'))
check('maxEvidencePerMemory rejects zero', rejects({ maxEvidencePerMemory: 0 }, 'maxEvidencePerMemory'))
check('exportInlineMaxBytes rejects zero', rejects({ exportInlineMaxBytes: 0 }, 'exportInlineMaxBytes'))
check('evidenceQuoteMaxChars rejects a negative value', rejects({ evidenceQuoteMaxChars: -1 }, 'evidenceQuoteMaxChars'))
check('a numeric field rejects NaN', rejects({ summaryBudgetBytes: Number.NaN }, 'summaryBudgetBytes'))
check('a numeric field rejects Infinity', rejects({ summaryBudgetBytes: Number.POSITIVE_INFINITY }, 'summaryBudgetBytes'))
check('projectRootMarkers rejects an empty array', rejects({ projectRootMarkers: [] }, 'projectRootMarkers'))
check('projectRootMarkers rejects a blank marker', rejects({ projectRootMarkers: [''] }, 'projectRootMarkers'))
check('projectRootMarkers rejects a path', rejects({ projectRootMarkers: ['etc/git'] }, 'projectRootMarkers'))
check('projectRootMarkers rejects a non-array', rejects({ projectRootMarkers: '.git' }, 'projectRootMarkers'))

console.log('resolution does not mutate the caller or the defaults')
const raw = { summaryBudgetBytes: 1500, projectRootMarkers: ['.git'] }
const once = resolveConfig(raw, {})
raw.projectRootMarkers.push('.hg')
raw.summaryBudgetBytes = 1
check('a resolved marker list is a copy', once.projectRootMarkers.length === 1)
check('a resolved number is a copy', once.summaryBudgetBytes === 1500)
check('the module defaults are untouched',
  DEFAULTS.summaryBudgetBytes === 2400 && DEFAULTS.projectRootMarkers.length === 1)

console.log('a budget too small to hold an entry is refused')
check('a batch budget below the floor is rejected', await (async () => {
  try {
    resolveConfig({ consolidation: { maxTrajectoryBytesPerBatch: 8 } })
    return false
  } catch (error) {
    return String(error.message).includes('maxTrajectoryBytesPerBatch')
  }
})())
check('the floor itself is accepted',
  resolveConfig({ consolidation: { maxTrajectoryBytesPerBatch: 128 } }).consolidation.maxTrajectoryBytesPerBatch === 128)

console.log('consolidation settings')
const defaults = resolveConfig({}, {})
check('consolidation is on by default', defaults.consolidation.enabled === true)
check('automatic commits are on by default', defaults.consolidation.autoCommit === true)
check('the debounce default is ten seconds', defaults.consolidation.debounceMs === 10000)
check('the batch is bounded in events', defaults.consolidation.maxRelevantEventsPerBatch === 200)
check('the batch is bounded in bytes', defaults.consolidation.maxTrajectoryBytesPerBatch === 65536)
check('a deployment can turn it off',
  resolveConfig({ consolidation: { enabled: false } }, {}).consolidation.enabled === false)
check('a nested default is copied, not shared',
  resolveConfig({}, {}).consolidation !== DEFAULTS.consolidation)
check('a non-object consolidation block is refused',
  rejects({ consolidation: 'on' }, 'must be an object'))
check('a fractional debounce is refused',
  rejects({ consolidation: { debounceMs: 0.5 } }, 'integer'))
check('a zero event ceiling is refused',
  rejects({ consolidation: { maxRelevantEventsPerBatch: 0 } }, 'integer >= 1'))
check('a negative byte ceiling is refused',
  rejects({ consolidation: { maxTrajectoryBytesPerBatch: -1 } }, 'integer >= 1'))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
