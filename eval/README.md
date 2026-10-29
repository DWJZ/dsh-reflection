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

The five V1 scenarios:

| Scenario | What it proves |
|---|---|
| `write-then-read` | an explicit `记住` reaches the store, and the next session answers from it |
| `user-cross-project` | user Memory is visible from a different project |
| `project-isolation` | a project does not see another project's Memory, and says so |
| `superseded-not-served` | a retired record is replaced by its successor, not served alongside it |
| `detail-lookup` | a fact outside the injected summary is still found |

Scoring is rule-based, not judged: `all` (every string must appear), `none`
(regexes that must not), `abstain` (the answer must decline). That keeps V1
cheap and reproducible; an LLM judge is a later layer, not a prerequisite.

```sh
DEEPSEEK_API_KEY=… npm run eval:behavior
npm run eval:check              # config only: CLI path, scenarios, model route
npm run eval:behavior -- --mock # keyless plumbing check; expectations fail by design
```

The model is pinned in `data/scenarios.json`:
`deepseek-official / deepseek-flash / reasoningEffort: high`. Change it there,
not in the workflow, so the route a run used is part of the committed dataset.

**No token cap.** The suite is gated by trigger (release tag or manual), not by
budget; a run that hits a provider limit fails visibly instead of being cut
short mid-scenario.

## Baseline and regression

`baseline.json` is committed and updated by hand after reviewing a run:

```sh
npm run eval:retrieval -- --update-baseline
DEEPSEEK_API_KEY=… npm run eval:behavior -- --update-baseline
```

- L1 fails when a metric falls more than 0.03 below the baseline.
- L2 fails when a scenario that the baseline records as passing now fails.
- Improvements never fail a run; they are recorded by updating the baseline.

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

- Five scenarios is a smoke layer, not a benchmark; it detects breakage, not
  small quality movements.
- Rule-based scoring misses answers that are correct but phrased without the
  expected token. A judge is the next step, once the harness is trusted.
- No external benchmark (LongMemEval/LoCoMo) is wired in. Deliberate: they test
  chat-persona memory, not a coding agent's project Memory.
- Consolidation quality, summary fidelity, and secret screening are not scored
  end to end yet.
