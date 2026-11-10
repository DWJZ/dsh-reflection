/**
 * dsh-reflection — browser half (lazy-CJS client bundle).
 *
 * Two contributions live here.
 *
 * The Host writes informational Session records: one for each consolidation run
 * (`dsh-reflection/consolidation`), one for the project a Session was attributed
 * to (`dsh-reflection/project`), and one for each digest run and apply
 * (`dsh-reflection/digest`). This half folds each of them into a single
 * read-only row of the Trajectory ledger.
 *
 * It also renders the Memory Settings page. The pending digest queue belongs to
 * no Session, so that page reads it over the Host's own review routes instead of
 * the event stream, and every action re-reads the queue rather than keeping a
 * copy.
 *
 * Rows need no component and no stylesheet of their own — nothing in the
 * trajectory part of this file produces DOM. The Settings page does: its
 * stylesheet is installed once by `apply` and removed with the plugin.
 */

/// <reference path="./client.d.ts" />
window.__ModuleLoader__.load({
	id: "dsh-reflection",
	factory: (require) => {
		var module = { exports: {} };
		/** @type {Partial<DshMemoryClientExports>} */
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * The module table's React. Its declarations are not a dependency of this
		 * plugin — the page supplies the module — so the type is named at this one
		 * cast and nowhere else.
		 * @type {typeof import("react")}
		 */
		const React = /** @type {typeof import("react")} */ (require("react"));

		//#region locale
		const NS = "dshMemory";
		/** @type {Record<string, string>} */
		const zh = {
			consolidation: "记忆整理",
			statusSuccess: "成功",
			statusPartial: "部分完成",
			statusNoHumanTurn: "无人类发言",
			statusGap: "缺口",
			statusOther: "其它状态",
			triggerIdleDebounce: "空闲触发",
			triggerManualCommand: "手动命令",
			triggerDirect: "直接调用",
			triggerOther: "其它触发",
			seqRange: "seq {from}–{to}",
			gapNote: "这段区间从未被观测到",
			opCounts: "新增 {add} 更新 {update} 取代 {supersede} 无操作 {noop}",
			opRejected: "拒绝 {count}",
			opSkipped: "跳过 {count}",
			opFailed: "失败 {count}",
			project: "项目归属",
			matchedByRegistry: "按登记路径",
			matchedByWorkspace: "按 workspace",
			matchedByMarker: "按根标记",
			matchedByOther: "匹配方式未知",
			projectId: "项目 {id}",
			workspaceId: "workspace {id}",
			workspaceNone: "无 workspace",
			digest: "跨项目 digest",
			digestWindow: "窗口 {from} .. {to}",
			digestAllTime: "全部历史",
			digestCandidates: "候选 {count}",
			digestRejected: "拒绝 {count}",
			digestModel: "模型 {model}",
			digestApplied: "应用 {count}",
			digestArchived: "归档 {count}",
			digestRemaining: "剩余 {count}",
			nav: "记忆",
			heading: "跨项目记忆审查",
			intro: "每天北京时间 00:00 扫描一次各项目新写的经验，候选只有审查通过后才会写入用户级记忆。",
			loading: "读取中…",
			lastScan: "上次扫描 {time}",
			neverScanned: "还没有扫描过",
			pendingCount: "待审 {count} 条",
			model: "模型 {model}",
			usage: "用量 输入 {input} · 输出 {output}",
			createdAt: "生成于 {time}",
			sources: "来源",
			sourceCount: "{count} 条来源记录",
			expand: "展开",
			collapse: "收起",
			applySelected: "应用选中（{count}）",
			discardSelected: "忽略选中（{count}）",
			refresh: "刷新",
			confirm: "确认",
			cancel: "取消",
			confirmApplyTitle: "确认应用",
			confirmApplyBody: "将写入 {count} 条用户级记忆，并归档 {records} 条项目级来源记录；归档后这些来源不再参与注入。",
			confirmDiscardTitle: "确认忽略",
			confirmDiscardBody: "将从待审队列移除 {count} 条候选，并留档到 digest/discarded/。",
			resultApplied: "已应用 {applied} 条，归档 {archived} 条（{skipped} 条已失效），剩余 {remaining} 条。",
			resultDiscarded: "已忽略 {discarded} 条，剩余 {remaining} 条。",
			noAudit: "没有可用的 Session，本次操作没有写入审计记录。",
			stale: "待审队列已经变化，已重新读取，请重新选择。",
			disabled: "记忆已关闭，审查和写入都不可用。",
			disabledHint: "运行 /memory enable 重新打开后即可审查。",
			unavailable: "当前环境没有提供记忆审查接口。",
			unavailableHint: "待审队列只能在 Web 界面的设置页里审查；也可以在对话里运行 /memory digest --apply [1,3,...]。",
			empty: "暂无待审候选。",
			emptyHint: "运行 /memory digest 可以立即扫描一次。",
			problem: "待审文件无法读取：{reason}",
			rejected: "被拒绝的候选（{count}）",
			rejectedWorkspaces: "（{count} 个 workspace）",
			readFailed: "读取失败：{message}",
			actionFailed: "操作失败：{message}",
		};
		/** @type {Record<string, string>} */
		const en = {
			consolidation: "Memory consolidation",
			statusSuccess: "success",
			statusPartial: "partial",
			statusNoHumanTurn: "no human turn",
			statusGap: "gap",
			statusOther: "other status",
			triggerIdleDebounce: "idle debounce",
			triggerManualCommand: "manual command",
			triggerDirect: "direct",
			triggerOther: "other trigger",
			seqRange: "seq {from}–{to}",
			gapNote: "this range was never observed",
			opCounts: "added {add}, updated {update}, superseded {supersede}, no-op {noop}",
			opRejected: "rejected {count}",
			opSkipped: "skipped {count}",
			opFailed: "failed {count}",
			project: "Project attribution",
			matchedByRegistry: "by registry path",
			matchedByWorkspace: "by workspace",
			matchedByMarker: "by root marker",
			matchedByOther: "unknown lookup",
			projectId: "project {id}",
			workspaceId: "workspace {id}",
			workspaceNone: "no workspace",
			digest: "Cross-project digest",
			digestWindow: "window {from} .. {to}",
			digestAllTime: "all history",
			digestCandidates: "candidates {count}",
			digestRejected: "rejected {count}",
			digestModel: "model {model}",
			digestApplied: "applied {count}",
			digestArchived: "archived {count}",
			digestRemaining: "remaining {count}",
			nav: "Memory",
			heading: "Cross-project memory review",
			intro: "A scan runs every day at 00:00 Beijing time over experience newly written in each project. A candidate becomes user-scope Memory only after it is reviewed here.",
			loading: "Loading…",
			lastScan: "Last scan {time}",
			neverScanned: "No scan has run yet",
			pendingCount: "{count} pending",
			model: "Model {model}",
			usage: "Usage {input} in · {output} out",
			createdAt: "Created {time}",
			sources: "Sources",
			sourceCount: "{count} source records",
			expand: "Show more",
			collapse: "Show less",
			applySelected: "Apply selected ({count})",
			discardSelected: "Discard selected ({count})",
			refresh: "Refresh",
			confirm: "Confirm",
			cancel: "Cancel",
			confirmApplyTitle: "Confirm apply",
			confirmApplyBody: "Writes the selection ({count}) as user-scope Memory and archives {records} project-scope source records; archived sources stop being injected.",
			confirmDiscardTitle: "Confirm discard",
			confirmDiscardBody: "Removes the selection ({count}) from the queue and keeps it under digest/discarded/.",
			resultApplied: "Applied {applied}, archived {archived} ({skipped} already out of service), {remaining} still pending.",
			resultDiscarded: "Discarded {discarded}, {remaining} still pending.",
			noAudit: "No Session was available, so this action wrote no audit record.",
			stale: "The pending queue changed; it was re-read. Choose again.",
			disabled: "Memory is off, so neither review nor writes are available.",
			disabledHint: "Run /memory enable to turn it back on.",
			unavailable: "This environment does not provide the memory review route.",
			unavailableHint: "The pending queue is reviewed in the Web Settings page; in a conversation, /memory digest --apply [1,3,...] still works.",
			empty: "Nothing is pending right now.",
			emptyHint: "Run /memory digest to scan now.",
			problem: "The pending file cannot be read: {reason}",
			rejected: "Rejected candidates ({count})",
			rejectedWorkspaces: " ({count} workspaces)",
			readFailed: "Could not read the queue: {message}",
			actionFailed: "The action failed: {message}",
		};
		//#endregion

		//#region vocabulary
		/**
		 * The record name this half renders now, and the event type Sessions wrote
		 * before the migration to the harness's `plugin:` namespace. A Session keeps
		 * whichever name it was written under, so both fold into the same row.
		 */
		const CONSOLIDATION_EVENT = "plugin:dsh-reflection/consolidation";
		const CONSOLIDATION_EVENT_LEGACY = "dsh-reflection/consolidation";
		const PROJECT_EVENT = "plugin:dsh-reflection/project";
		const PROJECT_EVENT_LEGACY = "dsh-reflection/project";
		const DIGEST_EVENT = "plugin:dsh-reflection/digest";
		/** The one status that carries no operation counters. */
		const GAP_STATUS = "gap";
		/**
		 * Row symbols. The symbol says which trace this is — consolidation, project
		 * attribution, or a digest run/apply — while the ledger tone carries the
		 * outcome, so the two never encode the same thing twice.
		 */
		const SYMBOL_CONSOLIDATION = "\u{1F9E0}";
		const SYMBOL_PROJECT = "\u{1F4C1}";
		const SYMBOL_DIGEST = "\u{1F9E9}";
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const STATUS_KEYS = {
			success: "statusSuccess",
			partial: "statusPartial",
			"no-human-turn": "statusNoHumanTurn"
		};
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const STATUS_TONES = {
			success: "positive",
			partial: "warning",
			"no-human-turn": "neutral",
			gap: "critical"
		};
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const TRIGGER_KEYS = {
			"idle-debounce": "triggerIdleDebounce",
			"manual-command": "triggerManualCommand",
			direct: "triggerDirect"
		};
		/**
		 * Keyed by the host's own vocabulary; the host may write a value this
		 * build does not know, which is why lookups are by plain string.
		 * @type {Record<string, string>}
		 */
		const MATCHED_BY_KEYS = {
			registry: "matchedByRegistry",
			workspace: "matchedByWorkspace",
			marker: "matchedByMarker"
		};
		//#endregion

		//#region styles
		const CSS_ID = "dsh-reflection/styles.css";
		const CSS = [
			".dshm_root{display:flex;flex-direction:column;gap:16px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;max-width:760px}",
			".dshm_title{font-weight:600;font-size:14px}",
			".dshm_desc{color:var(--dsw-alias-label-secondary)}",
			".dshm_status{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}",
			".dshm_banner{padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary)}",
			".dshm_banner_warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 45%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706)}",
			".dshm_list{display:flex;flex-direction:column;gap:10px}",
			".dshm_card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.22));border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}",
			".dshm_card_on{border-color:var(--dsw-alias-brand-primary,#3b82f6)}",
			".dshm_head{display:flex;align-items:flex-start;gap:8px}",
			".dshm_head_label{display:flex;align-items:baseline;gap:8px;cursor:pointer;color:inherit}",
			".dshm_check{margin-top:3px}",
			".dshm_index{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".dshm_card_title{font-weight:600}",
			".dshm_content{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
			".dshm_content_open{display:block;-webkit-line-clamp:unset;overflow:visible}",
			".dshm_more{align-self:flex-start;background:none;border:0;padding:0;color:var(--dsw-alias-brand-primary,#3b82f6);cursor:pointer;font-size:12px}",
			".dshm_sources{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dshm_actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}",
			".dshm_actions button{font:inherit;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary);cursor:pointer}",
			".dshm_actions button:disabled{opacity:.45;cursor:default}",
			".dshm_primary{border-color:var(--dsw-alias-brand-primary,#3b82f6)!important;color:var(--dsw-alias-brand-primary,#3b82f6)!important;font-weight:600}",
			".dshm_danger{color:var(--dsw-alias-state-error-primary,#ef4444)!important}",
			".dshm_confirm{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));background:var(--dsw-alias-bg-layer-2,transparent)}",
			".dshm_notice{font-size:12px}",
			".dshm_notice_ok{color:var(--dsw-alias-state-success-primary,#16a34a)}",
			".dshm_notice_error{color:var(--dsw-alias-state-error-primary,#ef4444)}",
			".dshm_rejected summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dshm_rejected li{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dshm_empty{color:var(--dsw-alias-label-tertiary)}"
		].join("");

		/**
		 * Install the page stylesheet once, as one removable resource.
		 * @returns the disposer that removes it.
		 */
		function installStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector('style[data-plugin-css="' + CSS_ID + '"]') !== null) return () => {};
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return () => { tag.remove() };
		}
		//#endregion

		//#region summaries
		/**
		 * @param {unknown} value - the value the host wrote.
		 * @returns {string}.
		 */
		function textOf(value) {
			return typeof value === "string" && value !== "" ? value : "";
		}

		/**
		 * @param {unknown} value - the value the host wrote.
		 * @returns {number}.
		 */
		function countOf(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : 0;
		}

		/**
		 * @param {string} symbol - the row symbol.
		 * @param {string[]} parts - the rendered parts.
		 * @returns {string}.
		 */
		function join(symbol, parts) {
			return symbol + " " + parts.filter(part => part !== "").join(" \u00b7 ");
		}

		/**
		 * @param {unknown} status - the payload status.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function statusLabel(status, t) {
			const key = typeof status === "string" && STATUS_KEYS[status] !== undefined
				? STATUS_KEYS[status]
				: status === GAP_STATUS ? "statusGap" : "statusOther";
			return t(key);
		}

		/**
		 * @param {unknown} status - the payload status.
		 * @returns {string}.
		 */
		function statusTone(status) {
			return typeof status === "string" && STATUS_TONES[status] !== undefined
				? STATUS_TONES[status]
				: "neutral";
		}

		/**
		 * @param {unknown} trigger - the payload trigger.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function triggerLabel(trigger, t) {
			return t(typeof trigger === "string" && TRIGGER_KEYS[trigger] !== undefined
				? TRIGGER_KEYS[trigger]
				: "triggerOther");
		}

		/**
		 * @param {Record<string, unknown>} payload - the host payload.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string | null} - null when the payload carries no range.
		 */
		function seqRangeLabel(payload, t) {
			if (typeof payload.from_seq !== "number" || typeof payload.to_seq !== "number") return null;
			return t("seqRange", { from: String(payload.from_seq), to: String(payload.to_seq) });
		}

		/**
		 * @param {unknown} operations - the plan operations.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function operationCountsLabel(operations, t) {
			const counts = /** @type {Record<string, unknown>} */ (operations !== null && typeof operations === "object" ? operations : {});
			return t("opCounts", {
				add: String(countOf(counts.add)),
				update: String(countOf(counts.update)),
				supersede: String(countOf(counts.supersede)),
				noop: String(countOf(counts.noop))
			});
		}

		/**
		 * @param {Record<string, unknown>} payload - the consolidation payload.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string[]} - one label per non-zero counter.
		 */
		function extraCountLabels(payload, t) {
			const operations = /** @type {Record<string, unknown>} */ (payload.operations !== null && typeof payload.operations === "object"
				? payload.operations
				: {});
			const labels = [];
			const rejected = countOf(payload.rejected);
			if (rejected > 0) labels.push(t("opRejected", { count: String(rejected) }));
			const skipped = countOf(operations.skipped);
			if (skipped > 0) labels.push(t("opSkipped", { count: String(skipped) }));
			const failed = countOf(operations.failed);
			if (failed > 0) labels.push(t("opFailed", { count: String(failed) }));
			return labels;
		}

		/**
		 * One consolidation run or gap as a single ledger line.
		 * @param {Record<string, unknown>} payload - the audit the host appended.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function consolidationSummary(payload, t) {
			const parts = [
				t("consolidation"),
				statusLabel(payload.status, t),
				triggerLabel(payload.trigger, t)
			];
			const range = seqRangeLabel(payload, t);
			if (range !== null) parts.push(range);
			if (payload.status === GAP_STATUS) {
				parts.push(t("gapNote"));
			} else {
				parts.push(operationCountsLabel(payload.operations, t));
				parts.push(...extraCountLabels(payload, t));
			}
			return join(SYMBOL_CONSOLIDATION, parts);
		}

		/**
		 * One project attribution as a single ledger line.
		 * @param {Record<string, unknown>} payload - the attribution the host appended.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function projectSummary(payload, t) {
			const parts = [t("project")];
			parts.push(textOf(payload.canonical_root));
			const matchedBy = typeof payload.matched_by === "string" ? MATCHED_BY_KEYS[payload.matched_by] : undefined;
			parts.push(t(matchedBy === undefined ? "matchedByOther" : matchedBy));
			const projectId = textOf(payload.project_id);
			if (projectId !== "") parts.push(t("projectId", { id: projectId }));
			const workspaceId = textOf(payload.workspace_id);
			parts.push(workspaceId === "" ? t("workspaceNone") : t("workspaceId", { id: workspaceId }));
			return join(SYMBOL_PROJECT, parts);
		}

		/**
		 * The date part of one ISO timestamp, for a ledger line that stays short.
		 * @param {unknown} value - the timestamp the host wrote.
		 * @returns {string} - the `YYYY-MM-DD` prefix, or the whole value when it is not one.
		 */
		function dateOf(value) {
			const text = textOf(value);
			return /^\d{4}-\d{2}-\d{2}/u.test(text) ? text.slice(0, 10) : text;
		}

		/**
		 * The scan window a digest run covers.
		 * @param {Record<string, unknown>} payload - the digest payload.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function digestWindowLabel(payload, t) {
			const to = dateOf(payload.scan_to);
			if (to === "") return "";
			const from = dateOf(payload.scan_from);
			return from === "" ? t("digestAllTime") : t("digestWindow", { from, to });
		}

		/**
		 * One digest run or apply as a single ledger line.
		 * @param {Record<string, unknown>} payload - the audit the host appended.
		 * @param {Translate} t - this namespace's translate function.
		 * @returns {string}.
		 */
		function digestSummary(payload, t) {
			const parts = [t("digest")];
			if (payload.kind === "apply") {
				const applied = Array.isArray(payload.applied) ? payload.applied.length : 0;
				const archived = Array.isArray(payload.archived) ? payload.archived.length : 0;
				parts.push(t("digestApplied", { count: String(applied) }));
				parts.push(t("digestArchived", { count: String(archived) }));
				parts.push(t("digestRemaining", { count: String(countOf(payload.remaining)) }));
				return join(SYMBOL_DIGEST, parts);
			}
			const window = digestWindowLabel(payload, t);
			if (window !== "") parts.push(window);
			parts.push(t("digestCandidates", { count: String(countOf(payload.candidates)) }));
			const rejected = countOf(payload.rejected);
			if (rejected > 0) parts.push(t("digestRejected", { count: String(rejected) }));
			const model = textOf(payload.model);
			if (model !== "") parts.push(t("digestModel", { model }));
			return join(SYMBOL_DIGEST, parts);
		}

		/**
		 * The tint a digest row asks for: an apply that wrote something is the only
		 * outcome here, and a run stays a fact.
		 * @param {Record<string, unknown>} payload - the digest payload.
		 * @returns {string} - one tone from the closed set the ledger owns.
		 */
		function digestTone(payload) {
			if (payload.kind !== "apply") return "neutral";
			const applied = Array.isArray(payload.applied) ? payload.applied.length : 0;
			return applied > 0 ? "positive" : "warning";
		}
		//#endregion

		//#region trajectory
		/**
		 * Build the Trajectory definition for one plugin record.
		 *
		 * The row type comes from ui-trajectory (`extension`), which is what keeps
		 * this target free of any plugin's vocabulary: the definition supplies the
		 * summary, the emphasis and the payload, and the shared details panel shows
		 * the payload. Definitions are keyed by kind across every target, so each
		 * row carries its own kind.
		 * @param {TrajectoryRowOptions} options - what the row folds, and how it renders.
		 * @returns {DshTrajectoryRow}.
		 */
		function createTrajectoryRow(options) {
			const { kind, eventTypes, idPrefix, toneOf, summarize, translate } = options;
			/**
			 * @param {DshRowMatch} match - the matched event.
			 * @returns {{ seq: number, time: number, key: string, payload: unknown }} - the row state.
			 */
			const fold = (match) => ({
				seq: match.event.seq,
				time: typeof match.event.time === "number" ? match.event.time : 0,
				key: String(match.event.type),
				payload: match.event.data
			});
			return {
				kind,
				target: "trajectory",
				match: (event) => (eventTypes.includes(event.type)
					? { id: idPrefix + ":" + String(event.seq), role: "start" }
					: null),
				start: (_context, match) => fold(match),
				update: (context, match) => (eventTypes.includes(match.event.type) ? fold(match) : context.state),
				buildViewNode: (context) => {
					/** @type {{ seq: number, time: number, key: string, payload: unknown } | undefined} */
					const current = context.state;
					if (current === undefined) return null;
					return {
						key: context.key,
						kind: context.kind,
						id: context.id,
						target: "trajectory",
						anchorSeq: current.seq,
						location: context.start != null && context.start.location !== undefined
							? context.start.location
							: { kind: "unresolved" },
						data: {
							kind: "node",
							node: {
								kind: "extension",
								seq: current.seq,
								time: current.time,
								key: current.key,
								// The row folds only this plugin's own records, whose payload the host
								// writes as an object.
								text: summarize(/** @type {Record<string, unknown>} */ (current.payload), translate),
								value: current.payload,
								tone: toneOf(/** @type {Record<string, unknown>} */ (current.payload))
							}
						}
					};
				}
			};
		}

		/**
		 * The consolidation row.
		 * @param {Translate} translate - this namespace's translate function.
		 * @returns {DshTrajectoryRow}.
		 */
		function createConsolidationRow(translate) {
			return createTrajectoryRow({
				kind: "trajectory-memory-consolidation",
				eventTypes: [CONSOLIDATION_EVENT, CONSOLIDATION_EVENT_LEGACY],
				idPrefix: "memory-consolidation",
				toneOf: payload => statusTone(payload.status),
				summarize: consolidationSummary,
				translate
			});
		}

		/**
		 * The project-attribution row.
		 * @param {Translate} translate - this namespace's translate function.
		 * @returns {DshTrajectoryRow}.
		 */
		function createProjectRow(translate) {
			return createTrajectoryRow({
				kind: "trajectory-memory-project",
				eventTypes: [PROJECT_EVENT, PROJECT_EVENT_LEGACY],
				idPrefix: "memory-project",
				// An attribution is a fact, not an outcome: it asks for no emphasis,
				// and its symbol is what makes it findable in the ledger.
				toneOf: () => "neutral",
				summarize: projectSummary,
				translate
			});
		}

		/**
		 * The digest row: one line for each scan and each apply.
		 * @param {Translate} translate - this namespace's translate function.
		 * @returns {DshTrajectoryRow}.
		 */
		function createDigestRow(translate) {
			return createTrajectoryRow({
				kind: "trajectory-memory-digest",
				eventTypes: [DIGEST_EVENT],
				idPrefix: "memory-digest",
				toneOf: digestTone,
				summarize: digestSummary,
				translate
			});
		}
		//#endregion

		//#region review page
		/** Where the page reads the queue; mirrors `src/web.ts`. */
		const REVIEW_PATH = "/dsh-reflection/digest";
		const REVIEW_APPLY_PATH = "/dsh-reflection/digest/apply";
		const REVIEW_DISCARD_PATH = "/dsh-reflection/digest/discard";

		/**
		 * Read one JSON response from the Host.
		 * @param {string} path - same-origin absolute path.
		 * @param {RequestInit} [init] - method and body.
		 * @returns {Promise<Record<string, unknown>>} - the parsed payload.
		 */
		async function requestJson(path, init) {
			const response = await fetch(path, {
				credentials: "same-origin",
				headers: {
					accept: "application/json",
					...(init !== undefined && init.body !== undefined ? { "content-type": "application/json" } : {})
				},
				...(init !== undefined ? init : {})
			});
			/** @type {unknown} */
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			const body = payload !== null && typeof payload === "object" ? /** @type {Record<string, unknown>} */ (payload) : undefined;
			if (response.ok && body !== undefined) return body;
			const message = body !== undefined && typeof body.message === "string" ? body.message : "HTTP " + String(response.status);
			const failure = /** @type {Error & { status?: number, code?: string }} */ (new Error(message));
			failure.status = response.status;
			failure.code = body !== undefined && typeof body.code === "string" ? body.code : undefined;
			throw failure;
		}

		/**
		 * Validate one review state as the Host sends it.
		 *
		 * The page trusts the Host inside this plugin but not the wire: a route that
		 * answers something else must produce a visible failure rather than a blank
		 * page.
		 * @param {Record<string, unknown>} payload - the parsed response.
		 * @returns {DshReviewState} - the state, once its switch and queue fields are checked.
		 */
		function reviewStateOf(payload) {
			const state = payload.state;
			if (state === null || typeof state !== "object") throw new Error("malformed review payload");
			const entry = /** @type {Record<string, unknown>} */ (state);
			if (typeof entry.enabled !== "boolean" || !("pending" in entry)) throw new Error("malformed review payload");
			const pending = entry.pending === null || entry.pending === undefined
				? null
				: /** @type {DshReviewPending} */ (entry.pending);
			if (pending !== null && !Array.isArray(pending.candidates)) throw new Error("malformed review payload");
			return {
				enabled: entry.enabled,
				lastScanAt: typeof entry.lastScanAt === "string" ? entry.lastScanAt : null,
				pending,
				...(typeof entry.problem === "string" ? { problem: entry.problem } : {})
			};
		}

		/**
		 * Describe one caught failure.
		 * @param {unknown} failure - the caught value.
		 * @returns {string} - its message.
		 */
		function messageOf(failure) {
			return failure instanceof Error ? failure.message : String(failure);
		}

		/**
		 * Format one timestamp the way the browser locale prefers.
		 * @param {unknown} value - the ISO timestamp.
		 * @returns {string} - the formatted time, or the raw value when it is not a date.
		 */
		function formatTime(value) {
			const text = textOf(value);
			if (text === "") return "";
			const parsed = new Date(text);
			return Number.isNaN(parsed.getTime()) ? text : parsed.toLocaleString();
		}

		/**
		 * The Memory Settings page.
		 *
		 * Reads the queue when it opens and when the window comes back, keeps the
		 * selection local, and posts one action at a time. Nothing is cached beyond
		 * the current render: every action response is followed by a fresh read, so
		 * a scan that ran meanwhile is reflected immediately.
		 * @param {DshSettingsSectionProps} props - the slot's props with this namespace's translate function.
		 * @returns {import("react").ReactElement} - the page element.
		 */
		function MemorySection(props) {
			const t = props.t;
			const [snapshot, setSnapshot] = React.useState(/** @type {DshReviewSnapshot} */ ({ phase: "loading" }));
			const [selection, setSelection] = React.useState(/** @type {number[]} */ ([]));
			const [expanded, setExpanded] = React.useState(/** @type {number[]} */ ([]));
			const [confirm, setConfirm] = React.useState(/** @type {DshReviewConfirm | null} */ (null));
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(/** @type {DshReviewNotice | null} */ (null));
			const [rejectedOpen, setRejectedOpen] = React.useState(false);

			/**
			 * Publish one read of the queue, dropping selections that no longer exist.
			 * @param {DshReviewState} state - the state the Host returned.
			 */
			const publish = React.useCallback((/** @type {DshReviewState} */ state) => {
				setSnapshot({ phase: "ready", state });
				const pending = state.pending;
				const available = new Set((pending !== null && pending !== undefined && Array.isArray(pending.candidates) ? pending.candidates : []).map(candidate => candidate.index));
				setSelection(current => current.filter(index => available.has(index)));
			}, []);

			/**
			 * Read the queue again.
			 * @param {boolean} [quiet] - keep the current page when the read fails.
			 * @returns {Promise<DshReviewState | undefined>} - the state, when the read succeeded.
			 */
			const reload = React.useCallback(async (quiet = false) => {
				try {
					const payload = await requestJson(REVIEW_PATH, { method: "GET" });
					const state = reviewStateOf(payload);
					publish(state);
					return state;
				} catch (failure) {
					if (quiet !== true) {
						const status = /** @type {{ status?: number }} */ (failure).status;
						setSnapshot({ phase: status === 404 ? "unavailable" : "error", message: messageOf(failure) });
					}
					return undefined;
				}
			}, [publish]);

			React.useEffect(() => {
				void reload();
				if (typeof window === "undefined" || typeof document === "undefined") return undefined;
				const refreshOnReturn = () => {
					if (document.visibilityState !== "hidden") void reload(true);
				};
				window.addEventListener("focus", refreshOnReturn);
				document.addEventListener("visibilitychange", refreshOnReturn);
				return () => {
					window.removeEventListener("focus", refreshOnReturn);
					document.removeEventListener("visibilitychange", refreshOnReturn);
				};
			}, [reload]);

			/** The last queue this page read; the fallback keeps the branches below free of null checks. */
			const state = snapshot.phase === "ready" && snapshot.state !== undefined
				? snapshot.state
				: { enabled: false, lastScanAt: null, pending: null };
			const pending = state.pending;
			const candidates = pending !== null && Array.isArray(pending.candidates) ? pending.candidates : [];
			const rejected = pending !== null && Array.isArray(pending.rejected) ? pending.rejected : [];
			const enabled = state.enabled === true;
			const chosen = candidates.filter(candidate => selection.includes(candidate.index));
			const locked = busy || !enabled;

			/**
			 * Count the distinct project records a selection would archive.
			 * @param {Array<{ sources: Array<{ project_id: string, record_id: string }> }>} list - the chosen candidates.
			 * @returns {number} - how many source records they name.
			 */
			const sourceCount = (/** @type {DshReviewCandidate[]} */ list) => {
				const ids = new Set();
				for (const candidate of list) {
					for (const source of candidate.sources) ids.add(source.project_id + "/" + source.record_id);
				}
				return ids.size;
			};

			/**
			 * Toggle one candidate's checkbox.
			 * @param {number} index - the candidate number.
			 */
			const toggle = (/** @type {number} */ index) => {
				setSelection(current => (current.includes(index)
					? current.filter(item => item !== index)
					: [...current, index].sort((left, right) => left - right)));
			};

			/**
			 * Toggle one candidate's full text.
			 * @param {number} index - the candidate number.
			 */
			const toggleExpanded = (/** @type {number} */ index) => {
				setExpanded(current => (current.includes(index)
					? current.filter(item => item !== index)
					: [...current, index]));
			};

			/**
			 * Post one action for the chosen candidates.
			 * @param {'apply' | 'discard'} action - which action to run.
			 * @param {Array<{ index: number }>} list - the chosen candidates.
			 * @returns {Promise<void>} - fulfillment once the page reflects the result.
			 */
			const run = async (/** @type {'apply' | 'discard'} */ action, /** @type {DshReviewCandidate[]} */ list) => {
				setBusy(true);
				setNotice(null);
				try {
					const target = action === "apply" ? REVIEW_APPLY_PATH : REVIEW_DISCARD_PATH;
					const payload = await requestJson(target, {
						method: "POST",
						body: JSON.stringify({ selection: list.map(candidate => candidate.index), expectedScanTo: pending === null ? undefined : pending.scan_to })
					});
					const remaining = countOf(payload.remaining);
					const text = action === "apply"
						? t("resultApplied", {
							applied: String(countOf(payload.applied)),
							archived: String(countOf(payload.archived)),
							skipped: String(countOf(payload.skipped)),
							remaining: String(remaining)
						})
						: t("resultDiscarded", { discarded: String(countOf(payload.discarded)), remaining: String(remaining) });
					setConfirm(null);
					setBusy(false);
					// The queue renumbers what is left, so the old selection would
					// point at different candidates on the next render.
					setSelection([]);
					await reload(true);
					setNotice({ tone: "ok", text: action === "apply" && payload.audited === false ? text + " " + t("noAudit") : text });
					return;
				} catch (failure) {
					const refusal = /** @type {Error & { status?: number, code?: string }} */ (failure);
					setConfirm(null);
					if (refusal.status === 409 && refusal.code === "stale") {
						setNotice({ tone: "error", text: t("stale") });
						await reload(true);
					} else if (refusal.status === 409 && (refusal.code === "disabled" || refusal.code === "no-pending")) {
						setNotice({ tone: "error", text: refusal.code === "disabled" ? t("disabled") : t("stale") });
						await reload(true);
					} else if (refusal.status === 404) {
						setSnapshot({ phase: "unavailable" });
					} else {
						setNotice({ tone: "error", text: t("actionFailed", { message: messageOf(failure) }) });
					}
				} finally {
					setBusy(false);
				}
			};

			/** @type {import("react").ReactNode[]} */
			const children = [
				React.createElement("div", { className: "dshm_title", key: "title" }, t("heading")),
				React.createElement("div", { className: "dshm_desc", key: "intro" }, t("intro"))
			];

			if (snapshot.phase === "loading") {
				children.push(React.createElement("div", { className: "dshm_empty", key: "loading" }, t("loading")));
			} else if (snapshot.phase === "unavailable") {
				children.push(React.createElement("div", { className: "dshm_banner dshm_banner_warn", key: "unavailable" }, t("unavailable")));
				children.push(React.createElement("div", { className: "dshm_empty", key: "unavailable-hint" }, t("unavailableHint")));
			} else if (snapshot.phase === "error") {
				children.push(React.createElement("div", { className: "dshm_banner dshm_banner_warn", key: "error" }, t("readFailed", { message: snapshot.message })));
				children.push(React.createElement("div", { className: "dshm_actions", key: "error-actions" },
					React.createElement("button", { type: "button", onClick: () => void reload() }, t("refresh"))));
			} else {
				/** @type {string[]} */
				const statusParts = [state.lastScanAt === null || state.lastScanAt === undefined ? t("neverScanned") : t("lastScan", { time: formatTime(state.lastScanAt) })];
				if (pending !== null) statusParts.push(t("pendingCount", { count: String(candidates.length) }));
				if (pending !== null && textOf(pending.model) !== "") statusParts.push(t("model", { model: textOf(pending.model) }));
				children.push(React.createElement("div", { className: "dshm_status", key: "status" },
					statusParts.map((part, index) => React.createElement("span", { key: index }, part))));

				if (!enabled) {
					children.push(React.createElement("div", { className: "dshm_banner dshm_banner_warn", key: "disabled" }, t("disabled") + " " + t("disabledHint")));
				}
				if (state.problem !== undefined && typeof state.problem === "string") {
					children.push(React.createElement("div", { className: "dshm_banner dshm_banner_warn", key: "problem" }, t("problem", { reason: state.problem })));
				}
				if (notice !== null) {
					children.push(React.createElement("div", { className: "dshm_notice dshm_notice_" + notice.tone, key: "notice", role: "status" }, notice.text));
				}

				if (pending === null) {
					if (state.problem === undefined) {
						children.push(React.createElement("div", { className: "dshm_empty", key: "empty" }, t("empty") + " " + t("emptyHint")));
					}
				} else {
					children.push(React.createElement("div", { className: "dshm_status", key: "window" }, [
						React.createElement("span", { key: "created" }, t("createdAt", { time: formatTime(pending.created_at) })),
						pending.usage !== undefined && pending.usage !== null
							? React.createElement("span", { key: "usage" }, t("usage", { input: String(countOf(pending.usage.inputTokens)), output: String(countOf(pending.usage.outputTokens)) }))
							: null
					]));
					// A run that proposed nothing still writes a pending file; it reads as
					// an empty queue rather than as a page with nothing to say.
					if (candidates.length === 0) {
						children.push(React.createElement("div", { className: "dshm_empty", key: "empty-scan" }, t("empty") + " " + t("emptyHint")));
					}
					children.push(React.createElement("div", { className: "dshm_list", key: "list" },
						candidates.map(candidate => {
							const open = expanded.includes(candidate.index);
							const checked = selection.includes(candidate.index);
							const sources = Array.isArray(candidate.sources) ? candidate.sources : [];
							return React.createElement("div", { className: "dshm_card" + (checked ? " dshm_card_on" : ""), key: candidate.index },
								React.createElement("div", { className: "dshm_head" },
									React.createElement("input", {
										id: "dshm-candidate-" + String(candidate.index),
										className: "dshm_check",
										type: "checkbox",
										checked,
										disabled: locked,
										onChange: () => { toggle(candidate.index) }
									}),
									React.createElement("label", { className: "dshm_head_label", htmlFor: "dshm-candidate-" + String(candidate.index) },
										React.createElement("span", { className: "dshm_index" }, String(candidate.index)),
										React.createElement("span", { className: "dshm_card_title" }, candidate.title))),
								React.createElement("div", { className: "dshm_content" + (open ? " dshm_content_open" : "") }, candidate.content),
								textOf(candidate.content).length > 140
									? React.createElement("button", { type: "button", className: "dshm_more", onClick: () => { toggleExpanded(candidate.index) } }, open ? t("collapse") : t("expand"))
									: null,
								React.createElement("div", {
									className: "dshm_sources",
									title: sources.map(source => textOf(source.project_root) || source.project_id).join("\n")
								}, t("sources") + ": " + sources.map(source => textOf(source.project) || source.project_id).join(" \u00b7 ") + " \u00b7 " + t("sourceCount", { count: String(sources.length) })));
						})));

					const body = confirm === null
						? React.createElement("div", { className: "dshm_actions", key: "actions" },
							React.createElement("button", {
								type: "button",
								className: "dshm_primary",
								disabled: locked || chosen.length === 0,
								onClick: () => { setConfirm({ action: "apply" }) }
							}, t("applySelected", { count: String(chosen.length) })),
							React.createElement("button", {
								type: "button",
								className: "dshm_danger",
								disabled: locked || chosen.length === 0,
								onClick: () => { setConfirm({ action: "discard" }) }
							}, t("discardSelected", { count: String(chosen.length) })),
							React.createElement("button", {
								type: "button",
								disabled: busy,
								onClick: () => { void reload() }
							}, t("refresh")))
						: React.createElement("div", { className: "dshm_confirm", key: "confirm" },
							React.createElement("div", { className: "dshm_title" }, confirm.action === "apply" ? t("confirmApplyTitle") : t("confirmDiscardTitle")),
							React.createElement("div", { className: "dshm_desc" }, confirm.action === "apply"
								? t("confirmApplyBody", { count: String(chosen.length), records: String(sourceCount(chosen)) })
								: t("confirmDiscardBody", { count: String(chosen.length) })),
							React.createElement("div", { className: "dshm_actions" },
								React.createElement("button", {
									type: "button",
									className: confirm.action === "apply" ? "dshm_primary" : "dshm_danger",
									disabled: busy,
									onClick: () => { void run(confirm.action, chosen) }
								}, t("confirm")),
								React.createElement("button", {
									type: "button",
									disabled: busy,
									onClick: () => { setConfirm(null) }
								}, t("cancel"))));
					children.push(body);

					if (rejected.length > 0) {
						children.push(React.createElement("details", {
							className: "dshm_rejected",
							key: "rejected",
							open: rejectedOpen,
							onToggle: (/** @type {{ currentTarget: { open: boolean } }} */ event) => { setRejectedOpen(event.currentTarget.open) }
						},
						React.createElement("summary", null, t("rejected", { count: String(rejected.length) })),
						React.createElement("ul", null, rejected.map((entry, index) => React.createElement("li", { key: index },
							textOf(entry.title) + " — " + textOf(entry.reason)
							+ (typeof entry.workspaces === "number" ? t("rejectedWorkspaces", { count: String(entry.workspaces) }) : ""))))));
					}
				}
			}

			return React.createElement("div", { className: "dshm_root" }, children);
		}
		//#endregion

		//#region plugin
		const inject = ["locale", "uiConversation", "slots"];

		/**
		 * Register the dictionaries, the three ledger rows, and the Settings page.
		 * @param {DshClientContext} ctx - this plugin's Client context.
		 */
		function apply(ctx) {
			// The binding reads the active locale at call time, so one function
			// serves every later language switch.
			const translate = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-reflection: dictionaries");
			// All three events are appends this plugin makes to the Session log, so the
			// rows are folded from the event stream: no host interface is involved.
			ctx.effect(() => ctx.uiConversation.events.register(createConsolidationRow(translate)),
				"dsh-reflection: consolidation definition");
			ctx.effect(() => ctx.uiConversation.events.register(createProjectRow(translate)),
				"dsh-reflection: project definition");
			ctx.effect(() => ctx.uiConversation.events.register(createDigestRow(translate)),
				"dsh-reflection: digest definition");
			// The Settings page owns one stylesheet and one section registration; both
			// are removed when the plugin unloads or the settings shell collapses.
			ctx.effect(() => installStyles(), "dsh-reflection: styles");
			ctx.effect(() => ctx.slots.inject("settings.section", () => {
				const dispose = ctx.slots.register({
					name: "settings.section",
					id: "dsh-reflection",
					order: 25,
					label: () => translate("nav"),
					locale: NS
				}, MemorySection);
				return () => { dispose() };
			}), "dsh-reflection: memory section");
		}

		exports.apply = apply;
		exports.inject = inject;
		// Exported for the offline smoke test.
		exports.consolidationSummary = consolidationSummary;
		exports.projectSummary = projectSummary;
		exports.digestSummary = digestSummary;
		exports.statusTone = statusTone;
		exports.digestTone = digestTone;
		exports.createConsolidationRow = createConsolidationRow;
		exports.createProjectRow = createProjectRow;
		exports.createDigestRow = createDigestRow;
		exports.MemorySection = MemorySection;
		exports.CONSOLIDATION_EVENT = CONSOLIDATION_EVENT;
		exports.PROJECT_EVENT = PROJECT_EVENT;
		exports.DIGEST_EVENT = DIGEST_EVENT;
		exports.REVIEW_PATH = REVIEW_PATH;
		exports.REVIEW_APPLY_PATH = REVIEW_APPLY_PATH;
		exports.REVIEW_DISCARD_PATH = REVIEW_DISCARD_PATH;
		//#endregion

		return module.exports;
	}
});
