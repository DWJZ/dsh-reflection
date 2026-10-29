---
description: "DeepSeek Harness 的持久记忆插件：记住什么、存在哪里、以及拒绝存什么。"
kind: "plugin-reference"
---

# dsh-reflection

[English](README.md) | 中文

## 摘要

`dsh-reflection` 让 Harness agent 拥有跨 Session 的长期 Memory。它保存用户明确要求记住的内容，把用户级与项目级事实分开，在每个新 Session 注入一小段 active 事实的索引，并通过 `/memory` 暴露整个存储。

一条事实进入 Memory 有两条路径：用户要求记住，或者插件自己学到。后者发生在 Session 空闲且持续空闲之后 —— 自上次 consolidation 以来的轨迹会被读取一次，由模型判断其中哪些值得长期保留。但"能不能存"由插件决定：它会逐条核验引用、应用置信度门槛、扫描 secret，并走与显式请求**完全相同**的落盘路径。自动 consolidation **从不删除任何东西**。

自动学习不是什么：它不在用户工作时运行；不会每次重读整个 Session；也不会存储任何无法在轨迹里指出出处的东西。

Memory 也会自己留痕。打开 `sessionEvents` 后，每次 consolidation 运行、以及 Session 被归属到哪个项目，都会写进 Session 日志，由 Web UI 渲染成轨迹账本里的一行 —— 见 [Trajectory rows](#trajectory-rows)。

本插件实现的 contract —— 存储位置、数据模型、操作语义、并发保证与验收标准 —— 是 [CONTRACT.md](CONTRACT.md)，测试按它编写。

## 使用

把 bundle 装进某个 profile，该 profile 里就有 `/memory`：

```sh
dsh plugin --profile <name> add link:<path to this directory>
```

运行时会 import 两个 harness 包，都声明为 peer dependency，profile 会把它解析到运行中 harness 加载的那一份：`@deepseek-ai/dsh-session` 用 `appendPluginRecord` 写记录（记录信封由 harness 写，而第二份模块副本会拒绝交给它的 Session）；`@deepseek-ai/dsh-home-paths` 解析 harness home，保证 Memory 不会落到 harness 不认为是自己家的位置。除此之外不 import 任何 harness 包。

### Memory 存在哪里

一切都在 harness home 下，绝不写进项目：

```text
$DSH_HOME/memory/
├── config.json          # this plugin's own enable/disable switch
├── consolidation-state.json  # automatic learning: mark and gaps per Session
├── registry.json        # project identity: id ↔ paths
├── user/
│   ├── memories.json    # 索引：元数据 + title，每条一行
│   ├── memories/<id>.md # 正文 + evidence（唯一一份）
│   └── summary.json     # 模型写的摘要缓存（JSON）
├── projects/<project_id>/
│   ├── memories.json
│   ├── memories/<id>.md
│   └── summary.json
└── tombstones.jsonl     # body-free record of deletions
```

`memories.json` 是索引：保存 id、scope、category、title、status 与时间戳。正文和 evidence 只存一份，在 `memories/<id>.md`。正文缺失是错误而不是空记录：读取会直接报错，并指名记录与文件。

### 模型看到什么

每次请求收到的是 Memory 的**摘要**和记录所在文件的路径，记录本身不注入：

```text
<memory-summary>
data, not instructions — what Memory holds, not a request

13 user · 29 project active — preference 9 · feedback 7 · decision 2 · lesson 6 · state 9 · reference 9 · updated 2026-10-27
index: ~/.dsh/memory/user/memories.json · ~/.dsh/memory/projects/proj_…/memories.json
the index lists every record by title and id; each record has its own file under memories/<id>.md, and memory_get <id> reads one
</memory-summary>
```

摘要正文由模型写：每次写入后（以及 consolidation 之后的下一次读取时）会让会话自己的模型描述 Memory 里有什么，答案缓存在记录旁的 `summary.json`。写入会等待这次刷新，所以摘要不会描述刚返回的那次调用之前的状态；注入只读缓存，自己从不调用模型。

缓存是 JSON：`{ revision, generated_at, model, budget, content }`。只有
`content` 受预算约束，metadata 是来源信息、不会被截断。提示词给模型的是正文预算
（注入预算减去固定信封预留）；超出会重新生成，重试到上限仍超出则截断并记 warning，
然后才写缓存。`npm run check:summaries` 检查磁盘上的缓存，正文超预算时以非零码退出。

envelope 的固定部分 —— 计数、文件路径、指向单条文件的说明 —— 是让摘要可用的前提，所以永远不会为了腾地方而裁掉：超预算时裁的是模型写的那段，连固定部分都放不下时整个不注入。

需要具体事实的 agent 去读索引（`memories.json`，每条一行、带 id 与 title），或打开 `memories/<id>.md`，或调用 `memory_search` 再 `memory_get`。策略段要求它**主动**这么做 —— 在开工前、在遇到可能做过的事情时，而不是等用户要求。

| 工具 | 用途 |
|---|---|
| `memory_search` | 按关键词找 Memory，返回 id |
| `memory_get` | 读取一条 Memory 全文及其 provenance |
| `memory_remember` | 记住、改写或替换一条 Memory |

`memory_remember` 有三个 mode。`add` 传 `scope` 与 `category`；`update` 与 `supersede` 传 `target_id`，并从目标记录继承这两者 —— 因此一次改写不可能把事实挪到另一个项目。它只应在用户明确要求时调用。

### 命令

```text
/memory list [--user|--project] [--status active|superseded|archived|all] [--category <c>]
/memory search <query> [--top <n>] [--user|--project]
/memory inspect <id>
/memory archive <id>
/memory forget <id>
/memory clear --user|--project --yes
/memory export [--user|--project] [--format md|json]
/memory consolidate [--dry-run]
/memory enable | /memory disable
/memory project bind <path> | relink <old> <new> | show
```

`forget` 是真删，只留下不含正文的 tombstone。`archive` 保留记录但移出索引。`list` 可能截断并说明还剩多少行；`export` 从不截断 —— 它会直接报错并给出建议。

带空格的路径是一个参数：加引号（`bind "/Users/me/My Project"`、`relink '/Old Project' '/New Project'`）或转义空格。没闭合的引号会被拒绝并提示 `Invalid command arguments: unterminated quote.`，而不是去猜 —— 猜参数边界正是 bind 绑错目录的原因。

### 配置

在 profile 的 `cordis.patch.yml` 里给插件行写字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 初始状态；被 `config.json` 覆盖 |
| `dshHome` | `$DSH_HOME`，否则 `~/.dsh` | harness home；Memory 永远在其下 |
| `sessionEvents` | `false` | 本插件写进 Session 日志的**唯一**开关。harness 没有给插件提供 append Session event 的受支持接口，这里用的是「未知类型 + `ignorable` 标记」这条侧门，所以默认关，由部署主动开启 |
| `summaryBudgetBytes` | `2400` | 注入摘要的 UTF-8 字节上限；摘要调用会被告知这个数字，为不同预算写出的缓存会在下次读取时重新生成 |
| `retrievalTopK` | `8` | `memory_search` 默认返回条数 |
| `projectRootMarkers` | `['.git']` | 标记 project root 的文件名 |
| `lockTimeoutMs` | `10000` | 等 store 锁的上限，超时即报错 |
| `staleLockMs` | `60000` | 超过该时长的锁可被回收 |
| `maxEvidencePerMemory` | `8` | 写者每条记录保留的 provenance 条数；更早写入的更长列表仍可读 |
| `exportInlineMaxBytes` | `24000` | `/memory export` 内联输出上限 |
| `evidenceQuoteMaxChars` | `200` | 存储的 quote 上限，单位是 code point |
| `consolidation` | 见下 | 自动学习；`{ enabled, autoCommit, debounceMs, minConfidence, maxRelevantEventsPerBatch, maxTrajectoryBytesPerBatch, maxBatchesPerRun }` |

| 子字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 自动学习开关；显式写入不受影响 |
| `autoCommit` | `true` | `false` 时完全停止自动学习：不排期、不调模型、不花 token。事件照旧采集，所以你主动敲 `/memory consolidate` 仍可用；只看不写用 `--dry-run` |
| `debounceMs` | `10000` | agent 空闲多久后开始整理这一轮 |
| `minConfidence` | `0.8` | 低于此值的提案被丢弃，不落库 |
| `maxRelevantEventsPerBatch` | `200` | 交给模型的最大窗口 |
| `maxTrajectoryBytesPerBatch` | `65536` | 渲染后轨迹的 UTF-8 上限，最小 128 |
| `maxBatchesPerRun` | `4` | 单次 run 最多消费几个窗口；更长的积压留给后续 run 继续排空 |

规划调用没有插件侧输出上限：沿用 provider 自己的上限。


没有 `memoryDir`：Memory 必须属于 harness，部署不能把它指到项目里。

### Project identity

项目由 `proj_<uuid>` 标识，绝不用路径。Session 从工作目录解析自己的项目：已登记的路径优先，其次是已知的 workspace root，最后向上找 marker。子目录匹配到它上方最长的 root；不在任何项目里的 session 就只有 user Memory。

路径会移动。`/memory project relink <old> <new>` 让同一个 project id 指向新目录，并把旧路径留作 alias，因此 Memory 能挺过这次移动。

### Trajectory rows

打开 `sessionEvents` 后，Web UI 的轨迹账本会展示本插件做了什么，一条事件一行：

| 记录 | 这一行写什么 | 强调色 |
|---|---|---|
| `plugin:dsh-reflection/consolidation` | 本次运行的状态与触发方式、覆盖的 seq 区间，以及写了什么 —— 新增/更新/取代/无操作四个计数，有值时再补上拒绝、跳过、失败。gap 只说这段区间没有任何进程观测到，不带计数 | `success` 绿、`partial` 琥珀、`no-human-turn` 灰、`gap` 红 |
| `plugin:dsh-reflection/project` | 项目根、由哪种查找决定（已登记路径 / workspace / 根标记），以及 project id 与 workspace id | 无 —— 归属是事实，不是结果 |

上表是本构建写入的名字；迁移前写下的 Session 保留旧的 `dsh-reflection/…` 名字，同一批行也照样折叠它们。两类记录都只是日志：`appendPluginRecord` 用 envelope 的 `ignorable` 标记写它们，因此永远不会进入模型请求，不认识该名字的构建会跳过它们而不是拒绝该 Session。每一行都是一条 `extension` 记录 —— 本插件自己的摘要、强调色与原始负载 —— 所以轨迹侧渲染它时不需要认识本插件的任何一个字段名，共享的详情面板里能看到写入时的审计原文。这里没有任何东西走 HTTP：这些行读的是 Session 自己的日志。

浏览器半由 `package.json` 的 `dsh.client` 声明，所以 bundle patch 里只有宿主半一行，UI 那半不需要第二行。

## 实现要点

这些性质决定了代码的形状：

- **写者串行化。** 每次 mutation 都经过进程内链与独占锁文件，重新读取 canonical，并针对读到的那一版做校验 —— 因此共用同一个 harness home 的桌面会话与 headless 运行不会互相丢失写入。崩溃进程留下的锁，只有在其记录的 pid 确实不存在（`ESRCH`）时才会被回收；`EPERM` 说明进程活着，锁保留。回收动作本身也被串行化：两个进程同时判定同一个锁过期时，慢的那个否则会删掉快的那个刚建立的锁。
- **读进来的东西要校验。** `memories.json` 与 `registry.json` 在写入前和读入时都会校验 —— id、时间戳、唯一性，以及每一条 supersession 引用。手改过的文档会直接报错，而不是流进 index、view 或模型请求；project id 在变成目录名之前也要先通过检查。canonical store 读不出来时会**中断本轮请求并指名出问题的文件**：降级成空索引等于把"store 坏了"呈现为"agent 单纯忘了"，后者更难诊断。文件不存在不算损坏 —— 那正是首次使用时的形态。
- **摘要缓存，不在请求路径上重算。** 注入发生在每个模型 step 之前，所以它只读 `summary.json`；写它的模型调用发生在写入时或下一次读取的背后，永远不在请求路径上。描述旧 revision 的缓存仍会被使用 —— 稍微过时的摘要胜过没有摘要 —— 同时后台刷新会追上。
- **索引是提交点。** mutation 先写正文、再写索引；只有索引写成功才算提交。索引里没有的正文文件会在下一次写入时删掉。正文是它自己那份文本的唯一副本，所以正文缺失会直接中断读取，并指名记录与路径。
- **title 先读，正文后读。** 每条记录在索引里带一行 title，读的人先扫 title 再决定是否打开正文。手写的 title 不设长度上限；字段出现之前的旧记录在读取时派生一个 title。
- **Provenance 是构造出来的，不是接受的。** 模型只给出事实；插件自己附上 Session、本轮的人类消息及其序号。无法确定时留空，而不是猜一个。
- **自动学习自己记账，也会补读错过的区间。** collector 记住的是本进程**看见过**的事件，因此进度标记的含义是"已消费到这个 seq"，而不是指向存储的光标。当区间缺失时 —— 晚挂载、在别处 resume、缓冲被淘汰 —— 插件先向 harness 的 `sessionQuery` 服务要这段历史并折进本批；只有**读不完整**的区间才会写成一次 **gap**。正是这个区分，让"从未观测到"不会被悄悄报告成"看了但没有内容"。

## Model Experience

- **上下文成本：** 每个 Session 一段至多 `summaryBudgetBytes`（默认 1.2 KB）的摘要，含计数、文件路径与指向单条文件的提示。在 agent 读文件或调用工具之前，没有任何记录正文进入上下文。
- **缓存稳定：** 摘要作为 runtime context 位于 retained history 之后，因此不会重写稳定的 system prompt 前缀；只有 Memory 变化时它的文本才变。
- **可发现性：** 策略段要求 agent 在开工前主动读 Memory，并写明文件与工具的位置。

## Known Limitations and Deferred Work

- **读不到的区间仍然是 gap。** 在别处 resume 的 Session、插件挂载时已经在跑的 Session，以及被缓冲上限淘汰的事件，如果 harness 的 `sessionQuery` 也读不到（服务未挂载、区间被清理、读取失败），就只能记为 gap 并跳过；那几轮不会被学习。
- **摘要比 consolidation 的写入晚一拍。** 显式写入会等待刷新，所以下一个请求已经能描述它；自动 consolidation 学到的事实要等下一次请求发现 store 变了才进入摘要。
- **摘要是模型写的。** 它可能漏掉内容，或用记录里没有的说法。记录才是权威：需要原文时打开 `memories/<id>.md` 或调用 `memory_get`。
- **自动学习需要长驻实例。** 它的 debounce 按设计等在 agent 的 maintenance 之外，所以一次性 `headless` 运行会在定时器到期前就退出并 dispose。这是**已接受的范围**而不是缺陷：一次性运行请用 `/memory consolidate`，桌面应用里定时器才会真的触发。
- **关闭 Memory 同时停止自动学习，并等待它收束。** `/memory disable` 返回后不会再发生新采集、模型调用、写入或 mark 推进，已在进行的运行也已结束。关闭期间产生的事件之后不会被补采。
- **进度文件随 Session 数量增长。** 每个产生过事件的 Session 会永久保留一条小记录，因为唯一站得住的清理方式是按年龄，而本版本没有这个策略。按每 Session 几百字节估算，几千个 Session 后大约 1 MB。
- **没有语义去重与冲突检测。** 唯一识别的重叠是精确重复，且比较时不做大小写折叠，因为 `Model-X` 与 `model-x` 可以是不同的东西。`pnpm` 是否与 `npm` 矛盾由模型判断，通过带 `target_id` 的 `supersede` 表达。
- **只有关键词检索。** 整串命中、拉丁词重叠、CJK 字符 bigram，以 `updated_at` 兜底。用英文查询找不到意思相同的中文事实。
- **forget 不是崩溃事务。** 保证是"成功返回后 `$DSH_HOME/memory` 下不再有该正文"；删除与 tombstone 之间被中断不做恢复。journal 等真有需要再加。
- **secret 保证只覆盖本插件自己的数据。** 凭据永远不会写进 Memory、其视图、tombstone 或日志。被引用的那一轮含凭据时，只要事实本身干净仍会写入：evidence quote 先脱敏成 `[redacted]` 再截断，而不是整轮拒绝——一句粘贴的密钥不会再拖累同一轮的其它事实。用户原始消息与 harness 自己记录的 `tool/call` 参数属于 Session log，append-only 的历史不会被改写。
- **共享盘上的残留锁需要人工清理。** 另一台机器的进程无法探测，因此那里的废弃锁只会被报告，不会被抢。
- **残留的 reclaim 互斥同样需要人工清理。** `<store>.lock.reclaim` 只在移除陈旧锁的瞬间被持有，而且**故意不做自动回收**：自动回收它等于把它要防的那种竞态往下复制一层。进程恰好死在这个窗口里就会留下该文件，下一个写者会等在超时后报错并指名路径 —— 手动删掉它就是全部补救措施。

## 测试

```sh
npm run test:unit        # 除集成套件外的全部 test/*.spec.mjs，无网络、无 API key
npm run test:unit -- summary  # 只跑名字含 summary 的那一个
npm run test             # test:unit，然后浏览器半的 smoke test
npm run test:integration # 通过真实 Loader 启动 shipped headless profile
npm run test:all         # test，然后 integration
```

`test/run-unit-specs.mjs` 自动发现套件而不是在 `package.json` 里逐个列举，所以新增一个 `*.spec.mjs` 不需要改配置。唯一排除的是 `integration.spec.mjs`，因为它要启动真实 profile 并依赖 harness 检出。每个套件跑在独立进程里、一次一个，输出与单独运行完全一致；任何一个失败，runner 就以非零退出。

`eval/` 是独立于这些门禁的质量层：`npm run eval:retrieval` 不花 token，每次推送都跑；
`npm run eval:behavior` 会真实调用模型，只在 release tag 或手动触发时跑。见 [eval/README.md](eval/README.md)。

`test/client.smoke.mjs` 在浏览器之外加载 `client/client.js`，走的是 Client runtime 同一条注册路径。它按宿主半写事件的方式构造出两类事件并渲染出对应的行，同时对浏览器半守住两条规矩：行里的每一个词都能在中英文字典里查到，以及不请求任何 Harness Client 包。把 `DSH_CHECKOUT` 指向一个已构建 client 库的 checkout 时，它还会把两个定义注册进真实的 Conversation registry，并把结果推过真实的轨迹投射 —— 于是轨迹侧不再接受某一行时，失败发生在这里，而不是在浏览器里。

集成套件用绝对路径直接从本 checkout 挂载插件与 scripted model adapter，因此不需要往任何 profile 里装东西。它的四个 scenario 分别在：一个 Session 写入、下一个 Session 读到；一个项目看不到另一个项目的 Memory；user Memory 跨项目可见；以及通过显式 supersede 让一条记录退役。

### 开发回路

源码是 TypeScript，而 profile 加载的是编译后的 JavaScript —— 所以**改完要先 build，重启才看得到**：

```sh
npm run build        # tsdown bundles the runtime into lib/index.mjs
npm run declarations # tsc emits the .d.ts files beside it
npm run typecheck    # 检查 host 与 browser 两个编译面
npm run test:unit    # runs the suites, through tsx, with no build
```

`tsc` 做不到"既产出又忽略类型错误"，所以运行时交给转译器、`tsc` 只管类型 —— harness 自己也是这么构建的。正是这个分工让源码可以**逐模块**类型化：没做完的模块会在 `typecheck` 里报错，但不会挡住构建或重启。`npm run prepare` 会在安装时构建，因此 `link:` 依赖在被加载之前就已经有 `lib/` 了。

套件直接 import TypeScript 源码、通过 tsx 运行，所以**编辑-测试回路永远不需要 build**。被 fixture 当子进程启动的模块需要同样处理：那些 `spawn` 也要带 `--import tsx/esm`。

### 手工验证自动路径

有一种行为任何脚本化运行都展示不了：debounce。它按设计等在 agent 的 maintenance 之外，而一次性运行会先退出。要观察它，需要一个长驻 profile、一条真实账号路由，以及一个除了等待什么都不做的进程：

```sh
dsh --profile <a web-based profile with dsh-reflection> --patch <overlay> --no-open
```

`test/fixtures/real-trigger-probe.ts` 就是这个进程。在它的 config 里给出任务文本与报告路径后，它会驱动一轮、等过 debounce 而不调用任何东西、关闭 Memory、再驱动第二轮，并把每一步写进报告。该看两处：

- Session 日志里有一条审计事件带 `"trigger": "idle-debounce"` 且操作非零，而整段轨迹里没有任何命令；
- 第二轮之后只有一条审计、mark 没有越过第一次运行、也没有新记录 —— 开关关闭期间产生的事件不会被采集，它们会在下一次真正观测到的运行里成为 gap。
