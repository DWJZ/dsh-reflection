# dsh-reflection contract

本文件是 `dsh-reflection` 的**唯一规范权威**，覆盖当前全部实现：Phase 1 的存储与显式操作，以及 Phase 2 的同步自动 consolidation。它规定存储位置、数据模型、操作语义、并发保证与验收标准；测试按它编写，实现按它验收；两者冲突时以本文件为准。

两半各自解决一组问题：

```text
Phase 1（§1–§29）
  存得对 / 取得到 / 跨 Session 可用 / User 与 Project scope 不串 / 并发不丢 / 行为可预测

Phase 2（P2-1 起）
  一轮结束后自动学习 / 有界输入 / 确定性复核 / 复用 Phase 1 提交 / 可审计
```

`README.md`（英文 canonical）与 `README.zh.md` 由本文件拆出；两份 README 必须描述同一套当前行为。

---

## 1. 范围

**做**：Persistent Storage、User / Project Scope、Stable Project Identity、Compact Memory Index、Memory Search、Explicit Remember、Explicit Update / Supersede、User Commands、Secret Protection、Basic Concurrency Safety、Cross-session Integration Tests。

**不做**（Phase 1 范围；自动提炼由 Phase 2 承担）：Semantic Deduplication、Automatic Conflict Detection、Reflection、Memory → Skill、Skill Promotion、Vector DB、Embeddings、Knowledge Graph、Reranker、Telemetry、Large-scale MemEval、Client UI。

Phase 2 补上 Automatic Consolidation（见 P2-1 起的各节）：它只做"从一轮轨迹中提炼可长期保存的事实"，且必须经过确定性复核后才能落库。

核心原则：**自动 Memory reasoning 只能在 Phase 2 定义的路径上发生**，不得从其它入口偷偷加回来。

---

## 2. 与 DSH 现有能力的边界

```text
Preset             = What kind of agent I am
AGENTS.md          = What I was told（authoritative instructions）
Memory             = What DSH explicitly remembers
Skills             = How I know to do things
Session Trajectory = What actually happened
```

Phase 1 不自动修改 Preset、AGENTS.md、Skills、Session log。Memory 是独立 subsystem。

Memory 是 learned / remembered hint，不是事实权威。冲突时优先级：

```text
当前可观察事实 / 当前明确用户输入
    > AGENTS.md 等 authoritative instructions
    > active Memory
    > superseded / archived Memory
```

---

## 3. 存储位置与目录

所有 Memory 属于 DSH，统一位于 `$DSH_HOME/memory/`。**不得**写入 `<project>/.dsh/memory`。

```text
$DSH_HOME/memory/
├── config.json                  # 本插件的开关键（§17）
├── consolidation-state.json     # Phase 2 进度：每个 Session 的 mark 与 gap（P2-2）
├── registry.json
├── user/
│   ├── memories.json      # 索引：元数据 + title，一行一条记录
│   ├── memories/<id>.md   # 正文 + evidence（唯一一份）
│   └── summary.json       # 模型写的摘要缓存（注入只读它）
├── projects/
│   └── <project_id>/
│       ├── memories.json
│       ├── memories/<id>.md
│       └── summary.json
└── tombstones.jsonl
```

不存在 `archive/`、`telemetry/`、`operations/`。

```text
memories.json        = 索引（元数据 + title；不含 content / evidence）
memories/<id>.md     = 正文 + evidence（唯一副本；缺失即 fail loud）
summary.json         = 模型写的摘要（JSON: revision / generated_at / model / budget / content）
```

Memory 的物理位置不可配置：内部恒为 `path.join(resolvedDshHome, 'memory')`，**不提供 `memoryDir`**。

---

## 4. Config

| 字段 | 类型 | 默认 | 校验（fail loud） |
|---|---|---|---|
| `enabled` | boolean | `true` | — （当前值由 §17 的 `config.json` 覆盖） |
| `sessionEvents` | boolean | `false` | — （本插件写 Session 轨迹行的**唯一**开关） |
| `dshHome` | string | `$DSH_HOME` / `~/.dsh` | 非空 |
| `summaryBudgetBytes` | number | `2400` | `>= 0`（注入摘要的 UTF-8 字节上限；摘要调用会被告知这个数字） |
| `retrievalTopK` | number | `8` | `>= 1` |
| `projectRootMarkers` | string[] | `['.git']` | 非空字符串项。**必须与 `@deepseek-ai/dsh-agent-instructions` 的 `projectRootMarkers` 一致** —— harness 用它决定项目根（指令文件的范围），Memory 用它决定项目身份。本地插件无法读取对方的已解析配置，所以两者靠"同名字段 + 同默认值 + 一起改"保持同步 |
| `lockTimeoutMs` | number | `10000` | `> 0` |
| `staleLockMs` | number | `60000` | `> 0` |
| `maxEvidencePerMemory` | number | `8` | `>= 1` |
| `exportInlineMaxBytes` | number | `24000` | `> 0` |
| `evidenceQuoteMaxChars` | number | `200` | `>= 0` |
| `consolidation` | object | 见下 | 见下 |

`consolidation` 的子字段（Phase 2，全部 fail loud）：

| 子字段 | 类型 | 默认 | 校验 |
|---|---|---|---|
| `enabled` | boolean | `true` | — |
| `autoCommit` | boolean | `true` | — |
| `debounceMs` | integer | `10000` | `>= 0` |
| `minConfidence` | number | `0.8` | `[0, 1]`；add 的服务门槛，改写则直接拒绝 |
| `maxRelevantEventsPerBatch` | integer | `200` | `>= 1` |
| `maxTrajectoryBytesPerBatch` | integer | `65536` | `>= 128`（UTF-8 字节，作用于整条序列化 entry） |
| `maxBatchesPerRun` | integer | `4` | `>= 1`（单次 run 消费的窗口上限） |

没有 `maxOutputTokens`：规划调用不设插件侧输出上限，沿用 provider 自己的上限。

积压按窗口逐个消费：单次 run 最多消费 `maxBatchesPerRun` 个窗口，没追平的部分留给下一次（mark 已推进到最后一个提交的窗口，不会重复）。回填的洞按 `MAX_BACKFILL_EVENTS`（2000 条）分块读取，只有真正读不到的块才记 gap。

**`autoCommit: false` 表示"不要自己学"**：自动路径**根本不运行** —— debounce 不排期、不构造窗口、不调用模型，因此也不花任何 token。

它只关掉**触发**，不关**采集**：事件照旧进缓冲区（采集不产生模型调用），所以人主动敲 `/memory consolidate` 时窗口仍在，命令照常读取、复核并**写入**。`--dry-run` 是显式声明"只看不写"的开关 —— 想在评测时观察模型会提出什么，用它，因为它只在人明确要求时才花钱。

`consolidation.enabled = false` 比它更彻底：连采集都停，命令面拒绝执行。两者都不影响显式 `memory_remember`。

`maxTrajectoryBytesPerBatch` 有下限（128 字节）：字节上限要能容纳一条描述事件的序列化 entry（含事件类型名与 seq）。低于下限的配置在加载时抛错，而不是给出一个守不住的承诺。

`dshHome` 解析顺序：`config.dshHome` > `process.env.DSH_HOME` > `~/.dsh`。非法值在加载时抛 `TypeError`，并在消息里指明出错字段。

**没有 `revisionRetries`**：并发完全由 exclusive lock 解决 —— 拿到锁后读到的就是当前 state。

---

## 5. Memory schema

```jsonc
{
  "id": "mem_<uuid>",
  "scope": "project",
  "project_id": "proj_<uuid>",

  "source": "explicit",
  "title": "该项目使用 pnpm 管理依赖",
  "content": "该项目使用 pnpm",

  "confidence": 1.0,

  "evidence": [
    {
      "session_id": "session-...",
      "event_seqs": [41],
      "kind": "user",
      "quote": "记住，这个项目以后使用 pnpm",
      "observed_at": "2026-09-26T00:00:00.000Z"
    }
  ],

  "created_at": "...",
  "updated_at": "...",

  "status": "active",
  "superseded_by": null
}
```

`content` 与 `evidence` 合起来是记录的**正文**，落在 `memories/<id>.md`；其余字段进 `memories.json`。`title` 是一行摘要，用于索引与 summary，不代替正文。

ID 用 `crypto.randomUUID()` 加前缀：`mem_<uuid>`、`proj_<uuid>`。不自实现 ULID。

`scope`：`user` 跨 Project 可见；`project` 只在当前 Project 可见，Project A 的 Memory 不得出现在 Project B。Session 不作为 Persistent scope。

`source`：`explicit`（用户明确要求写入）| `agent`（consolidation / digest 汇总写入）。它只回答"谁写的"，不是内容分类；没有 category 字段。

`status`：`active` | `superseded` | `archived`。

### 5.1 Confidence

Storage schema 允许 `confidence ∈ [0, 1]`。Phase 1 writer **永远写 1.0**：

- `memory_remember` 不接受 `confidence` 参数，显式写入的记录一律 `1.0`（用户直接要求的事实不是概率判断）；
- **Phase 2 的自动写入持久化 reviewed 置信度**：ADD / SUPERSEDE 用模型给的值，UPDATE 把它写进被改写的记录。
- **低于 `consolidation.minConfidence`**：`add` 仍写入 store 并保留真实 confidence，但**不进入 summary/注入、不参与 `memory_search`**（`memory_get` 按 id 仍可读）；`update` / `supersede` 仍直接拒绝 —— 否则旧记录被退役、新记录又被过滤，等于丢记忆。
- **显式 update 写入 `0.95`**（`EXPLICIT_UPDATE_CONFIDENCE`），既不沿用被改写记录的旧值，也不自称为 `1.0`：用户重申了内容，所以他确定；但这条记录是在别人的判断之上被修正的，不是他直接新建的；
- Phase 1 ranking 不使用 confidence；
- canonical 中 `[0, 1]` 都是合法 schema（不是只有 1.0）；
- Phase 2 的 automatic consolidation 可直接写 `< 1.0`，不需要升级 schema。

### 5.2 校验规则

1. `title` 非空、单行（不设长度上限）；`content` 非空、trim 后单行、≤ 500 字符；
2. `scope === 'project'` 时 `project_id` 非空；`scope === 'user'` 时 `project_id` 为 `null`；
3. `confidence ∈ [0, 1]`；
4. `status === 'superseded'` 当且仅当 `superseded_by !== null`，且目标记录存在；
5. `id` 全局唯一；
6. `updated_at >= created_at`；
7. 时间统一 ISO-8601 UTC，毫秒精度。

第 1–3 条与第 6–7 条是单条记录的 invariant；第 4、5 条是 store invariant（需要看到整个 store 才能判定）。两者读入时都必须成立。

`maxEvidencePerMemory` **不属于 store invariant**，它是 **writer policy**：只约束本次 ADD / UPDATE / SUPERSEDE 产生的新状态（累积后保留最新 N 条，见 §7）。

判据是"这次写入有没有产生新的 evidence 状态"，而不是"这条记录是谁"：

- ADD：新记录 → 适用；
- UPDATE：改写 evidence → 适用（累积后截断到 cap）；
- SUPERSEDE 的 replacement：新记录 → 适用；
- SUPERSEDE 中被 retire 的旧记录：只改 `status` 与 `superseded_by`，不产生 evidence → **不适用**；
- ARCHIVE：只改 `status` → **不适用**。

**改动 `maxEvidencePerMemory` 永远不得让此前合法的 canonical 数据失效。** 这条对 Phase 2 与运行时改配置同样成立：调小配置之后，旧记录仍可读、仍可 archive / supersede，也能与其它记录一起参与任何写入。若把它当 invariant，降低配置会让整个 store 无法再写。

---

## 6. Evidence 与 provenance

模型不能提供 provenance。`memory_remember` **不接受**：`evidence`、`session_id`、`event_seq`、`observed_at`、`confidence`。

Host 自己构造：

```jsonc
{
  "session_id": "<当前 session>",
  "event_seqs": [<seq>],
  "kind": "user",
  "quote": "<文本>",
  "observed_at": "<host UTC>"
}
```

`kind`：`user` | `tool` | `agent`。默认 `user`。

### 6.1 绑定当前 turn

```text
primary provenance   = quote + session_id
best-effort optional = event_seqs
```

实现：

```text
订阅 session/event（post-commit 的追加流）
  ↓ 记下最后一条人类 user/message 及其 seq
  ↓ 每次 turn/start 时把它快照成"本轮输入"
memory_remember
  ↓ quote 使用本轮输入的文本（先脱敏，见 §7.2），截断到 evidenceQuoteMaxChars
  ↓ 该事件自带 seq → event_seqs = [seq]
  ↓ 无从确定时      → event_seqs = []
```

`quote` 与 `session_id` 是主要 provenance，`event_seqs` 是尽力而为：事件流本身就带 seq，所以填得上就填；填不上就留空。

**不得为了填 `event_seqs` 去做模糊文本匹配。** 找不到就留空，绝不伪造。同理，插件未观测到该 session 时（例如它是在插件挂载前开始的），provenance 退化为"session id + 空 quote + 空 seq"，而不是去猜一条消息。

引用用户消息时，判别"人类输入"用明确的用户 source kind，排除 `agent-instructions` 等注入 kind。

`update` / `merge` 时**累积** evidence 而不覆盖，超出 `maxEvidencePerMemory` 后保留最新。

---

## 7. Secret 与 PII

### 7.1 检测与处理

Raw secret 永远不能进入 Persistent Memory，无 override —— 即使用户明确要求保存 secret，也不保存原值。允许保存本身不是 secret 的 locator（例如"GitHub credential 存在 macOS Keychain，service name = xxx"）。

至少检测：

```text
sk-* 长 token
Bearer <token>
PEM private key
password= / api_key= / token= 后的非空值
AWS AKIA[0-9A-Z]{16}
明显高熵 credential
```

处理分两种：

- **content 命中** → `NOOP` + `reason = secret-detected`。事实正文是模型或用户写的，不能脱敏后猜原意。
- **被引用的源文本命中** → **脱敏后继续写入**：整段凭据替换为 `[redacted]`，`quote` 从脱敏后的文本截断生成。事实本身（content）若干净则照常落盘。

因此 `evidence.quote` 在源文本含凭据时**不是逐字原文**，而是"脱敏文本的忠实引用"。这是有意的取舍：旧行为是整轮拒绝，一句密钥会让同一轮的所有事实一起丢失。

### 7.2 扫描顺序：先脱敏，再截断

```text
① 取被引用事件的完整文本（显式写入取当前轮 user message）
② redact：把命中的凭据整段替换为 [redacted]（在截断之前）
③ 生成截断后的 evidence.quote（来自脱敏文本）
④ pre-persist scan：新 content + 新 quote → 命中同样 NOOP
⑤ persist
```

先截断再扫描会让 secret 被截断在 quote 边界，形成"不再匹配 pattern 但仍含 credential 片段"的字符串。② 在截断之前完成，所以片段不可能存在；④ 是最后一道，同时拦住把原始 quote 直接交给 action 的调用方。

保证是：

> 每次 mutation 新引入的每一段持久化文本，都必须先通过 secret screening 才能进入 Memory 拥有的持久化存储。至少包括：新的 / 被改写的 `content`、新生成的 `evidence.quote`（来自已脱敏文本）。

**历史文本不因无关 mutation 而被重新审计。** 已经存在于 canonical 里的 `evidence[*].quote` 不会在 archive / forget / 其它记录的写入时被按**当前**规则重扫。原因是扫描规则会演进：若把"每次 persist 都重扫完整 record"当成保证，那么新增一条检测规则就会让历史合法数据突然不可修改 —— 这与 §5.2 中 `maxEvidencePerMemory` 的 writer-policy 边界是同一个道理：**改动检测规则或配置，不得让此前合法的 canonical 数据失效。**

需要重新审计历史数据时，应当由一次**显式**的、以它为目的的操作完成，而不是搭在某次无关写入上。

### 7.3 保证范围

**保证**：`dsh-reflection` 不会把 detected secret 写入 **Memory subsystem 自己拥有的**持久化数据、返回值、warning、tombstone 或生成 view：

```text
memories.json
memories/<id>.md
registry 中由 memory 拥有的字段
tombstones.jsonl
plugin logger
tool result
```

**不保证**（属于 Session subsystem，不在 Memory 的 secret / 删除保证内）：

```text
原始 user message
DSH 自动记录的 tool/call SessionEvent（含 memory_remember 的 arguments）
其他 DSH subsystem 已存在的 trajectory
```

`memory_remember` 的参数可能在本插件 execute **之前**就由 DSH 记为 `tool/call`，插件无法事后让已存在的 session event 消失。因此本 contract 不宣称"secret 不会出现在任何日志"。

### 7.4 PII

Phase 1 不承诺通用 PII detector，只在 prompt 与文档层面要求不主动保存高敏感个人信息（精确住址、医疗诊断、政府/金融标识、认证相邻数据、用户明确说"不要记"的内容）。

---

## 8. 操作语义

### 8.1 `memory_remember` 参数集

| mode | 必填 | 禁止出现 | 继承 |
|---|---|---|---|
| `add` | `content`, `title`, `scope` | `target_id` | — |
| `update` | `target_id`, `content`, `title` | `scope` | `scope` / `project_id` 继承 target |
| `supersede` | `target_id`, `content`, `title` | `scope` | 同上 |

update / supersede 不允许模型再传 scope，避免矛盾参数。

### 8.2 Exact duplicate

只在 `mode = add` 时检查。归一化：`trim` + 折叠连续空白 + Unicode NFC，**不做 lowercase**（`FOO != foo`、`Model-X != model-x`，identifier 与路径大小写可能有语义）。

判定范围：同 scope + 同 project_id + 同归一化 content → `NOOP duplicate`。

Phase 1 **不做** semantic dedupe、**不做** automatic conflict detection。

### 8.3 Target revalidation

拿到 lock、apply 之前，对 `update` / `supersede` 重查：

```text
target 存在？
target 对当前 user/project 可见？
target.status === active？
```

任一不满足 → **fail conflict**。不 retry，也不静默转成 ADD。这不是 storage revision 冲突，而是 semantic stale target。

### 8.4 六个操作

| 操作 | 语义 |
|---|---|
| ADD | 新建；精确重复则 NOOP |
| UPDATE | 保留 id，改 content，追加 evidence，`updated_at` 前进 |
| SUPERSEDE | 旧记录 `status=superseded` + `superseded_by=新 id`；新记录 `active`。不允许两条冲突的 active 并存 |
| ARCHIVE | **只改 `status=archived`**，记录仍在 `memories.json`，不参与 search / index |
| FORGET | 从 canonical 删除记录 → 重建 view → 追加无正文 tombstone |
| CLEAR | 从 canonical 移除所选记录 → 重建 view → 追加一条 summary tombstone |

没有 physical archive copy："archive" 只是 status。

FORGET 不做 crash recovery journal，只保证成功返回后正常路径已删除。

---

## 9. Tombstones

`tombstones.jsonl` 是 append-only，所有 user / project 共用。**固定**语义：

```jsonc
// FORGET，每次一条
{ "op": "forget", "id": "mem_xxx", "scope": "project", "project_id": "proj_xxx", "deleted_at": "..." }

// CLEAR，每次一条 summary，不逐条记录被删内容
{ "op": "clear", "scope": "project", "project_id": "proj_xxx", "count": 42, "deleted_at": "..." }
```

两者都**不得包含** `content` / `evidence` / `quote`。

并发写复用同一套 lock helper（`tombstones.jsonl.lock`）：

```text
acquire lock → append 一整行完整 JSON → fsync / close → release（finally）
```

**不依赖**"`O_APPEND` 写一行在任意文件系统上都原子"这一假设。

---

## 10. Project Identity

### 10.1 存储形式

registry 内部统一保存 **normalized absolute lexical path**：

```js
stored = path.resolve(input)
```

不存 realpath 的理由：`relink` 之后的旧路径会进入 `aliases`，而它通常**已经不存在**，对它做 `realpath` 会失败。

### 10.2 registry.json

```jsonc
{
  "schema_version": 1,
  "revision": 1,
  "projects": [
    {
      "project_id": "proj_...",
      "canonical_root": "/Users/x/projects/dsh",
      "aliases": [],
      "workspace_ids": [],
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
```

Memory record **只保存 `project_id`**，不保存 path snapshot。

### 10.3 唯一性（两层 key）

```text
1. normalized absolute lexical path
2. 若路径存在，再加 realpath identity
```

```text
bind    path 已属于 project X → 返回 existing X，不新建
relink  new path 已属于另一个 project → fail conflict
alias   不能跨 project 重复
```

两层兼顾：容忍"已不存在的 old alias"，同时拦住"两个 lexical path 实际指向同一 symlink target"被注册成两个 project。

### 10.4 解析顺序

```text
1. registry longest ancestor match（跳过不存在的路径）
   → hit: return project_id

2. ctx.get('workspaceRegistry') 可用
   → resolveOrRegisterProject(realpath(其 root))

3. cwd 向上查 projectRootMarkers（默认 .git）
   → 最近的 marker root → resolveOrRegisterProject(该 root)

4. 都没有 → 当前 session 只有 user scope
```

第 2 步必须能**注册**而不只是匹配，否则非 Git workspace 永远拿不到 Project Memory。

### 10.5 longest ancestor match

```text
cwdReal = realpath(cwd)
for each entry, for each root in [canonical_root, ...aliases]:
    if (!exists(root)) continue
    rel = path.relative(realpath(root), cwdReal)
    match ← rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
取最长者
```

用 `path.relative` 判祖先，不用字符串拼 `/`。同时存在 `/foo` 与 `/foo/bar` 时，`/foo/bar/src` 必须命中 `/foo/bar`。

### 10.6 `resolveOrRegisterProject`

check + create 必须在**同一个 registry lock transaction** 内，否则两个进程同时打开同一个新目录会创建两个 `project_id`：

```text
acquire registry lock
  ↓ read latest registry
  ↓ 重做 lexical + realpath 唯一性匹配
  ↓ 已存在 → return existing project_id
  ↓ 否则   → create new project_id → persist registry
  ↓ release（finally）
```

`/memory project bind <path>` 调用同一个函数。

### 10.7 relink

```text
old-path：
  normalize 为绝对 lexical path（不做 realpath）
  在 registry 的 canonical_root / aliases 里匹配存储值
  若 old 仍存在，realpath 可作额外辅助匹配，但不是必要条件

new-path：
  必须存在（用于 realpath identity 唯一性检查）
  必须未被其他 project 占用

结果：old → aliases；new → canonical_root = path.resolve(new)；updated_at = now
```

---

## 11. 并发与锁

### 11.1 Mutation 序列

```text
acquire in-process mutex
  ↓ acquire cross-process exclusive lock
  ↓ read latest canonical
  ↓ validate operation against latest state（含 §8.3 target revalidation）
  ↓ apply mutation
  ↓ revision += 1
  ↓ write temp → fsync → close → atomic rename
  ↓ release canonical transaction（finally）
  ↓ view rebuild（独立取锁，见 §12.3）
```

**锁必须在 `finally` 里释放**：validation 失败、JSON 解析失败、mutation 失败、rename 失败、view 生成失败，任何路径都不能留下 lockfile。

### 11.2 atomic write 的临时文件清理

```js
let tmpPath, committed = false
try {
  tmpPath = <同目录，命名匹配 *.dsh-reflection-tmp-*>
  create tmp → write → fsync → close → rename
  committed = true
} finally {
  if (fd 仍打开) close(fd)
  if (!committed && tmpPath) best-effort unlink(tmpPath)
}
```

不带清理的话，`fsync` / `rename` 失败会在 memory 目录里不断残留含旧 Memory 内容的 `.tmp` 文件。

mount 时 best-effort 删除**自己命名规则**的残留 temp（`*.dsh-reflection-tmp-*`），**只删这个 pattern**，不扫不删未知 `.tmp`。这不是 journal，也不改变 transaction model。

### 11.3 Lock

`<store>.lock` 用 `open(path, 'wx')` 原子创建，内容：

```jsonc
{ "pid": 12345, "host": "machine-name", "at": "..." }
```

拿不到就等到 `lockTimeoutMs`，超时 fail loud。

stale 判定（`lock age > staleLockMs` 之后）：

```text
same host → process.kill(pid, 0)
              ├─ 成功        → alive → 不 reclaim
              ├─ ESRCH       → dead  → reclaim + warning
              ├─ EPERM       → alive → 不 reclaim
              └─ 其他 error  → 保守按 alive 处理
different host → 无法确认 PID → 不 reclaim，等到 lockTimeoutMs → fail loud
```

**只有明确的 `ESRCH` 才 reclaim**；把 `EPERM` 当 dead 会错误抢占活进程持有的锁。判断逻辑实现为可注入的小 helper。

共享盘残留 lock 需人工清理，README 写明。

---

## 12. 索引、正文与摘要

### 12.1 内容

**`memories.json` 是索引**：每条记录一行元数据（`id`、`scope`、`project_id`、`source`、`title`、`status`、`confidence`、`created_at`、`updated_at`、`superseded_by`）。不含 `content`、`evidence`，因此同一段文本不会既在索引又在正文里。

**`memories/<id>.md` 是正文**：`content` 段落 + `## Evidence` 列表（observed_at、kind、seq、session、quote）。它是正文与 evidence 的**唯一副本**，不是派生视图；文件缺失时读取直接 fail loud，报错指名记录 id 与缺失路径。

**`summary.json`**：模型写的摘要缓存（§14），JSON 字段 `revision` / `generated_at` / `model` / `budget` / `content`。注入只读它的 `content`，不在请求路径上调用模型；metadata 永不参与截断。

旧版本生成的 `MEMORY.md` 在迁移时删除；迁移后不再有任何重复索引。

### 12.2 提交顺序与故障语义

```text
acquire store lock
  ↓ read index (and bodies)
  ↓ validate, mutate
  ↓ write changed bodies（原子）
  ↓ write index（原子）        ← 提交点
  ↓ remove bodies the index no longer names
  ↓ release（finally）
```

- 正文写完、索引未写 → 孤儿正文；下一次成功写入时删除，不算提交。
- 索引写完、正文缺失 → 读取 fail loud（不做静默跳过，也不自动删除索引项）。
- 索引写入失败 → 旧索引保持完整，mutation 失败。
- 版本 1 的旧 store：首次读取仍兼容（正文在索引里），首次写入或 mount 迁移为 v2；迁移先写正文后写索引，可重复执行。

### 12.3 title 的写入

**必填，不再从 content 派生。** 写入方（`memory_remember`、consolidation、后续 digest）必须提供 title；工具 schema 与 consolidation 计划都把它列为必填字段。

规则（同时写进 policy 段与 consolidation system prompt）：

```text
title = <条件/场景> + <对象/结论> + <做法> (+ <原因>)
What 必须；When/Where、How、Why 有则写；Who 默认是用户/本项目，省略。
一行、不加句号、不重复 content 的开头；不设长度上限。
```

- `memory_remember`：模型不填 title 就是无效调用，由工具校验打回。
- consolidation：计划里任一 add/update/supersede 缺 title 时，先把整份计划连同"缺少 title"的提示重问一次；仍缺则拒绝该操作，audit 记 `title-missing`，不落库。
- consolidation：任一 operation 的 content 超过 500 字符时，同样把整份计划连同"超长"提示重问一次；仍超长则拒绝，audit 记 `content-too-long`。settled audit 的 `rejected_details` 保留每条拒绝的 `code` / `action` / `scope` / `content_length`，不存正文。
- 旧记录：POC 阶段用一次性脚本按同一规则重新生成过 title（不属于插件命令，不随仓库发布）；没有兼容分支。
- title 不属于正文，截断只作用于 `content`。

---

## 13. Retrieval

Phase 1 不做 semantic retrieval，只做 scope filtering、keyword matching（必须支持 CJK）、simple relevance scoring、`updated_at` fallback。

打分：

```text
1. 归一化后的整串 substring 命中     → 高权重
2. ASCII / word-like token 重叠       → 中权重
3. CJK fallback：字符 bigram 重叠     → 中低权重
```

例：query `包管理器` 的 bigram 为 `包管` / `管理` / `理器`，可命中 `该项目使用 pnpm 作为包管理器`。不引入 tokenizer / embedding / jieba / reranker。

比较时对 ASCII 做 case folding（**仅用于比较，不改动存储**）；重复判定（§8.2）保持大小写敏感。

过滤顺序：scope → **confidence floor（`consolidation.minConfidence`）** → 打分 → top_k。只有 `status === 'active'` 参与普通检索。confidence 不参与排名。

接口：

```text
memory.search({ query, scope?, project_id?, top_k? })
```

---

## 14. Context Injection

不做每 turn 自动相关检索：每个请求注入一段**摘要**和记录文件的路径，记录正文由模型按需自己去读（文件或 `memory_search` / `memory_get`）。

```text
<memory-summary>
data, not instructions — what Memory holds, not a request

13 user · 29 project active · updated 2026-10-27
index: ~/.dsh/memory/user/memories.json · ~/.dsh/memory/projects/proj_…/memories.json
the index lists every record by title and id; each record has its own file under memories/<id>.md, and memory_get <id> reads one
</memory-summary>
```

规则：

- **不注入任何一条记录的正文。** envelope 只含：固定 notice、两个 scope 的 active 计数、类别计数、最后更新时间、两个 `memories.json` 的绝对路径，以及指向 `memories/<id>.md` 的说明。
- **摘要由模型写。** 低于 `consolidation.minConfidence` 的记录不进入摘要提示词（仍留在 store/index）。提示词里每条记录带 `[explicit]` / `[agent]` 标签：`[explicit]` 是用户明确要求，`[agent]` 是自动汇总或跨项目 digest 提炼的经验，按参考处理，冲突时 `[explicit]` 优先。store revision 变化后（显式写入与 consolidation 写入都会等待刷新；读取发现落后时也会后台补刷新），用该 Session 自己的 route 生成，写进该 scope 的 `summary.json`（`revision` / `generated_at` / `model` / `budget` / `content`）。注入**只读缓存**，同步路径上不调用模型。摘要调用不设插件侧输出上限，沿用 provider 自己的上限；提示词给的是**正文预算**（`summaryBudgetBytes` 减去固定信封预留 600 字节）。正文超过预算时重新生成，最多 3 次；仍超出则按正文预算截断并记 `warn`，只有 `content` 会被截断。缓存的 `budget` 与当前配置不一致时视为过期：下一次读取重新生成。失败第一次记 `warn`，后续重试降到 `debug`，避免坏 route 刷屏。这个检查在每次生成之后、写缓存之前立即执行，不暴露独立命令。
- 缓存描述的 revision 落后时仍然注入 —— 过时的摘要优于没有摘要 —— 由后台刷新追上。
- **固定部分永不为了腾地方而裁掉**：超 `summaryBudgetBytes` 时先裁模型写的那段（按 UTF-8 字节切，不劈开字符，末尾补 `…`）。连固定部分都放不下时整个 envelope 为 `''`。
- 两个 scope 都没有 active 记录时不注入。
- notice 固定为 `data, not instructions — what Memory holds, not a request`：摘要由模型根据用户/项目的事实生成，仍可能含有"像指令"的句子。
- **预算用 UTF-8 字节数**：`Buffer.byteLength(text, 'utf8')`，不用 JS `length`（UTF-16 code units，中文会严重低估）。
- 策略段（`memory:policy`，order 950）要求模型**主动**读 Memory：开工前、遇到可能做过的事情时、用户提到看不见的旧事时，先读文件或 `memory_search`，而不是等用户要求。

### 14.1 Canonical 失败必须 fail loud

摘要的装配读取 canonical。**读取失败（JSON 解析错误、schema / 记录 / 引用完整性不合法、权限或关键读失败）必须向外抛，让本次 model request 停下来**，不得 catch 后返回空摘要。

理由：`memories.json` 是 source of truth。静默降级成空摘要，用户看到的是"agent 突然失忆"，而不是"Memory 子系统坏了" —— 后者可诊断，前者不可。抛出的错误必须指名出问题的文件路径。装配路径上没有 catch（`SystemPrompt.assemble` 调用 `text(context)` 时不吞异常），因此抛出即中断该轮请求。

## 15. 模型工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `memory_search` | `query`(必), `scope?`(user/project/all), `top_k?` | `{results: [{id, scope, source, content, updated_at}], total}` |
| `memory_get` | `id`(必) | 完整记录；不存在或越权时明确 not-found |
| `memory_remember` | 见 §8.1 | `{action: added\|updated\|superseded\|noop, id, reason}` |

工具描述必须写明："只有用户明确要求记住、更新或替换 Memory 时才调用。"

`presentCall`：

```text
memory_remember → title = Remember, kind = other
                  只显示 mode；add 时显示 scope；update|supersede 时显示 target_id
                  不重复展示完整 content（避免把可能是 secret 的正文再送进 UI card）
memory_search / memory_get → 按 read tool 正常展示必要参数
```

`enabled = false` 时三个工具都不注册。

---

## 16. 用户命令

```text
/memory list [--user|--project] [--status active|superseded|archived|all]
/memory search <query> [--top <n>] [--user|--project]
/memory inspect <id>

/memory archive <id>
/memory forget <id>
/memory clear --user|--project --yes

/memory export [--user|--project] [--format md|json]

/memory consolidate [--dry-run]

/memory digest [--force]

/memory digest --apply [1,3,...]

/memory enable
/memory disable

/memory project bind <path>
/memory project relink <old> <new>
/memory project show
```

- `list` 可以截断并提示总数；
- `export` **完整输出或 fail loud**（超过 `exportInlineMaxBytes` 时提示加过滤条件），不得静默截断；
- `clear` 无 `--yes` 时只报告将删除的条数；
- `/memory` 命令**永远注册**，不受 `enabled` 影响。

### 16.1 跨项目 digest（手动）

- **输入**：`digest/state.json` 里 `lastScanAt` 之后生成的 project `summary.json`；没有 checkpoint 时取过去 24 小时；`--force` 取全部。
- **两阶段**：第一次给 summary + 记录索引（id + title），模型返回要展开的 id；第二次给这些记录的正文。展开条数不设上限。
- **输出**：只写 `digest/pending.json` 与 `pending.md`，**不写 Memory**；pending 成功写出后才推进 `lastScanAt`。
- **候选校验**：title / content 非空、单行、content ≤500 字符、过 secret 筛查、`derived_from` 必须指向本次提供的记录，且必须覆盖**至少两个不同 workspace**（否则记 `fewer than two workspaces` 拒绝）；只有单个 workspace 更新的窗口因此产生 0 条。
- **候选必须标 `scope`**：`practice` 才能进 pending；`project` 记 `project-specific` 拒绝，缺 scope 同样拒绝。`practice` 指工具、调试、环境、流程、协作这类"怎么做"且换语言/领域仍成立的经验；语言/框架/架构/API/CLI/模块边界/数据模型/领域规则属于 `project`，留在项目里。
- **apply**：`/memory digest --apply [1,3,...]`。每条候选写一条 user scope 记录（`source: 'agent'`，带 `derived_from`）；只归档候选**引用到的** project 记录，归档记录带 `comment` 说明"已提升到 user scope"。全部应用后 pending 移到 `digest/history/`，未应用的部分留在 pending。写入和审计完成后命令即返回；**只把 user summary 的重新生成放后台**（一次模型调用），**不刷新 project summary**——被归档的 project 记录会让它的 summary 过期，等那个项目下次读取时再刷新。
- 已有 pending 时再次 digest 会拒绝，避免覆盖未审的候选；`--force` 重新扫描并替换 pending。
- **apply 只消费 pending 里的候选**（按编号选择），不接受任意记录 id；候选之外的记录不会被 apply 写入或归档。
- **审计**：run 与 apply 各往 Session 追加一条 `plugin:dsh-reflection/digest` 记录，含窗口、项目 summary revision、展开/归档的记录 id、候选/拒绝计数、模型与 usage，**不含正文**。

---

## 17. Enable / Disable

开关持久化到本插件自己拥有的 `$DSH_HOME/memory/config.json`：

```jsonc
{ "enabled": false }
```

理由：`.volatile()` 属于 `@deepseek-ai/schemastery`，它是 private 的 vendor 包，而 `plugins/*` 不在 pnpm workspace 成员里 —— 本地插件要 import 它就必须手建 `node_modules` 链接，破坏本地插件"零运行时依赖、装完即用"的性质。Memory 目录本来就归本插件所有，因此开关由插件自己持久化，不经过 `ctx.settings`。

规则：

- `apply()` 读该文件并与 cordis config 合并，**文件优先**（它记录用户最后一次显式选择）；cordis config 的 `enabled` 是初始值；
- `/memory enable` / `disable` 写该文件；**成功返回后立即对本次进程生效**（后续 turn 不再注入、工具消失），重启后依然生效；
- `enabled = false` 时 **dispose** Memory index 注入与三个工具的注册（注册即 effect，不能靠回调空转）；
- `/memory` 命令**永远注册**，因此 `/memory enable` 永远可用；
- 写该文件失败时向用户报错，不静默吞掉；
- **`enabled = false` 也停止 Phase 2 的自动学习，并收束正在进行的运行。** 具体顺序：设置开关 → 取消尚未触发的 debounce → dispose runtime → **等待在飞的自动运行结束**（`whenSettled`）。因此 `/memory disable` **成功返回后**，不会再发生：事件采集、模型调用、Memory 写入、mark 推进。`enabled = false` 期间新提交的事件不会被采集，重新 enable 后不会补做（那段时间在进度上表现为 gap）；
- `consolidation.enabled = false` 只关自动学习，不影响显式 `memory_remember` 与命令面；两者都关时 `/memory consolidate` 会被拒绝；
- 该文件不存在时视为"未设置"，使用 cordis config 的值。

---

## 18. DSH 实现约束

本地 link 安装的插件，以下都是硬边界：

1. Message source kind 由生产者自己声明，DSH 没有通用 `'plugin'` kind；
2. Prompt registry 没有 token / byte 预算，§14 的预算全部由本插件强制；
3. 没有 `session/idle`、saved、closed 钩子；本次不使用 idle 触发；
4. 新 session event type 必须带 `ignorable: true`（Phase 1 不写 session 事件）；
5. Tool 调用自动进 log，Phase 1 因此不需要额外事件；
6. `getContextOrder()` 只接受中央分配的名字，本地插件只能给字面量 order；
7. `ctx.workspaceRegistry` 只在 Web bundle 挂载，只作解析顺序第 2 步；
8. 不 import harness 包：自己解析 `$DSH_HOME`，不用 `ctx.storageDomain`，不写 `~/.dsh/storages`；补读历史只经 `ctx.get('sessionQuery')`（可选服务，缺失即退回 gap 语义）；
9. Tool exec context 只提供 `{callId, rootCallId, name, schema, arguments, agent, parent, signal}`，没有 turn / user message / event seq，所以 §6.1 的 provenance 从 `session/event` 事件流取；同步读日志的 `eventAt` 已被上游标记为禁止新调用。

---

## 19. Definition of Done

- [ ] 所有 Memory 位于 `$DSH_HOME/memory`
- [ ] User Memory 跨 Project 可见
- [ ] Project Memory 严格隔离
- [ ] Project 支持 bind / relink；不存在的 alias 不破坏解析
- [ ] cwd 子目录通过 longest ancestor match 找到正确 Project
- [ ] registry 两层唯一性；自动注册幂等且带锁
- [ ] canonical 有 revision；两进程并发写无 lost update
- [ ] 任何失败路径都释放锁；atomic write 失败不留 temp
- [ ] dead stale lock 可恢复；live lock（含 EPERM）不被误抢
- [ ] stale reclaim 自身被串行化：两个 reclaimer 竞争只有一个成功，且都不会删掉对方新建的锁
- [ ] `agent/created` 的 dispatch 解析完成时，该 session 的 project 已经可用（首轮不会缺 project index 或被拒的 project-scope 写入）
- [ ] session 的 project 缓存在 bind / relink 之后立即刷新
- [ ] 删除一条被引用的记录时，前驱要么接上新后继，要么转为 archived；store 里不留悬空的 `superseded_by`
- [ ] 读入 `memories.json` / `registry.json` 时校验记录与条目；损坏或越界的文档 fail loud，不进入 index、view 或模型请求
- [ ] canonical 读取失败让本轮 model request 中断（fail loud），绝不静默渲染成空摘要；store 不存在不算损坏
- [ ] 注入文本不带任何一条记录正文；固定部分（notice、计数、文件路径）在预算内永不缺失
- [ ] 摘要超预算时只裁模型写的那段，且按 UTF-8 字节切、不劈开字符
- [ ] project id 不能变成 Memory 根之外的路径
- [ ] temp 清理递归覆盖嵌套 scope，且只删超过阈值的自有临时文件
- [ ] `memory_get` 只把"不可见"当作 not-found；store 读失败照常抛出
- [ ] `forget` 在 tombstone 写不进去时如实报告，不谎称留痕
- [ ] `memory_search` 的 `top_k` 受 `retrievalTopK` 约束
- [ ] runtime（index + tools）由 `ctx.inject()` 返回的 Fiber 持有；disable 即 dispose 该 Fiber，service remount 不会让已禁用的注册复活，反复 enable/disable 始终只有一个活跃 Fiber
- [ ] 依赖 service 尚未就绪时 disable：pending Fiber 也要被 dispose，之后依赖就绪不得再注册（否则 disabled 状态下会出现 index/tools）
- [ ] `.reclaim` 互斥不做自动回收；两个 reclaimer 竞争只有一个成功，且都不会删掉对方新建的互斥
- [ ] `maxEvidencePerMemory` 只是 writer policy：写入时保留最新 N 条，读入时不用它判定记录是否合法
- [ ] registry 载入时按 §10.3 的两层 key 判重：同一目录的两种拼写（符号链接、或未归一化的 `..`）不能成为两个 Project
- [ ] 命令解析支持引号与转义（`"..."`、`'...'`、`\ `），带空格的路径是一个参数
- [ ] 未闭合的引号不静默解析：拒绝整行并说明原因，绝不按猜出的参数边界执行
- [ ] 每次 mutation 在运行前先校验读到的 store；noop mutation 也要拒绝损坏的 store
- [ ] `clear` 与 `forget` 一样，在 tombstone 写不进去时如实报告
- [ ] `memories.json` 只含索引字段（无 `content` / `evidence`）；每条记录都有 `memories/<id>.md`，索引里不存在的正文文件在下一次写入时删除
- [ ] 正文缺失时读取 fail loud，报错含记录 id 与路径；索引写入是提交点，正文先写
- [ ] Memory 摘要能进入新 Session 的实际 request
- [ ] `memory_search` / `memory_get` 可用
- [ ] `memory_remember` 支持显式 add / update(target_id) / supersede(target_id)
- [ ] update / supersede 的 scope 继承 target
- [ ] stale target 在 lock 内重验并 fail conflict
- [ ] Phase 1 writer 固定 confidence=1.0；storage schema 允许 `[0,1]`
- [ ] provenance 由 host 生成，模型不能注入 evidence
- [ ] evidence 绑定当前 turn；seq 不可得时留空而非猜
- [ ] content 命中 secret → 拒绝；被引用源文本命中 → 截断前脱敏成 `[redacted]`，quote 不含凭据片段
- [ ] 落盘前再扫 content + quote；调用方直传原始 quote 也拦得住
- [ ] secret 保证范围明确（不含 Session trajectory）
- [ ] tombstone 无正文；并发写产生合法 JSONL
- [ ] exact duplicate 不做 lowercase
- [ ] 不做 hidden semantic dedupe / automatic conflict detection
- [ ] archive / forget / clear 可用；无 physical archive copy
- [ ] raw secret 不进入 Memory
- [ ] `/memory` 命令可用
- [ ] disable 后 index 与三个工具消失；`/memory enable` 仍可用
- [ ] 跨 Session / Project isolation / User cross-project / Explicit supersede 四条集成测试通过
- [ ] 中文 / CJK 检索可用
- [ ] 预算按 UTF-8 字节、整行裁剪

---

## 20. Phase 1 之后

Phase 1 完成并实际使用一段时间后再考虑 Phase 2：

```text
Trajectory → Automatic Consolidation → 语义 dedupe / update / supersede
```

以及正式的 Memory OFF vs Memory ON MemEval。Phase 1 到这里停止继续扩设计。

---

# Phase 2：同步自动 consolidation

Phase 2 增加的是**从新 Session 轨迹自动提炼持久 Memory**。它决定"该记什么"；Phase 1 继续负责"如何安全落盘"，本节不修改 Phase 1 的存储、锁、schema、project identity、检索与派生视图。

```text
新 Session 事件（mark 之后）
        ↓ 过滤 ignorable / 内部事件
        ↓ 人类轮次门禁
        ↓ 一次 consolidation LLM 调用
        ↓ 结构化 operation plan
        ↓ 确定性校验（含 evidence seq 核验）
        ↓ 复用 Phase 1 actions 提交
        ↓ 前进 mark
```

## P2-1. 轨迹边界：插件维护自己的投影

**不得使用已弃用的同步会话历史读取**（`Session.eventAt` / `snapshotEvents` / `ownEvents`）。依据 `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`；该决定同时禁止"提供同样同步历史访问的新别名或包装"。

因此 collector 订阅 `session/event`（post-commit 追加流，与 Phase 1 的 provenance 同一机制），增量维护按 Session 的事件投影。轨迹边界就是该投影。

由此产生的语义，必须按下面写明，不得含糊：

```text
mark = 已消费到的 seq，不是可从存储重读的光标。
```

- **正常情形**（插件在该 Session 产生事件前已挂载）：投影覆盖全部新事件，mark 精确推进。
- **间断情形**（Session resume、插件晚挂载、进程重启、缓冲被上限截断）：投影看不到那一段。**先向 harness 的 `sessionQuery` 要这段历史**（`readEvent` 窗口，按 seq 范围；单次区间上限 2000 事件，超过则仍记 gap）；能**完整**读回时把它折进本批，不记 gap。读不回（服务未挂载、区间被清理、读取失败，或只返回部分）时不得伪造，也不得假装读过：把这段区间记为一次 **gap**（`from_seq` / `to_seq` / `at`），mark 跳过它。gap 必须落在 `consolidation-state.json` 里，并计入审计，使"没看见"与"看了但没有值得记的"可区分。
- 从未观测过的 Session（无 mark 且无事件）报 `nothing-observed`；已消费完的 Session 报 `nothing-pending`。两者不同，不得合并。

## P2-2. 进度文件

```text
$DSH_HOME/memory/consolidation-state.json
```

```json
{
  "schema_version": 1,
  "sessions": {
    "session_abc": {
      "last_processed_seq": 241,
      "gaps": [{ "from_seq": 183, "to_seq": 199, "at": "2026-09-29T..." }],
      "updated_at": "2026-09-29T..."
    }
  }
}
```

规则：

- `last_processed_seq` 以**原始 `SessionEvent.seq`** 为坐标，不是"相关事件数"或"人类消息数"；
- 未消费过时为 `-1`（**不是 0**：seq 0 是真实事件，两者不能长得一样）；
- mark **只前进**：迟到的批次不得把它拉回去；
- 读写走与 Phase 1 相同的锁与原子写；损坏的状态文件 **fail loud**，不得重置。
- 文件不存在是首次运行，读作空状态。

## P2-3. 过滤规则（四类，顺序有意义）

```text
ignorable === true   → 忽略：不送模型、不可作 evidence，但必须被 mark 消费
dsh-reflection/*         → 内部事件：同上，另按命名空间排除（纵深防御）
已知且承载轮次内容    → 归一化后送模型（user/message、assistant/message、tool/call、tool/result、developer/message）
已知但只是簿记        → 消费、不送、不失败
本 build 不认识       → **停止本批次并指名类型**
```

最后一类是刻意的：harness 用 `ignorable: true` 标记"读者可以安全跳过"，没有该标记即意味着读者应当看得懂 —— 会话日志自身遇到不认识的事件类型也是拒绝读取。**不得实现"不认识就静默丢弃"。**

**人类轮次门禁**：`user/message` 同时承载合成的注入内容（AGENTS.md、skill、文件变更通知等），因此门禁判据是 `source.kind === 'user'`，不是事件类型本身。窗口内没有人类轮次时：不调用模型，消费窗口，审计记 `no-human-turn`。

## P2-4. 模型输出与插件权威

模型只提议操作，且只允许 `add` / `update` / `supersede` / `noop`。**不得**自动 `forget` / `clear` / `delete` / `archive`。

模型**不得提供被持久化的 evidence**：它只给 `evidence_event_seqs`，插件负责核验（存在、在窗口内、确实送给过模型、非 ignorable、非内部事件）并**自行**从被引用事件取 quote、过 secret 扫描、构造 provenance。

两类问题的处理**不同**：

```text
计划读不出来（非对象 / operations 非数组）→ 整批失败，mark 不动
单个操作站不住脚（目标无效、evidence 不实、改写低于置信度、命中 secret）→ 丢弃该操作并记原因，其余照常提交，窗口消费；低于置信度的 add 是例外，写入但不服务
```

`update` / `supersede` 的 scope **继承自目标记录**，模型给出的 scope 被忽略，因此一次改写不能把事实挪到另一个 project。

置信度门槛 `minConfidence` 默认 `0.8`：低于门槛的 `add` 仍持久化但不服务；低于门槛的 `update`/`supersede` 拒绝。

## P2-5. 提交与失败语义

提交**必须**复用 Phase 1 的 `addMemory` / `updateMemory` / `supersedeMemory`：同一把锁、同一 secret 扫描、同一 canonical 校验、同一视图重建。不得新增第二套存储写入路径。

```text
committed（added/updated/superseded）→ Memory 已变
skipped（duplicate / conflict）       → Memory 未变且没出错，不得拖住 mark
failed（写入没发生）                  → mark 不动，窗口重试
```

成功、仅 NOOP、仅 ignorable、无人类轮次 → **都算成功并前进 mark**（否则同一段无关轨迹会被永远重新检查）。任何失败、以及**部分提交**，mark 都不前进；重试时**重读最新 Memory 状态重新决策**，不重放旧计划。

collector 保留**所有** seq（包括本插件自己写的 audit）：audit 会通过 `session.append()` 同步发布回 `session/event`，所以它确实进入缓冲区。区别在分类与收尾：`dsh-reflection/*` 归为 internal，既不进模型输入、也不作为 evidence；**只含 internal/skipped 事件（即 `relevant_events === 0`）的窗口被消费但不写审计** —— 否则一条 audit 会成为下一个窗口的内容，再写出下一条，命令永远到不了 `nothing pending`。

有界输入：超过 `maxRelevantEventsPerBatch` / `maxTrajectoryBytesPerBatch` 时只消费最旧的有界前缀，mark 只前进到该前缀末尾。单个超大事件仍必须被消费（截断其文本），否则该窗口永远无法前进。

**字节预算按 UTF-8 字节计，且作用于整条序列化后的 entry**（含 envelope 字段的开销），不是按字段、也不是按 JS 字符数 —— 后者会把中文低估约三倍。截断按 code point 推进，绝不切开代理对。

## P2-6. 审计

每次运行写一条 `plugin:dsh-reflection/consolidation` 插件记录（`appendPluginRecord`），内容为计数：`from_seq` / `to_seq` / `relevant_events` / `ignored_events` / `operations` / `status`。记录信封由 harness 打上 `ignorable: true`，因此不进模型可见面；迁移前写入的 `dsh-reflection/consolidation` 老事件读回时按前缀同样识别为自有记录。

不得写入：secret、完整轨迹、完整 Memory 内容。审计用于调试与评估，不是第二份 Memory。

审计写入失败**不得**让 mark 回退（提交才是保证，留痕只是留痕），但要 warn。审计记录不可能喂回下一轮：collector 按命名空间排除自己的记录。Payload 必须可无损 JSON 化 —— 缺失的可选字段要留空不写，而不是写成 `undefined`（写入器会拒绝 `undefined`）。

## P2-6b. 支持范围：自动学习需要长驻实例

自动 debounce 的定时器**按设计位于 maintenance 之外**（否则等待期间会占住 agent）。因此它只在一个仍然存活的进程里才会到期：

```text
长驻 profile（desktop / web）→ 自动学习按设计工作
headless 一次性运行          → 任务轮次 idle 后进程随即退出并 dispose，debounce 不会到期
```

这是**已确定的范围，不是待修缺陷**：让一次性运行也自动 consolidation，需要 harness 的运行器在退出前等待 deferred work，属于 harness 侧改动，不是本插件能拥有的行为。因此：

- 自动学习只在长驻实例上发生；
- 一次性运行里，`/memory consolidate` 是受支持的入口（同一套流水线，可 `--dry-run`）；
- 该约束必须写在 README 的已知限制里，不得让读者以为 headless 也会自动学习。

## P2-6c. 为什么没有"持续观察"模式

早先的设计让 `autoCommit: false` 仍然读取窗口并调用模型，只是不写入。那条路被取消了，原因有两条，都不是实现细节：

```text
它每次空闲都真的调用模型 —— 花钱，却不产出任何学习结果；
它还会反复把最旧的一段送去评估，因为"不写"意味着进度书签不动，
新内容因此长期轮不到。
```

要让它成立需要两样本版本没有的东西：一个独立于写入进度的**评估游标**，以及一份可恢复的**待评估轨迹**（5000 条内存缓冲保证不了）。与其半做成一个既烧钱又看不到新内容的模式，不如不要它：**自动学习要么开着，要么关着；想按需评估就用 `/memory consolidate --dry-run`。**

## 构建产物与开发回路

**规范来源是 `src/**/*.ts`，运行的是 `lib/`。** 入口（`main` 与 `exports["."]`）指向 `lib/index.mjs`，profile 通过 `link:` 加载它；`lib/` 不入库，由 `prepare` 在安装时构建。

分工：`tsdown` 转译并打包运行时，`tsc --emitDeclarationOnly` 产出声明，`typecheck` 报告类型债。`tsc` 无法"只产出不检查"，所以运行时不能交给它 —— 否则一个尚未类型化的模块会让构建失败，而构建失败在 `link:` 安装下意味着插件加载不了。这与 harness 自身的构建方式一致。

因此**开发回路是"改完先 build 再重启"**；测试不受影响，它们通过 tsx 直接跑 `src/` 的源码，不需要 build。

## resolveConfig 产出 host、kill 与 logger

`resolveConfig` 现在产出 `index.ts` 一直在读的三个字段：

- **`host`** —— 部署在插件配置里命名主机时用配置值，否则取 `hostname()`；写进锁记录与墓碑，用于在共享 Memory 根下分辨是谁写的。
- **`kill`** —— 默认 `process.kill`；只有在没有真实进程可用的测试里才需要替换它。
- **`logger`** —— 由运行时注入（`resolveConfig(config, env, ctx.logger)`），因为诊断出口不属于配置文件。

此前这三处是"读不存在的属性"（永远 undefined，行为上被各选项的默认值掩盖）。配置的路径值（`dshHome`）与这三者一样来自未校验的配置，因此 `resolveDshHome` 接受 `unknown`，由内部的 `nonEmpty` 判断。

## 已知缺口：lock.ts 的两种选项形态混用

`lock.ts` 的四次尝试都失败过，原因逐步查清：

1. `withoutUndefined(options)` 的返回类型原先被推断成空对象，`resolved.lockPath` 等 6 处报"属性不存在"。**这一处已单独修好**（64 → 58）。
2. 只给 `withLock` 加签名不够：模块**内部**还有几个未标注的函数（`reclaimIfStale`、`observeLock`、`acquire`）会报出来。
3. 把它们统一成"已解析"形态（`ResolvedLock`，阈值必有）也不成立：**有些内部调用点传的是"请求"（阈值可选）**，函数体却按"已解析"读阈值。

**给下一个读者的提醒**：这个模块混用了两种形态，而**哪个调用点传哪一种，只能逐个读**（`withLock` 里构造出 `resolved`，其它位置可能只有请求）。先做一张"调用点 → 拿到哪种"的清单，再决定拆成两个函数还是让内部自行补默认值 —— 任何"一次全标上"的尝试都会二三十个错误地变差（试过四次）。

## 已知缺口：project 作用域缺 projectId 的探测路径

`actions.ts` 的 `requireLayout(options, scope, projectId)` 在 `scope` 为 project 时会用 `projectId` 解析布局。**存在调用路径传入 project 作用域而没有 projectId**：`updateMemory` / `supersedeMemory` 会用它去探测目标记录属于哪个作用域，`commit.ts` 里"省略 projectId 会让项目目标不可见"那段注释说的就是这件事。

现状是静默的：`options.scopes.project(null)` 会照常返回一个布局（目录名由缺失的 id 拼出），探测因此"查不到"而继续。

**给下一个读者的提醒**：不要直接在 `requireLayout` 里加"缺 id 就报错"。试过一次，单测从 1325 断言掉到 481 —— 说明这条路径是被依赖的，得先看清调用方真正想要什么（是探测、还是写入），再决定改哪一端。类型上把它标成 `string | null | undefined` 是安全的；改变运行时行为不是。

## P2-7. 不修改的部分

`jsonstore.js`、`registry.js`、`retrieval.js`、Phase 1 锁设计、canonical schema、project identity、索引与正文的拆分、`memory_search` / `memory_get` / `memory_remember` 的既有语义。

Phase 1 的 secret writer-policy 同样适用于 Phase 2：新增文本（新 content、新 quote、被引用的完整源文本）必须过扫描；历史 evidence 不因无关操作被按新规则重扫。

## P2-8. Phase 2 DoD

- [ ] 只消费 mark 之后的事件；`only_new_events_are_collected`
- [ ] `ignorable` 事件不送模型、不可作 evidence，但仍被 mark 消费
- [ ] 内部事件不影响学习，且不产生反馈环
- [ ] 不认识的**非** ignorable 事件不被静默丢弃
- [ ] 能完整读回的间断区间被补读、不记 gap；读不回的区间被记为 gap 而不是静默跳过
- [ ] 人类轮次门禁生效；无人类轮次的窗口被消费且不调用模型
- [ ] 模型只能提议 add / update / supersede / noop；删除类操作被拒
- [ ] evidence seq 逐条核验；provenance 由插件构造
- [ ] 低于 `minConfidence` 的 add 落盘但不进 summary/search；改写被拒绝
- [ ] update / supersede 的 scope 继承自目标
- [ ] 提交复用 Phase 1 actions（同一锁、同一 secret 扫描、同一视图重建）
- [ ] 成功 / NOOP / 仅 ignorable / 无人类轮次 → mark 前进
- [ ] 失败与部分提交 → mark 不动，重试时重新决策
- [ ] 有界输入；超大单事件仍能推进
- [ ] 审计事件带计数、标 ignorable、不泄漏内容、写入失败不回退 mark
- [ ] 下一个 Session 能检索到自动学到的 Memory

## 插件改名：dsh-reflection → dsh-reflection

DSH STORE 的固定 Commit 检查（Issue #1245）判定的两条确定原因是：包名 `dsh-reflection` 与商城已有条目
（`FuRongJun-1999/dsh-reflection`）冲突，以及 manifest 缺少逐版本 `dsh.compatibility.dshReleases` 声明。
插件因此改名为 **dsh-reflection**（查过商城索引 746 条，该名未被占用）。

**改名范围与故意不改的部分：**

- 改：`package.json` 的 `name`、`cordis.patch.yml` 的 Bundle entry `id`/`name`、README/contract 文档中的插件名、
  以及本机 desktop profile 的依赖键、bundle 列表与 patch entry id。
- **改：会话记录名改为 harness 的 `plugin:` 命名空间** —— `plugin:dsh-reflection/consolidation`、
  `plugin:dsh-reflection/project`。`appendPluginRecord` 只接受这个命名空间，并由 harness 负责打上
  `ignorable` 标记。历史会话里的旧名 `dsh-reflection/…` 仍被识别：客户端的行折叠与 collector 的分类
  同时认两个名字，所以老日志照常显示、照常被跳过，不需要改写任何已提交的代际。
- 不改：仓库目录名与 GitHub 仓库名（它们是路径与远端名称，不是包标识）。
- 暂未改：诊断消息前缀 `dsh-reflection:`（纯文案；改它需同步 `test/views.spec.mjs` 的三处断言）。

## 剩余类型错误为何不能靠标注收敛

`lock.ts`、`consolidation/index.ts`、`validate.ts` 共 23 个错误（其余模块为 0，客户端为 0）。对
`lock.ts` 做过 13 次已验证实验（统一具名形状 6 次、使用点补默认值 3 次、行内局部类型 1 次、
`resolved` 唯一入口 + `KillProbe` 别名 1 次、分散单点 2 次），每次都确保改动全部命中、零跳过，
每次都以错误数上升告终。

原因是**跨模块的选项形态没有对齐**，而不是单个函数缺标注：`withLock` 的调用方
（`jsonstore.ts`、`registry.ts`、`consolidation/state.ts`）各自声明了选项类型，其中
`lockTimeoutMs`/`staleLockMs` 被写成可选；`ActionOptions.kill` 的类型也与 `process.kill` 的签名不一致；
`commands.ts` 因此连带报出 `bound` 的未知类型。要收敛必须先统一这一组声明（阈值改为必需、探针类型
统一为一个别名），再改各内部函数的 contract —— 这是一次约 6 个文件的结构改动，不是标注工作。

## 剩余 16 个类型错误：逐个的改法（已验证到"只剩执行"）

服务端 16 / 客户端 0。下面每一项的改法都已由实验确定；`lock.ts` 已清零（9 → 0），其经验是：
**别名取宽的一侧**（`type KillProbe = (pid: number, signal?: number) => boolean`，不要用
`typeof process.kill`——它返回字面量 `true`），**跨文件声明必须整套对齐**，**每次替换都要断言命中**。

已在多次尝试中写好并通过检查、需要与新改动一起重放的项：

- `consolidation/index.ts`：`RunConfig`（含 `quoteMaxChars: number`）、`RunAudit`（含索引签名，
  `operations` 还要 `skipped?`/`failed?`）、`ConsolidationOptions`（`callModel?(request: ConsolidationRequest)`）、
  `createConsolidation(options: ConsolidationOptions)`、`recordAudit(session: MemorySession, audit: RunAudit): void`、
  `describeOutcome(outcome: RunAudit): string`、`consolidate(agent, runOptions: { dryRun?; trigger?; signal? })`。
- `consolidation/collector.ts`：`dropConsumed(sessionId, throughSeq: number | undefined)` + 体内
  `if (throughSeq === undefined) return 0`。
- `consolidation/validate.ts`：`ReviewContext.content` 改为可选（那条调用由被调方覆盖它）。
- `src/types/harness.d.ts`：把 `SessionRoute`（`{ readonly provider?: string; readonly model?: string }`）
  内联后给 `MemorySession` 补 `requestHeader()`；`model.ts` 里的同名接口是模块内的，不冲突。
- 运行选项类型补 `signal?: AbortSignal`（错误文本里引用的原文是
  `{ dryRun?: boolean | undefined; trigger?: string | undefined }`，可据此定位）。

仍未处理的项：

- `consolidation/index.ts`：315 / 421 两处 `number | undefined`（对应函数参数加 `| undefined`）；
  538 `Record<string, number>` 不能赋给 `number`（`countRejections` 的用法）；550 `outcome.accepted`
  是 `unknown`（`RunAudit` 补 `accepted`）。
- `consolidation/validate.ts`：显式 `ReviewOutcome` 返回并据此收窄 88/91 的 `code`/`operation`；
  217 / 229 的参数接受 `undefined`。
- `src/index.ts`(205)：`matched_by: string` 收窄为 `ProjectMatch`。
- `src/actions.ts`(436)：`mutateAndRefreshView` 的 `result` 需为对象类型（现在 spread 的是 unknown）。
- `src/commands.ts`(208)：把 `unknown` 传入 `RunAudit` 参数。

## 最后 4 个类型错误：两条链，必须整段落地

当前：服务端 **4** / 客户端 **0**（`npm run typecheck`）。这 4 个都不是"缺一个标注"，而是
**两条必须一次做完的链**——只做其中一层必然级联（本会话实验 4 次：5→16、5→15、4→17、4→6）。

**硬规则：运行时四条命令必须始终绿**（`npm run test:unit` 1325 断言、`npm run test:integration`、
`npm run build`、`node --import tsx/esm test/client.smoke.mjs`）。曾有一次改动破坏了 `withStore`
的签名、`test:unit` 掉到 227 断言，当场回退——**破坏运行时的中间态不可接受**。

### 链 1：`consolidation/validate.ts`（3 个错误）

`export function reviewOperation(operation, context: ReviewContext)` 的返回是**推断联合**，成员
`kind` 被放宽成 `string`，于是 `reviewPlan` 读 `review.code` / `review.operation` 失败。

改法（**一次做完**）：签名改 `(operation: unknown, context: ReviewContext): ReviewOutcome`，
加 `asRecord(value: unknown): Record<string, unknown> | undefined`，把体内 `operation.` 换成收窄后的
名字，再补 **11 处逐字段守卫**：151/160/161/166（`string`）、167（字面量 `kind`）、172
（`'add' | 'update' | 'supersede'`）、173/174（`MemoryRecord`）。只做头部会 4 → 15。

### 链 2：`actions.ts`(436)（1 个错误）

`apply` 里 `{ ...outcome.result, … }` 的 `outcome.result` 是 `unknown`。源头在
`jsonstore.ts`：`StoreMutation` 的 `result?: unknown`。

改法（**一次做完**）：`StoreMutation<T = Record<string, unknown>>`、`withStore<T>(… operation:
(store: MemoryStore) => StoreMutation<T> | undefined)`、`apply<T extends Record<string,
unknown>>(…)`（三处精确文本替换即可命中），**并且**给六个调用方（`actions.ts` 的
81/128/164/206/229/278）的回调返回形状补齐，让 `T` 能被推断出来。只改前三处会 4 → 17。

> 经验：这三处用**逐处精确文本替换**（每处断言命中一次）是可行的；用正则往签名里插 `<T,`
> 会静默破坏签名并连带打断运行时（第 18 轮已发生一次）。

## 类型检查现状

`npm run typecheck` 两个面都是 0（服务端 `tsconfig.json`、客户端 `tsconfig.client.json`）。运行时四条命令
必须保持绿：`npm run test:unit`（1325 断言）、`npm run test:integration`、`npm run build`、
`node --import tsx/esm test/client.smoke.mjs`。

改这些模块时值得记住的两条：

- **改签名要读逐字原文再整段替换**。往里插泛型参数时用正则拼参数列表，会把多行签名改坏并让运行时
  失败（`test:unit` 掉到 227 / 136 断言各发生过一次）；逐字原文替换则从未失手。
- **一个类型化的接缝会把下游的推断收紧**。给 `withLock`/`withStore`/`apply` 这类函数加上泛型或返回
  类型后，之前因未标注而"通过"的下游会立刻报错；因此声明与其调用点要一起改，只改一侧必然级联。
