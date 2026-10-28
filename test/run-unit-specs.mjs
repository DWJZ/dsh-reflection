/**
 * Runs every unit spec in this directory, one at a time.
 *
 * The file list is discovered rather than enumerated: a new `*.spec.mjs` is
 * picked up without editing `package.json`, and the one spec that is not a unit
 * suite — `integration.spec.mjs`, which boots a real profile and needs a harness
 * checkout — is excluded by name.
 *
 * Specs run sequentially and inherit this process's stdio, so each one prints
 * its own `ok`/`FAIL` lines exactly as it does when run alone. The exit code is
 * the number of failing files, capped at 1, so CI fails when any spec does.
 *
 * Usage:
 *   node test/run-unit-specs.mjs            # every unit spec
 *   node test/run-unit-specs.mjs summary    # only files whose name contains "summary"
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const INTEGRATION = 'integration.spec.mjs'
const filter = process.argv[2]

const files = readdirSync(DIR)
  .filter(name => name.endsWith('.spec.mjs') && name !== INTEGRATION)
  .filter(name => filter === undefined || name.includes(filter))
  .sort()

if (files.length === 0) {
  console.error(filter === undefined ? 'dsh-reflection: no unit specs found' : `dsh-reflection: no spec matches "${filter}"`)
  process.exitCode = 1
} else {
  const failed = []
  for (const file of files) {
    console.log(`\n=== ${file} ===`)
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(DIR, file)], { stdio: 'inherit' })
    if (result.error !== undefined) {
      failed.push(file)
      console.error(`${file}: ${result.error.message}`)
    } else if (result.status !== 0) {
      failed.push(file)
    }
  }
  console.log(`\n${String(files.length)} spec file${files.length === 1 ? '' : 's'}, ${String(failed.length)} failed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.join(', ')}`)
    process.exitCode = 1
  }
}
