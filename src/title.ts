/**
 * The one-line title rule every Memory writer shares.
 *
 * A title is the index layer: a reader scans titles and opens only the bodies
 * whose title suggests the fact is relevant. The rule is deliberately concrete
 * (what/condition/how), because "a short summary" alone produced titles that
 * merely repeated the content's first words.
 *
 * @module dsh-reflection/title
 */

/** The rule, embedded in the policy section and the consolidation prompt. */
export const MEMORY_TITLE_RULE = [
  'Every record needs a one-line title written for a reader who scans titles before opening bodies.',
  'Build it as <condition or context> + <subject or conclusion> + <how> (+ <why>).',
  'What is required; include When/Where, How and Why when the record has them.',
  'Who is the user or this project, so it stays implicit. One line, no trailing period,',
  'and do not repeat the first words of the content.',
  'Examples: "回答保留英文技术术语，不翻译 API 名称";',
  '"上游同步先在 dsh-desktop-test 验证再更新主仓库";',
  '"zstd 压缩的 session 日志先 zstd -dc 再 grep";',
  '"本项目用 pnpm，构建命令 pnpm run build:edge".',
].join('\n')
