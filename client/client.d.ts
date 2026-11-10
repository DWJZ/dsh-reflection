/**
 * The surface the Web client hands a plugin bundle.
 *
 * The client loads a bundle by calling one global envelope with an id and a
 * factory; the factory receives a CommonJS-style `require` for the client modules
 * it names — `react` for the Settings page, and nothing else. The DOM library is
 * needed because the envelope lives on `window` and the page renders DOM.
 */

/**
 * The browser module table's React, declared structurally.
 *
 * React reaches the page from the Harness module table, not from a package this
 * plugin depends on, so nothing resolves `react` for the compiler here. These are
 * the members the Settings page calls, declared with the signatures it relies on.
 */
interface DshReact {
  /** Create one element; props and children are passed through to React. */
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: DshReactChild[]): DshReactElement
  /** Component state, with a setter that accepts a value or an updater. */
  useState<T>(initial: T): [T, (next: T | ((current: T) => T)) => void]
  /** Run an effect after render, returning its cleanup. */
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  /** Memoize one callback until its dependencies change. */
  useCallback<T>(callback: T, deps: readonly unknown[]): T
}

/** One child React accepts: an element, text, a nested array, or nothing. */
type DshReactChild = DshReactElement | string | number | boolean | null | undefined | readonly DshReactChild[]

/** One rendered element, opaque to this bundle. */
interface DshReactElement {
  /** React's reconciliation key, when one was supplied. */
  readonly key?: string | number | null
}

/** The lazy-CommonJS envelope one plugin bundle is loaded through. */
interface DshModuleLoader {
  /**
   * Register a bundle.
   * @param envelope - the bundle id, and the factory that builds its exports.
   */
  load(envelope: { id: string; factory: (require: (id: string) => unknown) => void }): void
}

interface Window {
  /** Injected by the Web client before any bundle is loaded. */
  __ModuleLoader__: DshModuleLoader
}

/** A namespace's translation function. */
type Translate = (key: string, params?: Record<string, unknown>) => string

/** The locale service a Client context exposes. */
interface DshClientLocale {
  /**
   * Bind one namespace's translations.
   * @param namespace - the dictionary namespace this bundle registered.
   * @returns the translate function for that namespace.
   */
  bind(namespace: string): Translate
  /**
   * Register dictionaries for one namespace.
   * @param namespace - the namespace name.
   * @param dictionaries - one table per language.
   * @returns the disposer that unregisters them.
   */
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
}

/** One read-only row of the Trajectory ledger, as the conversation service takes it. */
interface DshTrajectoryRow {
  /** The row kind the ledger groups by. */
  kind: string
  /** The ledger this row belongs to. */
  target: string
  /** Whether one event starts a row, and under which id. */
  match(event: { type: string; seq: number; data?: unknown }): { id: string; role: string } | null
  /** Fold one matched event into the row's state. */
  start(context: DshLedgerNode, match: DshRowMatch): unknown
  /** Fold a later event into an open row. */
  update(context: DshLedgerNode, match: DshRowMatch): unknown
  /** Build the node the ledger renders. */
  buildViewNode(context: DshLedgerNode): unknown
}

/** One entry of the Settings page's candidate list, as the Host sends it. */
interface DshReviewSource {
  project_id: string
  /** Short project name, or the id when the registry cannot name it. */
  project: string
  /** Canonical project root, shown as a tooltip. */
  project_root: string | null
  record_id: string
}

/** One pending candidate, as the Host sends it. */
interface DshReviewCandidate {
  /** 1-based position; the number an action names. */
  index: number
  title: string
  content: string
  sources: DshReviewSource[]
}

/** One candidate the digest validation dropped. */
interface DshReviewRejected {
  title: string
  reason: string
  workspaces?: number
}

/** The pending queue, as the Host sends it. */
interface DshReviewPending {
  created_at: string
  scan_from: string | null
  scan_to: string
  model?: string
  usage?: { inputTokens: number; outputTokens: number }
  candidates: DshReviewCandidate[]
  rejected: DshReviewRejected[]
}

/** What one read of the review route carries. */
interface DshReviewState {
  enabled: boolean
  lastScanAt: string | null
  pending: DshReviewPending | null
  problem?: string
}

/** The page's current read: which phase it is in, and what it knows. */
interface DshReviewSnapshot {
  phase: 'loading' | 'unavailable' | 'error' | 'ready'
  state?: DshReviewState
  message?: string
}

/** The Settings page's per-candidate action choice. */
interface DshReviewConfirm {
  action: 'apply' | 'discard'
}

/** One result banner. */
interface DshReviewNotice {
  tone: 'ok' | 'error'
  text: string
}

/** The Settings page's props: the slot binds this namespace's translate function. */
interface DshSettingsSectionProps {
  t: Translate
}

/** The slot services this bundle registers a Settings section through. */
interface DshClientSlots {
  /**
   * Register a contribution while one slot exists; the callback's registrations
   * are torn down and reinstalled with that slot.
   * @param key - the slot key.
   * @param callback - the registrations, returning their disposer.
   * @returns the disposer that withdraws the contribution.
   */
  inject(key: 'settings.section', callback: () => () => void): () => void
  /**
   * Register one occupant of a slot list.
   * @param options - the slot name and its registration options.
   * @param component - the component the slot renders.
   * @returns the disposer that unregisters the occupant.
   */
  register(
    options: {
      name: 'settings.section'
      /** The section key; a fresh id is added beside the shipped sections. */
      id: string
      /** Position among the sections. */
      order?: number
      /** Display text for the navigation row, read on every projection. */
      label?: () => string
      /** The namespace the slot binds as the component's `t`. */
      locale?: string
    },
    component: (props: DshSettingsSectionProps) => unknown,
  ): () => void
}

/** This plugin's Client context. */
interface DshClientContext {
  /**
   * Register a contribution; the runtime disposes it with the fiber.
   * @param callback - the registration, or its disposer.
   * @param label - a diagnostic label.
   */
  effect(callback: () => void | (() => void), label?: string): void
  /** The locale service. */
  locale: DshClientLocale
  /** The conversation service, where trajectory rows are registered. */
  uiConversation: {
    events: {
      /**
       * Register a row definition.
       * @param definition - what events it folds, and how it renders.
       * @returns the disposer that unregisters it.
       */
      register(definition: DshTrajectoryRow): () => void
    }
  }
  /** The slot service, where the Settings page is registered. */
  slots: DshClientSlots
}

/** The event a row matched, as the ledger hands it over. */
interface DshRowMatch {
  /** The Session event the row matched. */
  event: {
    /** Its type. */
    type: string
    /** Its sequence number. */
    seq: number
    /** Its payload, unread until the row decides what to do with it. */
    data?: unknown
    /** When it happened, when the log recorded it. */
    time?: unknown
  }
}

/** What one trajectory row is built from. */
interface TrajectoryRowOptions {
  /** The row kind, as the ledger groups it. */
  kind: string
  /** Every Session event type this row folds, the current record name first. */
  eventTypes: readonly string[]
  /** Prefix of the row id. */
  idPrefix: string
  /** Ledger emphasis for one payload. */
  toneOf(payload: Record<string, unknown>): string
  /** The one-line summary for one payload. */
  summarize(payload: Record<string, unknown>, t: Translate): string
  /** This namespace's translate function. */
  translate: Translate
}

/** The bundle's exports. The offline smoke test drives these directly. */
interface DshMemoryClientExports {
  /** Register the dictionaries, the three ledger rows, and the Settings page. */
  apply(ctx: DshClientContext): void
  /** The client services this bundle waits for. */
  inject: string[]
  /** One-line summary of a consolidation run. */
  consolidationSummary(payload: Record<string, unknown>, t: Translate): string
  /** One-line summary of a project attribution. */
  projectSummary(payload: Record<string, unknown>, t: Translate): string
  /** One-line summary of a digest run or apply. */
  digestSummary(payload: Record<string, unknown>, t: Translate): string
  /** Ledger emphasis for a consolidation status. */
  statusTone(status: unknown): string
  /** Ledger emphasis for a digest payload. */
  digestTone(payload: Record<string, unknown>): string
  /** Build the consolidation row definition. */
  createConsolidationRow(translate: Translate): DshTrajectoryRow
  /** Build the project row definition. */
  createProjectRow(translate: Translate): DshTrajectoryRow
  /** Build the digest row definition. */
  createDigestRow(translate: Translate): DshTrajectoryRow
  /** The Settings page component. */
  MemorySection(props: DshSettingsSectionProps): unknown
  /** The record name the consolidation row folds. */
  CONSOLIDATION_EVENT: string
  /** The record name the project row folds. */
  PROJECT_EVENT: string
  /** The record name the digest row folds. */
  DIGEST_EVENT: string
  /** Where the page reads the pending queue. */
  REVIEW_PATH: string
  /** Where the page posts one apply. */
  REVIEW_APPLY_PATH: string
  /** Where the page posts one discard. */
  REVIEW_DISCARD_PATH: string
}

/** What the ledger hands a row while it folds or renders one node. */
interface DshLedgerNode {
  /**
   * The state this row folded so far: what its fold produced, or undefined
   * before the first event matched.
   */
  state: { seq: number; time: number; key: string; payload: unknown } | undefined
  /** The row's key in the ledger. */
  key: string
  /** The row kind. */
  kind: string
  /** The row id. */
  id: string
  /** Where the row started, as the ledger recorded it. */
  start: { location?: unknown } | null | undefined
}
