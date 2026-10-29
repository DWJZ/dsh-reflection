/**
 * Human-readable companions to the JSON reports.
 *
 * The JSON exists for comparison and CI; these files exist for a person reading
 * the job summary: a result line with the cost beside it, one row per case, and
 * the failures spelled out with the answer that produced them.
 *
 * @module dsh-reflection/eval/report
 */

/** Thousands-separated integer for token counts. */
const count = value => Number(value ?? 0).toLocaleString('en-US')

/** One duration in seconds, one decimal. */
const seconds = ms => `${(Number(ms ?? 0) / 1000).toFixed(1)} s`

/** One ratio as a percentage, one decimal. */
const percent = ratio => `${(Number(ratio ?? 0) * 100).toFixed(1)}%`

/** Collapse whitespace and cut to a readable length. */
const brief = (text, limit = 120) => {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** Render one cell for a Markdown table. */
const cell = text => String(text).replaceAll('|', '\\|')

/**
 * Render the behavior report.
 * @param report - the JSON report `run-behavior.mjs` wrote.
 * @returns Markdown text.
 */
export function renderBehaviorReport(report) {
  const passed = report.passed ?? report.scenarios.filter(scenario => scenario.pass).length
  const total = report.total ?? report.scenarios.length
  const metrics = report.metrics ?? {}
  const verdict = passed === total ? `**${String(passed)}/${String(total)} scenarios passed**` : `**${String(passed)}/${String(total)} scenarios passed**`
  const hasControl = report.scenarios.some(scenario => scenario.control !== undefined)
  const lines = [
    '# Memory behavior evaluation',
    '',
    `- Model: \`${report.model?.provider}/${report.model?.model}\` (reasoningEffort \`${report.model?.reasoningEffort ?? 'default'}\`)`,
    `- Dataset: v${String(report.dataset ?? '?')}`,
    `- Result: ${verdict}`,
    `- Cost: ${count(metrics.inputTokens)} in / ${count(metrics.outputTokens)} out tokens · ${String(metrics.sessions ?? '?')} sessions · p50 ${seconds(metrics.p50SessionMs)}`,
    ...report.gitSha === undefined ? [] : [`- Commit: \`${String(report.gitSha).slice(0, 12)}\``],
    '',
    ...hasControl === false ? [
      '| Scenario | Result | Sessions | Time | Tokens in | Tokens out | Tools |',
      '|---|---|---|---|---|---|---|',
    ] : [],
  ]
  if (hasControl) {
    lines.push('| Scenario | Memory | Control (off) | Δ | Time | Tokens in / out | Tools (memory run) |')
    lines.push('|---|---|---|---|---|---|---|')
  }
  for (const scenario of report.scenarios) {
    const tools = [...new Set(scenario.steps.flatMap(step => step.tools ?? []))]
    const firstFailure = scenario.steps.find(step => !step.pass)
    const result = scenario.pass
      ? '✅ pass'
      : `❌ fail — ${brief(firstFailure?.label ?? 'a step', 40)}`
    if (hasControl) {
      const control = scenario.control ?? {}
      const scored = Number(control.scored ?? 0)
      const memoryCell = scored === 0 ? '— (artifact)' : `${scenario.pass ? '✅' : '❌'} ${String(control.memory ?? 0)}/${String(scored)}`
      const controlCell = scored === 0 ? '—' : `${control.better === true ? '⚠️' : '✅'} ${String(control.without ?? 0)}/${String(scored)}`
      const delta = Number(control.memory ?? 0) - Number(control.without ?? 0)
      const deltaCell = scored === 0 ? '—' : control.better === true ? `❌ ${String(delta)} (control better)` : delta === 0 ? '0 (no difference)' : `+${String(delta)}`
      lines.push(`| ${cell(scenario.name)} | ${memoryCell} | ${controlCell} | ${deltaCell} | ${seconds(scenario.durationMs)} | ${count(scenario.tokens?.inputTokens)} / ${count(scenario.tokens?.outputTokens)} | ${cell(tools.length === 0 ? '—' : brief(tools.join(', '), 60))} |`)
      continue
    }
    lines.push(`| ${cell(scenario.name)} | ${cell(result)} | ${String(scenario.sessions ?? '')} | ${seconds(scenario.durationMs)} | ${count(scenario.tokens?.inputTokens)} | ${count(scenario.tokens?.outputTokens)} | ${cell(tools.length === 0 ? '—' : brief(tools.join(', '), 60))} |`)
  }
  const failures = report.scenarios.filter(scenario => !scenario.pass)
  if (failures.length > 0) {
    lines.push('', '## Failures', '')
    for (const scenario of failures) {
      lines.push(`### ${scenario.name}`, '')
      for (const step of scenario.steps.filter(step => !step.pass)) {
        lines.push(`- **${step.label}**: ${step.detail ?? 'failed'}`)
        if (step.answer !== undefined) lines.push(`  - answer: ${brief(step.answer, 300)}`)
      }
      lines.push('')
    }
  }
  if (hasControl) {
    lines.push('', '_Control = the same scenario with the plugin mounted `enabled: false`. The rule is not that it must fail — only that it must not do better than Memory._')
    const equal = report.scenarios.filter(scenario => scenario.control !== undefined
      && Number(scenario.control.scored ?? 0) > 0
      && scenario.control.memory === scenario.control.without).map(scenario => scenario.name)
    if (equal.length > 0) lines.push('', `_No difference (the scenario does not currently discriminate): ${equal.join(', ')}._`)
  }
  lines.push('', '_Tokens cover agent turns and consolidation audits for the memory run; summary-refresh calls are not attributed to a session event._', '')
  return lines.join('\n')
}

/**
 * Render the retrieval report.
 * @param report - the JSON report `run-retrieval.mjs` wrote.
 * @param baseline - the committed baseline, when it has retrieval metrics.
 * @returns Markdown text.
 */
export function renderRetrievalReport(report, baseline) {
  const metrics = report.metrics ?? {}
  const before = baseline?.retrieval
  const delta = (key) => {
    if (before === undefined || typeof before[key] !== 'number') return ''
    const change = Number(metrics[key] ?? 0) - before[key]
    return ` (baseline ${before[key].toFixed(3)}, ${change >= 0 ? '+' : ''}${change.toFixed(3)})`
  }
  const lines = [
    '# Memory retrieval evaluation',
    '',
    `- Corpus: ${String(metrics.answerable ?? '?')} answerable + ${String(metrics.noAnswer ?? '?')} no-answer queries, dataset v${String(report.dataset ?? '?')}`,
    `- Result: recall@3 **${percent(metrics.recall3)}** · recall@8 **${percent(metrics.recall8)}** · MRR **${percent(metrics.mrr)}** · nDCG **${percent(metrics.ndcg)}**`,
    `- No-answer false positives: **${String(metrics.noAnswerFalsePositives ?? 0)}**${before === undefined ? '' : ` (baseline ${String(before.noAnswerFalsePositives ?? 0)})`}`,
    ...before === undefined ? [] : [`- Baseline deltas: recall@3${delta('recall3')}, recall@8${delta('recall8')}, MRR${delta('mrr')}`],
    ...report.gitSha === undefined ? [] : [`- Commit: \`${String(report.gitSha).slice(0, 12)}\``],
    '',
    '| Query kind | n | Recall@3 | MRR |',
    '|---|---|---|---|',
  ]
  for (const [kind, row] of Object.entries(report.byKind ?? {})) {
    lines.push(`| ${kind} | ${String(row.n)} | ${percent(row.recall3)} | ${percent(row.mrr)} |`)
  }
  const misses = (report.results ?? []).filter(row => row.recall8 !== null && row.recall8 < 1)
  if (misses.length > 0) {
    lines.push('', '## Misses (outside the top 8)', '')
    for (const miss of misses) {
      lines.push(`- **${miss.kind}** "${brief(miss.query, 80)}" → expected ${miss.targets.join(', ')}; got ${(miss.ranked ?? []).slice(0, 3).join(', ') || 'nothing'}`)
    }
  }
  lines.push('', '_Keyless and deterministic: this measures the keyword scorer, not the agent._', '')
  return lines.join('\n')
}
