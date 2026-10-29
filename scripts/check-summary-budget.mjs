#!/usr/bin/env node
/**
 * Verify every cached summary's content fits its budget.
 *
 * The service regenerates an over-budget answer and truncates one that never
 * fits; this script checks the files on disk, so a leftover cache or a manual
 * edit cannot silently exceed what the injection path will serve.
 *
 * Usage: `DSH_HOME=~/.dsh npm run check:summaries`.
 * The content budget defaults to 1800 bytes (`summaryBudgetBytes` 2400 minus the
 * fixed envelope allowance) and can be overridden with
 * `SUMMARY_CONTENT_BUDGET_BYTES`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const root = join(home, 'memory')
const limit = Number(process.env.SUMMARY_CONTENT_BUDGET_BYTES ?? 1800)
if (!Number.isInteger(limit) || limit <= 0) {
  console.error(`check-summaries: invalid SUMMARY_CONTENT_BUDGET_BYTES: ${process.env.SUMMARY_CONTENT_BUDGET_BYTES}`)
  process.exit(2)
}

/** Every summary.json below one directory. */
function summaries(dir) {
  const found = []
  if (!existsSync(dir)) return found
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...summaries(path))
    else if (entry.name === 'summary.json') found.push(path)
  }
  return found
}

let checked = 0
let failed = 0
for (const path of summaries(root)) {
  checked += 1
  let cached
  try {
    cached = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    console.error(`check-summaries: ${path}: not valid JSON`)
    failed += 1
    continue
  }
  const content = typeof cached.content === 'string' ? cached.content : ''
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > limit) {
    console.error(`check-summaries: ${path}: content is ${String(bytes)} bytes, over ${String(limit)}`)
    failed += 1
  }
}

console.log(`check-summaries: ${String(checked)} file(s), ${String(failed)} over ${String(limit)} bytes`)
process.exit(failed === 0 ? 0 : 1)
