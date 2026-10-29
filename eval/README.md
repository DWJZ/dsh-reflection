# Memory evaluation

Two layers, because the useful question has two halves: *does retrieval still
find things* (cheap, deterministic) and *does the agent still answer from
Memory* (real model, real tokens).

| Layer | Command | Model calls | Runs on |
|---|---|---|---|
| L1 retrieval | `npm run eval:retrieval` | none | every push / pull request |
| L2 behavior | `npm run eval:behavior` | **real, paid** | release tag `v*`, or by hand |

Neither layer replaces `npm test`: the contract suite asserts *specified
behavior* (scopes, supersede, tombstones, injection fail-loud) and must stay
green on every commit. This directory measures *quality*, which moves in
fractions and needs a baseline.

## L1 — retrieval

`data/retrieval.json` is a frozen synthetic corpus: 42 records across three
projects and the user scope, and 36 labeled queries (Chinese, English,
cross-lingual, multi-target, and three with no answer).

```sh
npm run eval:retrieval          # table + eval/report-retrieval.json
npm run eval:retrieval -- --json
```

Metrics: Recall@3, Recall@8, MRR, nDCG, and the no-answer false-positive count
(how many queries with no relevant record still returned something). The runner
fails when a metric drops more than 0.03 below `baseline.json`, or when a
no-answer query starts returning hits.

## L2 — behavior

`data/scenarios.json` drives the shipped headless profile through the real CLI,
with the plugin mounted from this checkout and a real model. Each scenario gets
a fresh `DSH_HOME` and its own project directories, so runs cannot leak into
each other or into your real Memory.

The ten scenarios:

| Scenario | What it proves |
|---|---|
| `write-then-read` | an explicit `记住` reaches the store, and the next session answers from it |
| `user-cross-project` | user Memory is visible from a different project |
| `project-isolation` | a project does not see another project's Memory, and says so |
| `superseded-not-served` | a retired record is replaced by its successor, not served alongside it |
| `detail-lookup` | a fact outside the injected summary is still found |
| `consolidation-write` | automatic learning stores the durable decision and drops the small talk |
| `consolidation-secret` | automatic learning never stores a credential |
| `summary-fidelity` | the model-written summary names what matters, invents nothing, and fits its budget |
| `update-write` | a later instruction updates the existing record instead of leaving the old one active |
| `secret-screening` | an explicit write of a credential is refused |

`consolidation-write` drives `/memory consolidate` through the shipped driver fixture, because the plugin's own debounce cannot fire inside a one-shot run.

Scoring is rule-based, not judged: `all` (every string must appear), `none`
(regexes that must not), `abstain` (the answer must decline). That keeps V1
cheap and reproducible; an LLM judge is a later layer, not a prerequisite.

### The control run

`--control` runs every scenario a second time with the plugin mounted
`enabled: false`: no Memory tools, no injected summary, no policy. The rule is
**not** that the control must fail — only that it must not do better than Memory.
A scenario where both do equally well is reported as *no difference*, which means
the question is answerable without Memory and does not currently discriminate.

Six details make the control honest, and each was added after watching a
control cheat:

- **The control pass runs first**, before any memory run has written a store: a
  model with shell access walks the filesystem, and another scenario's store is
  as good as its own.
- Its sessions get a **fresh harness home each, deleted afterwards**, because a
  shared home keeps the earlier transcript and the model greps the fact out of it.
- Seeding is skipped, so the facts are not on disk for a shell call to find.
- **Workspace instruction files are disabled in both runs**, and each session's
  fixture project is cleaned afterwards. Without this, a model that cannot use
  Memory writes the fact into `AGENTS.md`; the next session then reads it from the
  injected instructions, and the control answers correctly without Memory.
- **Every run mints a random token into the facts and their expectations**
  (`build:edge-{{run}}`, `release/2026-11-{{run}}`, …). The dataset on disk holds
  the placeholder, not the answer, so a model that greps the repository — or an
  older report — finds nothing it can use.
- **The control is told not to use tools** ("answer from the current context;
  say you don't know"). Otherwise it spends minutes searching the disk for a fact
  the token makes unfindable; the instruction keeps the run short and removes the
  last route around Memory.
- The control runs only for scenarios that have a scored session; artifact-only
  scenarios compare nothing and are skipped. A session that hits the timeout is
  retried once before it is scored — a slow provider is not a Memory regression.

The control roughly doubles the token cost of a run; it is worth it because it
turns "the answer was right" into "the answer was right because of Memory".

```sh
DEEPSEEK_API_KEY=… npm run eval:behavior
npm run eval:check                      # config only: CLI path, scenarios, model route
npm run eval:behavior -- --only update  # one scenario, by name fragment
npm run eval:behavior -- --keep         # keep the scratch tree for inspection
npm run eval:behavior -- --mock         # keyless plumbing check; expectations fail by design
```

Each run writes two companions: `eval/report-<suite>.json` for comparison and
`eval/report-<suite>.md` for a person. The Markdown one is a summary line, a table
of cases, and every failure with the answer that produced it; when the suite runs
in GitHub Actions it becomes the job summary (`$GITHUB_STEP_SUMMARY`), so the run
page shows the conclusion and the numbers without opening an artifact.

The report carries the run's cost beside its result: input/output tokens and the
p50 session latency. Tokens come from a spy fixture (`eval/fixtures/usage-spy.ts`)
reading committed `assistant/message` usage and the consolidator's audit, so
**summary-refresh calls are not counted** — they are model calls this plugin makes
outside the agent's turn. Treat the number as a floor, not the whole bill.

Two behaviours the suite pinned down:

- **A credential in the fact is refused; a credential in the cited turn is
  redacted.** The plugin replaces the matched span with `[redacted]` before
  truncating the evidence quote, so one pasted key no longer discards every fact
  from the same turn. `consolidation-write` now carries a key next to a real
  decision and asserts that the decision is stored and the key is not;
  `consolidation-secret` covers a turn whose only content is a credential.
- **The quote stops being byte-verbatim when it contained a credential.** It is a
  faithful quote of the redacted text. That is the deliberate trade recorded in
  the contract's secret section.

## Baseline and regression

`baseline.json` is committed and updated by hand after reviewing a run:

```sh
npm run eval:retrieval -- --update-baseline
DEEPSEEK_API_KEY=… npm run eval:behavior -- --update-baseline
```

- L1 fails when a metric falls more than 0.03 below the baseline.
- L2 fails when a scenario that the baseline records as passing now fails.
- Improvements never fail a run; they are recorded by updating the baseline.
- `--only` skips the baseline comparison, so a single-scenario run is not
  reported as a regression of the others.

CI never updates the baseline. A run on a tag is a datapoint; moving the bar is
a review decision.

## Adding cases

- **A query**: append to `data/retrieval.json` with `project`, `targets`
  (record ids), and `kind`. A query with `"targets": []` is a no-answer case.
- **A scenario**: append to `data/scenarios.json`. Steps are `seed`,
  `supersede`, `assertStore`, and `session` (with an optional `expect`).
- Bump `version` in either file when cases change: results from different
  dataset versions are not comparable.

## Rules

- **Never put real Memory in this directory.** The repository is public; the
  corpus is synthetic on purpose.
- **Freeze labeled data.** Do not tune a query until it passes; add a new case
  and bump the version instead.
- **Pin the model.** A different route makes two runs incomparable.
- **Secrets stay out of the behavior job's other steps.** The workflow scopes
  `DEEPSEEK_API_KEY` to the preflight and evaluation steps, and only release
  tags and manual dispatches reach them; `pull_request` never receives it.

## Known limits (V1)

- Ten scenarios is a smoke layer, not a benchmark; it detects breakage, not
  small quality movements.
- Rule-based scoring misses answers that are correct but phrased without the
  expected token. A judge is the next step, once the harness is trusted.
- No external benchmark (LongMemEval/LoCoMo) is wired in. Deliberate: they test
  chat-persona memory, not a coding agent's project Memory.
- Token accounting misses summary-refresh calls (see above).
- No judge: answers must contain the expected token. A correct answer phrased
  without it (or a wrong answer repeating it) is mis-scored.
