/**
 * opencode-goal — an autonomous goal loop for OpenCode V2.
 *
 * Design goals (in order):
 *
 *   1. Do not fight the built-in retry mechanism.  OpenCode already retries
 *      transient provider failures with exponential backoff.  This plugin only
 *      vetoes retries that cannot possibly succeed because the account is out
 *      of quota/balance (402, `provider.quota`, insufficient_quota, ...).
 *   2. If every built-in attempt still fails, retry once more with a plugin
 *      level exponential backoff.  The retry is a *single short line*; the
 *      original prompt/goal is already in the transcript and is never re-sent.
 *   3. Only start a new goal round after a clean `session.execution.succeeded`.
 *      A failed/interrupted execution never advances the goal loop.
 *   4. Keep prompt injection tiny: no system prompt, no tool registration, one
 *      short line per continuation / plugin retry.
 *   5. Bound everything (rounds, attempts, wall clock, context, memory) so a
 *      dead provider or a stubborn model cannot loop forever or grow the
 *      process without limit.
 *
 * No runtime imports: the plugin is self-contained so it loads even when the
 * plugin directory has no node_modules.  The local types below mirror the
 * OpenCode 2.1.x plugin API surface this plugin uses.
 */

/* -------------------------------------------------------------------------- */
/* Minimal API types (V2.1.x)                                                 */
/* -------------------------------------------------------------------------- */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

interface ModelInfo {
  id: string
  modelID?: string
  providerID: string
  limit?: { context?: number; output?: number }
}

interface SessionInfo {
  id: string
  cost?: number
  model?: ModelRef
  location?: { directory?: string }
}

interface PromptInput {
  sessionID: string
  id?: string
  text: string
  files?: readonly unknown[]
  agents?: readonly unknown[]
  skills?: readonly unknown[]
  metadata?: Record<string, Json>
  delivery?: "steer" | "queue"
  resume?: boolean
}

interface SyntheticInput {
  sessionID: string
  text: string
  description?: string
  metadata?: Record<string, Json>
  delivery?: "steer" | "queue"
  resume?: boolean
}

interface StructuredError {
  type: string
  message: string
  status?: number
  response?: { body: string }
  retryAfterMs?: number
}

interface RetryEvent {
  sessionID: string
  agent: string
  model: ModelRef
  error: StructuredError
  attempt: number
  decision: { retry: false } | { retry: true; delay: number }
}

interface CommandInvocation {
  sessionID: string
  prompt: { text: string }
}

interface Registration {
  dispose(): Promise<void>
}

interface CommandDefinition {
  name: string
  description?: string
  execute(input: CommandInvocation): Promise<void>
}

interface OpenCodeEvent {
  type: string
  data?: any
  location?: { directory?: string; workspaceID?: string }
}

interface PluginContext {
  app: { version: string }
  location: { directory: string }
  options: Record<string, unknown>
  command: {
    transform(cb: (editor: { add(definition: CommandDefinition): void }) => void): Promise<Registration>
  }
  session: {
    get(input: { sessionID: string }): Promise<SessionInfo>
    prompt(input: PromptInput): Promise<{ id: string }>
    synthetic(input: SyntheticInput): Promise<unknown>
    compact(input: { sessionID: string; delivery?: "steer" | "queue" }): Promise<unknown>
    interrupt(input: { sessionID: string; resume?: boolean }): Promise<unknown>
    hook(
      name: "retry",
      callback: (event: RetryEvent) => Promise<void> | void,
      options?: { providerID?: string },
    ): Promise<Registration>
  }
  event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<OpenCodeEvent>
  }
  storage: {
    get(key: string): Promise<Json | undefined>
    set(key: string, value: Json): Promise<void>
    remove(key: string): Promise<void>
  }
  model: {
    list(): Promise<ModelInfo[]>
  }
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const PLUGIN_ID = "goal"
const LOG = "[goal]"
const STORAGE_VERSION = 1
const MAX_TEXT_CHARS = 64 * 1024
const MAX_TEXT_MESSAGES = 4
const MAX_HYDRATED_SESSIONS = 2_000

/**
 * OpenCode can boot the same location more than once and therefore load this
 * plugin several times in one process.  Every instance sees the same public
 * event stream, so without an owner every instance would try to continue the
 * same goal (and the losers would "restore" the winner's active goal as
 * paused).  A process-wide registry elects exactly one live owner per session.
 *
 * The registry is intentionally in memory: it is coordination for live
 * instances, not persisted state.  If a process restarts, persisted goals are
 * restored as paused and need an explicit `/goal resume`.
 */
const OWNER_REGISTRY_KEY = Symbol.for("opencode.goal.owner-registry.v1")
const OWNER_LEASE_MS = 2 * 60_000
const OWNER_HEARTBEAT_MS = 30_000
const FOREIGN_RECHECK_MS = 30_000

interface OwnerEntry {
  instance: string
  at: number
}

interface OwnerRegistry {
  owners: Map<string, OwnerEntry>
}

const ownerRegistry: OwnerRegistry = ((globalThis as any)[OWNER_REGISTRY_KEY] ??= {
  owners: new Map<string, OwnerEntry>(),
})

const MARKER_DONE = "GOAL_DONE"
const MARKER_BLOCKED = "GOAL_BLOCKED"

/**
 * One line per automatic round.  Deliberately tiny: the objective is already
 * in the transcript and is not repeated.
 */
const CONTINUE_TEXT = "Continue. End: GOAL_DONE, or GOAL_BLOCKED: <reason>."

/**
 * One line per plugin-level retry.  It is NOT the original prompt: that message
 * is already in the transcript.  The wording also discourages repeated tools.
 */
const RETRY_TEXT = "Resume without repeating completed work. End: GOAL_DONE or GOAL_BLOCKED: <reason>."

const HELP_TEXT =
  "goal: /goal <objective> | /goal status | /goal stop | /goal resume | /goal retry | /goal clear"

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

export type ErrorKind =
  | "quota"
  | "auth"
  | "invalid"
  | "content"
  | "context"
  | "rate"
  | "server"
  | "network"
  | "aborted"
  | "unknown"

export interface ErrorClass {
  kind: ErrorKind
  /** Worth retrying at the plugin layer. */
  retryable: boolean
  /** Never retry at the provider layer either. */
  terminal: boolean
  code: string
}

/**
 * Quota / billing / subscription-exhaustion detection.
 *
 * This has to be deliberately conservative: a plain 429 ("Too Many Requests")
 * is a rate limit and is retryable, while "429 insufficient_quota" means the
 * account is out of money and must never be retried.  Keep these as phrases,
 * not a bare "limit" match.
 */
const STRONG_QUOTA_RE = new RegExp(
  [
    "insufficient[_ ]?quota",
    "insufficient[_ ]?(?:balance|credit|credits|funds)",
    "(?:credit|credits|balance|funds?)[^.]{0,40}(?:exhausted|insufficient|too low|zero|empty|depleted|used up)",
    "(?:out of|no|zero)[ _-]?(?:credits?|funds?|balance)",
    "billing",
    "payment required",
    "add (?:funds|credits)",
    "top[ _-]?up",
    "subscription[^.]{0,40}(?:limit|exceeded|expired|inactive|required)",
    "(?:monthly|annual|plan|usage)[^.]{0,30}(?:limit|quota|exceeded|reached|hit|exhausted)",
    "free tier[^.]{0,40}(?:exhausted|limit|ended)",
    "trial[^.]{0,40}(?:expired|ended)",
    "余额不足",
    "欠费",
    "套餐",
    "订阅",
    "充值",
    "超额",
    "超限",
    "用量限制",
    "免费额度",
  ].join("|"),
  "i",
)

/**
 * Generic "quota" wording.  Some providers say "request quota exceeded per
 * minute" for a plain rate limit, so this only wins when there is no rate-limit
 * hint in the same message.
 */
const QUOTA_RE = new RegExp(
  [
    "insufficient[_ ]?quota",
    "quota[^.]{0,40}(?:exceeded|exhausted|reached|limit|insufficient|used up)",
    "(?:exceeded|over|hit|reached)[^.]{0,40}(?:quota|credit|balance|budget|spending)",
    "配额",
    "额度",
  ].join("|"),
  "i",
)

const RATE_HINT_RE =
  /rate[ _-]?limit|too many requests|throttl|per (?:minute|second|hour|day)|requests? per|retry[ -]after|temporarily (?:throttled|rate limited)/i

const CONTEXT_RE =
  /context[ _-]?(?:length|window)|maximum context|prompt is too long|too many tokens|input is too long|reduce the length|context_length_exceeded|exceeds? the (?:model'?s )?context/i

const NETWORK_RE =
  /EAI_[A-Z]+|getaddrinfo|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|failed to fetch|network error|connection (?:reset|closed|refused)|other side closed|premature close|stream (?:error|closed|reset)|upstream (?:error|timeout)|temporarily unavailable|service unavailable|bad gateway|gateway timeout|overloaded|try again later/i

const RATE_RE = /rate[ _-]?limit|too many requests|throttl|requests per (?:minute|second|hour|day)/i

const INVALID_RE =
  /provider\.invalid-request|provider\.invalid-output|provider\.unsupported-operation|provider\.content-filter|content policy|invalid request|bad request|unsupported (?:parameter|operation)|model not found/i

export function classifyError(error: StructuredError | undefined): ErrorClass {
  const type = typeof error?.type === "string" ? error.type : ""
  const status = typeof error?.status === "number" ? error.status : undefined
  const message = typeof error?.message === "string" ? error.message : ""
  const body =
    typeof error?.response?.body === "string" ? error.response.body.slice(0, 4096) : ""
  const text = `${message} ${body}`

  if (
    type === "aborted" ||
    /execution was interrupted|interrupted by user|user interrupt|request aborted/i.test(text)
  ) {
    return { kind: "aborted", retryable: false, terminal: true, code: type || "aborted" }
  }

  // Out of money / out of plan.  Must be checked before 429 handling.
  // Strong billing wording always wins; generic "quota" wording only wins when
  // the same message is not clearly a per-minute rate limit.
  if (
    STRONG_QUOTA_RE.test(text) ||
    type === "provider.quota" ||
    status === 402 ||
    (QUOTA_RE.test(text) && !RATE_HINT_RE.test(text))
  ) {
    return {
      kind: "quota",
      retryable: false,
      terminal: true,
      code: type || (status ? `http-${status}` : "quota"),
    }
  }

  if (CONTEXT_RE.test(text) || type === "provider.context-overflow") {
    return { kind: "context", retryable: false, terminal: false, code: type || "context" }
  }

  // Some gateways use 403 for a temporary rate limit.  Treat that as a rate
  // limit, not an auth failure, so the built-in backoff can still run.
  if (
    status === 401 ||
    type === "provider.auth" ||
    (status === 403 && !RATE_HINT_RE.test(text))
  ) {
    return {
      kind: "auth",
      retryable: false,
      terminal: true,
      code: type || (status ? `http-${status}` : "auth"),
    }
  }

  if (
    status === 400 ||
    status === 404 ||
    status === 413 ||
    status === 422 ||
    INVALID_RE.test(`${type} ${text}`)
  ) {
    return {
      kind: type === "provider.content-filter" ? "content" : "invalid",
      retryable: false,
      terminal: true,
      code: type || (status ? `http-${status}` : "invalid"),
    }
  }

  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    type === "provider.rate-limit" ||
    RATE_RE.test(text)
  ) {
    return {
      kind: "rate",
      retryable: true,
      terminal: false,
      code: type || (status ? `http-${status}` : "rate"),
    }
  }

  if (
    (typeof status === "number" && status >= 500 && status !== 501 && status !== 505) ||
    type === "provider.internal"
  ) {
    return {
      kind: "server",
      retryable: true,
      terminal: false,
      code: type || (status ? `http-${status}` : "server"),
    }
  }

  if (type === "provider.transport" || type === "provider.timeout" || NETWORK_RE.test(text)) {
    return {
      kind: "network",
      retryable: true,
      terminal: false,
      code: type || "network",
    }
  }

  return { kind: "unknown", retryable: false, terminal: false, code: type || "unknown" }
}

/* -------------------------------------------------------------------------- */
/* Marker parsing                                                             */
/* -------------------------------------------------------------------------- */

export type GoalMarker =
  | { kind: "done" }
  | { kind: "blocked"; reason: string }
  | { kind: "none" }

function cleanMarkerLine(line: string): string {
  return line
    .replace(/^[\s>*_`~-]+/, "")
    .replace(/[\s*_`~]+$/, "")
    .replace(/[.!。！]+$/, "")
    .trim()
}

function isFence(line: string): boolean {
  return /^[`~]{3,}$/.test(line.trim())
}

/**
 * A marker is only accepted in the last few lines, so quoting the instruction
 * earlier in an answer cannot accidentally finish the goal.
 *
 * GOAL_DONE must be the final content line.  GOAL_BLOCKED may be followed by a
 * reason on the same line or on the next lines.
 */
export function parseGoalMarker(text: string): GoalMarker {
  if (!text) return { kind: "none" }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !isFence(line))

  if (lines.length === 0) return { kind: "none" }

  const tail = lines.slice(-4)
  const last = cleanMarkerLine(tail[tail.length - 1] ?? "")
  if (new RegExp(`^${MARKER_DONE}$`, "i").test(last)) return { kind: "done" }

  for (let i = tail.length - 1; i >= Math.max(0, tail.length - 3); i--) {
    const cleaned = cleanMarkerLine(tail[i] ?? "")
    const match = new RegExp(`^${MARKER_BLOCKED}\\b[\\s:：-]*(.*)$`, "i").exec(cleaned)
    if (match) {
      const reason = [match[1] ?? "", ...tail.slice(i + 1)]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
      return { kind: "blocked", reason: reason || "blocked" }
    }
  }

  return { kind: "none" }
}

/* -------------------------------------------------------------------------- */
/* Backoff / hashing                                                          */
/* -------------------------------------------------------------------------- */

export interface BackoffConfig {
  retryDelaysMs: number[]
  retryJitter: number
  retryMaxDelayMs: number
}

export function computeBackoff(
  attemptIndex: number,
  cfg: BackoffConfig,
  random: () => number = Math.random,
): number {
  const delays = cfg.retryDelaysMs.length > 0 ? cfg.retryDelaysMs : [30_000]
  const base = delays[Math.min(Math.max(0, attemptIndex), delays.length - 1)] ?? delays[0] ?? 30_000
  const jitter = Math.max(0, Math.min(1, cfg.retryJitter))
  const factor = 1 + (random() * 2 - 1) * jitter
  return Math.max(0, Math.min(Math.round(base * factor), cfg.retryMaxDelayMs))
}

export function hashText(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16_777_619)
    h2 = Math.imul(h2 + c, 31)
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

interface Config {
  enabled: boolean
  providerIDs: string[] | null
  commandName: string
  debug: boolean
  maxGoalChars: number
  maxRounds: number
  maxWallClockMs: number
  maxCostUSD: number
  maxStalledRounds: number
  compactAtRatio: number
  maxCompactions: number
  reinjectAfterCompaction: boolean
  pauseOnUserPrompt: boolean
  retryEnabled: boolean
  retryDelaysMs: number[]
  retryMaxAttempts: number
  retryJitter: number
  retryMaxDelayMs: number
  retryAfterTools: boolean
}

function readConfig(raw: Record<string, unknown>): Config {
  const value = raw ?? {}

  const num = (key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
    const v = value[key]
    return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback
  }
  const bool = (key: string, fallback: boolean): boolean =>
    typeof value[key] === "boolean" ? (value[key] as boolean) : fallback

  const delaysRaw = value["retryDelaysMs"]
  const delays = Array.isArray(delaysRaw)
    ? delaysRaw.filter(
        (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
      )
    : []

  const providersRaw = value["providerIDs"]
  const providerIDs = Array.isArray(providersRaw)
    ? providersRaw.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : null

  const wallMinutes = num("maxWallClockMinutes", 120, 1, 24 * 60)

  return {
    enabled: bool("enabled", true),
    providerIDs: providerIDs && providerIDs.length > 0 ? providerIDs : null,
    commandName:
      typeof value["commandName"] === "string" && value["commandName"].trim()
        ? (value["commandName"] as string).trim()
        : "goal",
    debug: bool("debug", false),
    maxGoalChars: num("maxGoalChars", 8_000, 1, 100_000),
    maxRounds: num("maxRounds", 25, 0, 10_000),
    maxWallClockMs: wallMinutes * 60_000,
    maxCostUSD: num("maxCostUSD", 0, 0),
    maxStalledRounds: num("maxStalledRounds", 3, 1, 1_000),
    compactAtRatio: num("compactAtRatio", 0.75, 0.1, 0.99),
    maxCompactions: num("maxCompactions", 2, 0, 100),
    reinjectAfterCompaction: bool("reinjectAfterCompaction", true),
    pauseOnUserPrompt: bool("pauseOnUserPrompt", false),
    retryEnabled: bool("retryEnabled", true),
    retryDelaysMs: delays.length > 0 ? delays : [30_000, 60_000, 120_000],
    retryMaxAttempts: num("retryMaxAttempts", 3, 0, 100),
    retryJitter: num("retryJitter", 0.2, 0, 1),
    retryMaxDelayMs: num("retryMaxDelayMs", 15 * 60_000, 0),
    retryAfterTools: bool("retryAfterTools", true),
  }
}

/* -------------------------------------------------------------------------- */
/* Runtime state                                                              */
/* -------------------------------------------------------------------------- */

type Phase = "active" | "paused" | "done"

interface GoalState {
  sessionID: string
  goal: string
  phase: Phase
  reason?: string
  createdAt: number
  startedAt: number
  rounds: number
  compactions: number
  stalled: number
  lastHash?: string
  retryAttempts: number
  retryTimer?: ReturnType<typeof setTimeout>
  retryAt?: number
  busy: boolean
  pending: boolean
  runSeq: number
  lastSucceededSeq: number
  toolsRan: boolean
  baselineCost: number
  cost: number
  model?: ModelRef
  contextLimit?: number
  lastTokens?: { input: number; output: number; cache?: { read?: number; write?: number } }
  texts: Map<string, string>
  lastAssistantMessageID?: string
  pendingInbox?: string
  lastError?: { kind: ErrorKind; code: string; message: string }
}

interface PersistedGoal {
  v: number
  goal: string
  phase: "active" | "paused"
  reason?: string
  createdAt: number
  startedAt: number
  rounds: number
  compactions: number
  baselineCost: number
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* -------------------------------------------------------------------------- */

export default {
  id: PLUGIN_ID,
  async setup(ctx: PluginContext): Promise<() => Promise<void>> {
    const cfg = readConfig(ctx.options ?? {})
    if (!cfg.enabled) {
      console.error(`${LOG} disabled by configuration`)
      return async () => {}
    }

    const states = new Map<string, GoalState>()
    const hydrated = new Set<string>()
    const loading = new Map<string, Promise<GoalState | undefined>>()
    const foreign = new Map<string, number>()
    const disposables: Registration[] = []
    const controller = new AbortController()
    const instanceID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

    const owns = (sessionID: string): boolean => {
      const entry = ownerRegistry.owners.get(sessionID)
      if (!entry || entry.instance !== instanceID) return false
      entry.at = Date.now()
      return true
    }

    const claim = (sessionID: string, force: boolean): boolean => {
      const now = Date.now()
      const entry = ownerRegistry.owners.get(sessionID)
      if (!force && entry && entry.instance !== instanceID && now - entry.at < OWNER_LEASE_MS) {
        return false
      }
      ownerRegistry.owners.set(sessionID, { instance: instanceID, at: now })
      foreign.delete(sessionID)
      return true
    }

    const release = (sessionID: string): void => {
      const entry = ownerRegistry.owners.get(sessionID)
      if (entry && entry.instance === instanceID) ownerRegistry.owners.delete(sessionID)
    }

    const heartbeat = setInterval(() => {
      const now = Date.now()
      for (const [sessionID, entry] of ownerRegistry.owners) {
        if (entry.instance === instanceID) entry.at = now
        else if (now - entry.at > OWNER_LEASE_MS * 4) ownerRegistry.owners.delete(sessionID)
      }
    }, OWNER_HEARTBEAT_MS)

    const keyFor = (sessionID: string): string => `goal.v${STORAGE_VERSION}.${sessionID}`

    const normaliseDirectory = (value: unknown): string | undefined => {
      if (typeof value !== "string" || value.length === 0) return undefined
      const trimmed = value.replace(/\/+$/, "")
      return trimmed.length > 0 ? trimmed : "/"
    }

    // Plugins are loaded once per location.  The event stream is the server's
    // public stream, so ignore events that belong to a different location and
    // let that location's own plugin instance handle them.
    const myDirectory = normaliseDirectory(ctx.location?.directory)

    const debug = (...args: unknown[]): void => {
      if (cfg.debug) console.error(LOG, ...args)
    }

    const truncate = (text: string, max: number): string =>
      text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

    const shortError = (error: StructuredError | undefined): string => {
      const raw = `${error?.type ?? "error"}${error?.status ? ` ${error.status}` : ""}: ${error?.message ?? ""}`
      return truncate(raw.replace(/\s+/g, " ").trim(), 160)
    }

    const clearRetry = (state: GoalState): void => {
      if (state.retryTimer !== undefined) {
        clearTimeout(state.retryTimer)
        state.retryTimer = undefined
      }
      state.retryAt = undefined
    }

    const newState = (
      sessionID: string,
      goal: string,
      baselineCost: number,
      model?: ModelRef,
    ): GoalState => {
      const now = Date.now()
      const state: GoalState = {
        sessionID,
        goal,
        phase: "active",
        createdAt: now,
        startedAt: now,
        rounds: 0,
        compactions: 0,
        stalled: 0,
        retryAttempts: 0,
        busy: false,
        pending: false,
        runSeq: 0,
        lastSucceededSeq: -1,
        toolsRan: false,
        baselineCost,
        cost: baselineCost,
        texts: new Map(),
      }
      if (model) state.model = model
      return state
    }

    const persisted = (state: GoalState): PersistedGoal | undefined => {
      if (state.phase === "done" || !state.goal) return undefined
      return {
        v: STORAGE_VERSION,
        goal: state.goal,
        phase: state.phase === "active" ? "active" : "paused",
        ...(state.reason ? { reason: state.reason } : {}),
        createdAt: state.createdAt,
        startedAt: state.startedAt,
        rounds: state.rounds,
        compactions: state.compactions,
        baselineCost: state.baselineCost,
      }
    }

    const persistNow = async (state: GoalState): Promise<void> => {
      const data = persisted(state)
      try {
        if (!data) await ctx.storage.remove(keyFor(state.sessionID))
        else await ctx.storage.set(keyFor(state.sessionID), data as unknown as Json)
      } catch (error) {
        console.error(`${LOG} failed to persist goal state`, error)
      }
    }

    const persist = (state: GoalState): void => {
      void persistNow(state)
    }

    const notify = async (sessionID: string, text: string): Promise<void> => {
      try {
        // `resume: false` is important: a status notice must not start a turn.
        await ctx.session.synthetic({
          sessionID,
          text,
          description: "goal",
          resume: false,
        })
      } catch (error) {
        console.error(`${LOG} failed to notify session`, sessionID, error)
      }
    }

    interface EnsureStateOptions {
      readOnly?: boolean
      force?: boolean
    }

    const loadState = async (
      sessionID: string,
      readOnly: boolean,
    ): Promise<GoalState | undefined> => {
      hydrated.add(sessionID)
      if (hydrated.size > MAX_HYDRATED_SESSIONS) hydrated.clear()

      let raw: Json | undefined
      try {
        raw = await ctx.storage.get(keyFor(sessionID))
      } catch (error) {
        console.error(`${LOG} failed to read goal state`, sessionID, error)
        return undefined
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined

      const data = raw as Record<string, unknown>
      const goal = typeof data.goal === "string" ? data.goal : ""
      if (!goal) return undefined

      let info: SessionInfo | undefined
      try {
        info = await ctx.session.get({ sessionID })
      } catch (error) {
        debug("session.get failed for restored goal", error)
      }

      const sessionDirectory = normaliseDirectory(info?.location?.directory)
      if (sessionDirectory && myDirectory && sessionDirectory !== myDirectory) {
        // The goal belongs to another location; that location's plugin instance
        // is the only one allowed to handle it.
        foreign.set(sessionID, Date.now() + FOREIGN_RECHECK_MS)
        hydrated.delete(sessionID)
        return undefined
      }

      const baselineCost =
        typeof data.baselineCost === "number" && Number.isFinite(data.baselineCost)
          ? data.baselineCost
          : 0
      const state = newState(sessionID, goal, baselineCost)
      state.createdAt =
        typeof data.createdAt === "number" && Number.isFinite(data.createdAt)
          ? data.createdAt
          : Date.now()
      state.startedAt =
        typeof data.startedAt === "number" && Number.isFinite(data.startedAt)
          ? data.startedAt
          : state.createdAt
      state.rounds =
        typeof data.rounds === "number" && Number.isFinite(data.rounds) ? data.rounds : 0
      state.compactions =
        typeof data.compactions === "number" && Number.isFinite(data.compactions)
          ? data.compactions
          : 0
      if (info?.model) state.model = info.model
      if (typeof info?.cost === "number" && Number.isFinite(info.cost)) state.cost = info.cost

      // Never auto-resume after a restart: the user may not expect spending.
      const wasActive = data.phase !== "paused"
      state.phase = "paused"
      state.reason = wasActive
        ? "restored after restart"
        : typeof data.reason === "string"
          ? data.reason
          : "paused"

      if (wasActive) {
        // `readOnly` is used by /goal status.  It must not steal ownership.
        if (readOnly) return state

        // Another live plugin instance owns this active goal.  Do not touch it:
        // this is what used to pause healthy goals on every duplicate boot.
        if (!claim(sessionID, false)) {
          foreign.set(sessionID, Date.now() + FOREIGN_RECHECK_MS)
          hydrated.delete(sessionID)
          return undefined
        }
      }

      states.set(sessionID, state)
      if (!readOnly) persist(state)
      if (wasActive && !readOnly) {
        void notify(
          sessionID,
          "goal restored as paused after restart. /goal resume to continue.",
        )
      }
      return state
    }

    const ensureState = async (
      sessionID: string,
      options?: EnsureStateOptions,
    ): Promise<GoalState | undefined> => {
      const existing = states.get(sessionID)
      if (existing) {
        if (existing.phase === "active") owns(sessionID)
        return existing
      }

      const until = foreign.get(sessionID)
      if (until !== undefined) {
        if (Date.now() < until) return undefined
        foreign.delete(sessionID)
      }

      const inFlight = loading.get(sessionID)
      if (inFlight) return inFlight
      if (!options?.force && hydrated.has(sessionID)) return undefined

      const task = loadState(sessionID, options?.readOnly === true).finally(() => {
        loading.delete(sessionID)
      })
      loading.set(sessionID, task)
      return task
    }

    const pause = (state: GoalState, reason: string, notice?: string): void => {
      if (state.phase !== "active") return
      if (!owns(state.sessionID)) {
        // Another instance took over (e.g. /goal on a different boot); do not
        // overwrite its state.
        clearRetry(state)
        states.delete(state.sessionID)
        return
      }
      state.phase = "paused"
      state.reason = reason
      state.pending = false
      state.pendingInbox = undefined
      state.busy = false
      clearRetry(state)
      persist(state)
      if (notice) void notify(state.sessionID, notice)
    }

    const finish = (state: GoalState, notice: string): void => {
      if (!owns(state.sessionID)) {
        clearRetry(state)
        states.delete(state.sessionID)
        return
      }
      state.phase = "done"
      state.pending = false
      state.pendingInbox = undefined
      state.busy = false
      clearRetry(state)
      states.delete(state.sessionID)
      hydrated.delete(state.sessionID)
      foreign.delete(state.sessionID)
      release(state.sessionID)
      void persistNow(state)
      void notify(state.sessionID, notice)
    }

    const dropSession = (sessionID: string): void => {
      const state = states.get(sessionID)
      if (state) clearRetry(state)
      states.delete(sessionID)
      hydrated.delete(sessionID)
      foreign.delete(sessionID)
      ownerRegistry.owners.delete(sessionID)
      void ctx.storage.remove(keyFor(sessionID)).catch((error: unknown) => {
        console.error(`${LOG} failed to remove goal state`, sessionID, error)
      })
    }

    const appendText = (state: GoalState, messageID: string, text: string): void => {
      if (!text) return
      const previous = state.texts.get(messageID) ?? ""
      let next = previous ? `${previous}\n${text}` : text
      if (next.length > MAX_TEXT_CHARS) next = next.slice(-MAX_TEXT_CHARS)
      if (!state.texts.has(messageID) && state.texts.size >= MAX_TEXT_MESSAGES) {
        const oldest = state.texts.keys().next().value
        if (typeof oldest === "string") state.texts.delete(oldest)
      }
      state.texts.set(messageID, next)
    }

    const finalText = (state: GoalState): string => {
      if (state.lastAssistantMessageID) {
        const text = state.texts.get(state.lastAssistantMessageID)
        if (typeof text === "string") return text
      }
      let last = ""
      for (const value of state.texts.values()) {
        if (value.trim()) last = value
      }
      return last
    }

    const modelLimit = async (state: GoalState): Promise<number> => {
      if (state.contextLimit !== undefined) return state.contextLimit
      const ref = state.model
      if (!ref) {
        state.contextLimit = 0
        return 0
      }
      try {
        const models = await ctx.model.list()
        const match = models.find(
          (model) =>
            model.providerID === ref.providerID &&
            (model.id === ref.id || model.modelID === ref.id),
        )
        state.contextLimit = match?.limit?.context ?? 0
      } catch (error) {
        debug("model lookup failed", error)
        state.contextLimit = 0
      }
      return state.contextLimit ?? 0
    }

    const tokenTotal = (tokens: GoalState["lastTokens"]): number => {
      if (!tokens) return 0
      const cacheRead = tokens.cache?.read ?? 0
      const cacheWrite = tokens.cache?.write ?? 0
      return tokens.input + cacheRead + cacheWrite + tokens.output
    }

    const sendContinuation = async (state: GoalState, reinject: boolean): Promise<void> => {
      if (state.phase !== "active") return
      if (!owns(state.sessionID)) {
        clearRetry(state)
        states.delete(state.sessionID)
        return
      }
      if (state.pending) return
      if (state.rounds >= cfg.maxRounds) {
        pause(
          state,
          "round budget",
          `goal paused: round budget exhausted (${cfg.maxRounds}). /goal resume to extend.`,
        )
        return
      }
      if (Date.now() - state.startedAt > cfg.maxWallClockMs) {
        pause(state, "wall clock budget", "goal paused: wall clock budget exhausted.")
        return
      }
      if (cfg.maxCostUSD > 0 && state.cost - state.baselineCost >= cfg.maxCostUSD) {
        pause(state, "cost budget", `goal paused: cost budget exhausted ($${cfg.maxCostUSD}).`)
        return
      }

      state.rounds += 1
      state.pending = true
      state.busy = true
      persist(state)

      const text = reinject
        ? `Continue. Goal: ${truncate(state.goal, 2_000)} End: GOAL_DONE or GOAL_BLOCKED: <reason>.`
        : CONTINUE_TEXT

      try {
        await ctx.session.prompt({
          sessionID: state.sessionID,
          text,
          delivery: "queue",
          metadata: { goal: { generated: true, kind: "continue", round: state.rounds } },
        })
        debug("continuation queued", state.sessionID, "round", state.rounds)
      } catch (error) {
        state.pending = false
        state.busy = false
        pause(
          state,
          "continuation failed",
          `goal paused: could not queue continuation: ${truncate(String(error), 120)}`,
        )
      }
    }

    const scheduleRetry = (state: GoalState, retryAfterMs?: number): void => {
      if (state.retryAttempts >= cfg.retryMaxAttempts) {
        pause(
          state,
          "retry budget",
          `goal paused: plugin retries exhausted (${cfg.retryMaxAttempts}). /goal retry to try now.`,
        )
        return
      }
      const index = state.retryAttempts
      state.retryAttempts += 1
      clearRetry(state)
      const hint =
        typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs
          : 0
      const delay = Math.min(
        Math.max(computeBackoff(index, cfg), hint),
        cfg.retryMaxDelayMs,
      )
      state.retryAt = Date.now() + delay
      state.retryTimer = setTimeout(() => {
        state.retryTimer = undefined
        state.retryAt = undefined
        void runRetry(state)
      }, delay)
      persist(state)
      debug("plugin retry scheduled", state.sessionID, "attempt", state.retryAttempts, "delay", delay)
    }

    const runRetry = async (state: GoalState): Promise<void> => {
      if (state.phase !== "active") return
      if (!owns(state.sessionID)) {
        clearRetry(state)
        states.delete(state.sessionID)
        return
      }
      if (state.busy || state.pending) return
      state.busy = true
      state.pending = true
      persist(state)
      try {
        await ctx.session.prompt({
          sessionID: state.sessionID,
          text: RETRY_TEXT,
          delivery: "queue",
          metadata: {
            goal: { generated: true, kind: "retry", attempt: state.retryAttempts },
          },
        })
        debug("plugin retry queued", state.sessionID, "attempt", state.retryAttempts)
      } catch (error) {
        state.busy = false
        state.pending = false
        pause(
          state,
          "retry failed",
          `goal paused: could not queue retry: ${truncate(String(error), 120)}`,
        )
      }
    }

    const maybeCompact = async (state: GoalState, force: boolean): Promise<void> => {
      const limit = await modelLimit(state)
      const ratio = limit > 0 ? tokenTotal(state.lastTokens) / limit : 0

      if (!force && ratio < cfg.compactAtRatio) {
        // Compaction worked; allow future compactions again.
        if (ratio < cfg.compactAtRatio * 0.8) state.compactions = 0
        await sendContinuation(state, false)
        return
      }

      if (state.compactions >= cfg.maxCompactions) {
        pause(
          state,
          "context limit",
          `goal paused: context is still above ${Math.round(cfg.compactAtRatio * 100)}% after ${cfg.maxCompactions} compactions.`,
        )
        return
      }

      state.compactions += 1
      persist(state)
      debug("compacting", state.sessionID, "ratio", ratio.toFixed(2), "count", state.compactions)
      try {
        await ctx.session.compact({ sessionID: state.sessionID, delivery: "queue" })
      } catch (error) {
        debug("compact failed", error)
      }

      // Queue the continuation after the compaction.  Re-inject the goal once
      // because a summary may not preserve it perfectly.
      await sendContinuation(state, cfg.reinjectAfterCompaction)
    }

    const onSucceeded = async (state: GoalState): Promise<void> => {
      if (state.phase !== "active") return
      if (!owns(state.sessionID)) {
        clearRetry(state)
        states.delete(state.sessionID)
        return
      }

      const text = finalText(state)
      const marker = parseGoalMarker(text)
      if (marker.kind === "done") {
        finish(state, `goal done after ${state.rounds} rounds.`)
        return
      }
      if (marker.kind === "blocked") {
        pause(
          state,
          `blocked: ${truncate(marker.reason, 200)}`,
          `goal paused: model reported GOAL_BLOCKED — ${truncate(marker.reason, 200)}`,
        )
        return
      }

      // A clean run resets the transient-failure budget.
      state.retryAttempts = 0

      if (Date.now() - state.startedAt > cfg.maxWallClockMs) {
        pause(state, "wall clock budget", "goal paused: wall clock budget exhausted.")
        return
      }
      if (cfg.maxCostUSD > 0 && state.cost - state.baselineCost >= cfg.maxCostUSD) {
        pause(state, "cost budget", `goal paused: cost budget exhausted ($${cfg.maxCostUSD}).`)
        return
      }
      if (state.rounds >= cfg.maxRounds) {
        pause(
          state,
          "round budget",
          `goal paused: round budget exhausted (${cfg.maxRounds}). /goal resume to extend.`,
        )
        return
      }

      const normalised = text.replace(/\s+/g, " ").trim()
      if (!normalised) {
        state.stalled += 1
      } else {
        const hash = hashText(normalised)
        if (hash === state.lastHash) state.stalled += 1
        else {
          state.lastHash = hash
          state.stalled = 0
        }
      }
      if (state.stalled >= cfg.maxStalledRounds) {
        pause(
          state,
          "no progress",
          `goal paused: no progress for ${state.stalled} rounds. /goal resume to continue.`,
        )
        return
      }

      await maybeCompact(state, false)
    }

    const handleContextFailure = async (state: GoalState): Promise<void> => {
      // Context overflow is recovered by compaction, not by a raw retry.
      await maybeCompact(state, true)
    }

    const onFailed = async (state: GoalState, error: StructuredError | undefined): Promise<void> => {
      if (state.phase !== "active") return
      if (!owns(state.sessionID)) {
        clearRetry(state)
        states.delete(state.sessionID)
        return
      }
      const cls = classifyError(error)
      state.lastError = {
        kind: cls.kind,
        code: cls.code,
        message: shortError(error),
      }
      debug("execution failed", state.sessionID, cls.kind, cls.code)

      if (cls.kind === "context") {
        await handleContextFailure(state)
        return
      }
      if (!cls.retryable) {
        pause(
          state,
          cls.kind,
          `goal paused: ${cls.kind} failure (${cls.code}). ${truncate(error?.message ?? "", 160)}`,
        )
        return
      }
      if (!cfg.retryEnabled) {
        pause(state, "retries disabled", "goal paused: plugin retries are disabled.")
        return
      }
      if (state.toolsRan && !cfg.retryAfterTools) {
        pause(
          state,
          "failed after tools",
          "goal paused: execution failed after tools ran; not retrying to avoid duplicate side effects.",
        )
        return
      }
      scheduleRetry(state, error?.retryAfterMs)
    }

    /* ---------------------------------------------------------------------- */
    /* Commands                                                               */
    /* ---------------------------------------------------------------------- */

    const showStatus = async (sessionID: string): Promise<void> => {
      const state = await ensureState(sessionID, { readOnly: true, force: true })
      if (!state) {
        await notify(sessionID, "goal: none. Use /goal <objective> to start.")
        return
      }
      const elapsed = Math.max(0, Math.round((Date.now() - state.startedAt) / 60_000))
      const phase = state.reason ? `${state.phase} (${state.reason})` : state.phase
      await notify(
        sessionID,
        `goal: ${phase} | rounds ${state.rounds}/${cfg.maxRounds} | retries ${state.retryAttempts}/${cfg.retryMaxAttempts} | ${elapsed}m | ${truncate(state.goal, 120)}`,
      )
    }

    const startGoal = async (sessionID: string, objective: string): Promise<void> => {
      const goal = truncate(objective.trim(), cfg.maxGoalChars)
      if (!goal) {
        await notify(sessionID, "goal: empty objective.")
        return
      }

      // An explicit /goal always takes ownership, even if another boot of
      // this location currently owns an older goal.
      claim(sessionID, true)
      foreign.delete(sessionID)

      const existing = states.get(sessionID)
      if (existing) clearRetry(existing)

      let baselineCost = 0
      let model: ModelRef | undefined
      try {
        const info = await ctx.session.get({ sessionID })
        baselineCost = typeof info.cost === "number" && Number.isFinite(info.cost) ? info.cost : 0
        model = info.model
      } catch (error) {
        debug("session.get failed", error)
      }

      const state = newState(sessionID, goal, baselineCost, model)
      state.busy = true
      state.pending = true
      states.set(sessionID, state)
      hydrated.add(sessionID)
      persist(state)

      try {
        await ctx.session.prompt({
          sessionID,
          text: `Goal: ${goal}\n\nWork autonomously until done. End: GOAL_DONE, or GOAL_BLOCKED: <reason>.`,
          delivery: "queue",
          metadata: { goal: { generated: true, kind: "start" } },
        })
        debug("goal started", sessionID, "chars", goal.length)
      } catch (error) {
        state.busy = false
        state.pending = false
        pause(
          state,
          "start failed",
          `goal failed to start: ${truncate(String(error), 140)}`,
        )
      }
    }

    const resumeGoal = async (sessionID: string): Promise<void> => {
      const state = await ensureState(sessionID, { readOnly: true, force: true })
      if (!state) {
        await notify(sessionID, "goal: none. Use /goal <objective> to start.")
        return
      }
      claim(sessionID, true)
      states.set(sessionID, state)
      hydrated.add(sessionID)
      clearRetry(state)
      state.phase = "active"
      state.reason = undefined
      state.retryAttempts = 0
      state.stalled = 0
      state.lastHash = undefined
      state.rounds = 0
      state.compactions = 0
      state.startedAt = Date.now()
      state.busy = false
      state.pending = false
      state.pendingInbox = undefined
      persist(state)
      await sendContinuation(state, false)
    }

    const retryNow = async (sessionID: string): Promise<void> => {
      const state = await ensureState(sessionID, { readOnly: true, force: true })
      if (!state) {
        await notify(sessionID, "goal: none. Use /goal <objective> to start.")
        return
      }
      claim(sessionID, true)
      states.set(sessionID, state)
      hydrated.add(sessionID)
      clearRetry(state)
      if (state.busy || state.pending) {
        await notify(sessionID, "goal: session is busy; run /goal retry again when it is idle.")
        return
      }
      if (state.phase !== "active") {
        state.phase = "active"
        state.reason = undefined
      }
      state.retryAttempts = 0
      persist(state)
      await runRetry(state)
    }

    const clearGoal = async (sessionID: string): Promise<void> => {
      const state = states.get(sessionID)
      if (state) clearRetry(state)
      states.delete(sessionID)
      foreign.delete(sessionID)
      ownerRegistry.owners.delete(sessionID)
      hydrated.add(sessionID)
      try {
        await ctx.storage.remove(keyFor(sessionID))
      } catch (error) {
        console.error(`${LOG} failed to clear goal state`, error)
      }
      await notify(sessionID, "goal cleared.")
    }

    const runCommand = async (input: CommandInvocation): Promise<void> => {
      const sessionID = input.sessionID
      let raw = (input.prompt?.text ?? "").trim()
      if (raw.startsWith("/")) raw = raw.replace(/^\/\S+\s*/, "").trim()

      try {
        if (!raw) {
          await showStatus(sessionID)
          return
        }

        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
        const verb = (match?.[1] ?? "").toLowerCase()
        const rest = (match?.[2] ?? "").trim()

        if (!rest) {
          switch (verb) {
            case "help":
              await notify(sessionID, HELP_TEXT)
              return
            case "status":
              await showStatus(sessionID)
              return
            case "stop":
            case "pause": {
              const state = await ensureState(sessionID, { readOnly: true, force: true })
              if (!state) {
                await notify(sessionID, "goal: none.")
                return
              }
              claim(sessionID, true)
              states.set(sessionID, state)
              hydrated.add(sessionID)
              // A read-only load always represents the goal as paused; mark it
              // and persist explicitly instead of relying on pause()'s
              // active-state guard.
              state.phase = "paused"
              state.reason = "user"
              state.pending = false
              state.pendingInbox = undefined
              state.busy = false
              clearRetry(state)
              persist(state)
              await notify(sessionID, "goal paused. /goal resume to continue.")
              return
            }
            case "resume":
              await resumeGoal(sessionID)
              return
            case "retry":
              await retryNow(sessionID)
              return
            case "clear":
            case "done":
            case "remove":
              await clearGoal(sessionID)
              return
            default:
              break
          }
        }

        await startGoal(sessionID, raw)
      } catch (error) {
        console.error(`${LOG} command failed`, error)
        await notify(sessionID, `goal: command failed: ${truncate(String(error), 140)}`)
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Event handling                                                         */
    /* ---------------------------------------------------------------------- */

    const handleEvent = async (event: OpenCodeEvent): Promise<void> => {
      const type = event?.type
      const data = event?.data
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
      if (!type || !sessionID) return

      const eventDirectory = normaliseDirectory(event?.location?.directory)
      if (eventDirectory && myDirectory && eventDirectory !== myDirectory) return

      const known = states.get(sessionID)
      if (known && known.phase === "active" && !owns(sessionID)) {
        // Ownership moved to another live instance; drop the stale local copy
        // instead of racing it.
        clearRetry(known)
        states.delete(sessionID)
        hydrated.delete(sessionID)
        const entry = ownerRegistry.owners.get(sessionID)
        if (entry) foreign.set(sessionID, Date.now() + FOREIGN_RECHECK_MS)
      }

      switch (type) {
        case "session.execution.started": {
          const state = await ensureState(sessionID)
          if (!state) return
          state.busy = true
          state.runSeq += 1
          // If no generated prompt is known to be queued, an old `pending`
          // flag is stale (e.g. the enqueue event was missed while the event
          // stream reconnected).  The queued-prompt case keeps `pendingInbox`.
          if (!state.pendingInbox) state.pending = false
          state.toolsRan = false
          state.lastAssistantMessageID = undefined
          state.lastError = undefined
          state.texts.clear()
          return
        }

        case "session.text.ended": {
          const state = states.get(sessionID)
          if (!state) return
          const messageID = data?.assistantMessageID
          const text = data?.text
          if (typeof messageID !== "string" || typeof text !== "string") return
          appendText(state, messageID, text)
          return
        }

        case "session.step.ended": {
          const state = states.get(sessionID)
          if (!state) return
          if (typeof data?.assistantMessageID === "string") {
            state.lastAssistantMessageID = data.assistantMessageID
          }
          if (data?.tokens && typeof data.tokens === "object") {
            state.lastTokens = data.tokens as GoalState["lastTokens"]
          }
          return
        }

        case "session.tool.called": {
          const state = states.get(sessionID)
          if (!state) return
          if (data?.executed === true) state.toolsRan = true
          return
        }

        case "session.usage.updated": {
          const state = states.get(sessionID)
          if (!state) return
          if (typeof data?.cost === "number" && Number.isFinite(data.cost)) {
            state.cost = data.cost
          }
          return
        }

        case "session.execution.succeeded": {
          const state = await ensureState(sessionID)
          if (!state) return
          if (state.lastSucceededSeq === state.runSeq) {
            debug("ignoring duplicate execution.succeeded", sessionID)
            return
          }
          state.lastSucceededSeq = state.runSeq
          state.busy = false
          if (state.pending) {
            // A generated prompt is already queued; do not add another round.
            debug("ignoring succeeded while a prompt is still queued", sessionID)
            return
          }
          await onSucceeded(state)
          return
        }

        case "session.execution.failed": {
          const state = await ensureState(sessionID)
          if (!state) return
          state.busy = false
          if (state.pending) {
            // Another generated prompt is already queued; let it run instead
            // of adding a retry prompt on top of it.
            debug("ignoring failure while a prompt is still queued", sessionID)
            return
          }
          await onFailed(state, data?.error)
          return
        }

        case "session.execution.interrupted": {
          const state = await ensureState(sessionID)
          if (!state) return
          state.busy = false
          const reason = typeof data?.reason === "string" ? data.reason : "interrupted"
          if (state.phase === "active") {
            pause(state, `interrupted:${reason}`, "goal paused: execution interrupted.")
          }
          return
        }

        case "session.inbox.enqueued": {
          const state = await ensureState(sessionID)
          if (!state) return
          const item = data?.item
          if (!item || item.type !== "user") return
          const metadata = item.payload?.metadata
          const generated =
            !!metadata &&
            typeof metadata === "object" &&
            !!metadata.goal &&
            typeof metadata.goal === "object" &&
            metadata.goal.generated === true
          if (generated) {
            if (typeof data?.inboxID === "string") state.pendingInbox = data.inboxID
            return
          }

          // A real user prompt: cancel a pending plugin retry, and optionally
          // hand control back to the user.
          clearRetry(state)
          state.retryAttempts = 0
          if (cfg.pauseOnUserPrompt && state.phase === "active") {
            pause(
              state,
              "user prompt",
              "goal paused: user sent a message. /goal resume to continue.",
            )
          }
          return
        }

        case "session.inbox.delivered": {
          const state = states.get(sessionID)
          if (!state || !state.pendingInbox) return
          if (data?.inboxID === state.pendingInbox) {
            state.pendingInbox = undefined
            state.pending = false
          }
          return
        }

        case "session.inbox.cancelled": {
          const state = await ensureState(sessionID)
          if (!state) return
          // Only our own generated prompt cancelling should stop the loop.
          if (!state.pendingInbox || data?.inboxID !== state.pendingInbox) return
          state.pendingInbox = undefined
          state.busy = false
          state.pending = false
          if (state.phase === "active") {
            pause(state, "prompt cancelled", "goal paused: a queued prompt was cancelled.")
          }
          return
        }

        case "session.status": {
          const status = data?.status
          if (!status || status.type !== "retry" || !status.action) return
          const state = await ensureState(sessionID)
          if (!state) return
          if (state.phase !== "active") return
          const title = typeof status.action.title === "string" ? status.action.title : "provider action"
          const message =
            typeof status.action.message === "string" ? status.action.message : ""
          pause(
            state,
            `provider action: ${title}`,
            `goal paused: ${title}${message ? ` — ${truncate(message, 160)}` : ""}. /goal resume after fixing it.`,
          )
          return
        }

        case "session.deleted": {
          dropSession(sessionID)
          return
        }

        default:
          return
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Retry hook: quota/balance is terminal, everything else is left alone   */
    /* ---------------------------------------------------------------------- */

    const onRetry = async (event: RetryEvent): Promise<void> => {
      try {
        const cls = classifyError(event.error)
        if (cls.kind !== "quota") return

        // Never spend another attempt when the account cannot pay for it.
        event.decision = { retry: false }

        // Hooks may be registered per location; only the owning instance
        // should pause the goal and notify the user.
        try {
          const info = await ctx.session.get({ sessionID: event.sessionID })
          const directory = normaliseDirectory(info.location?.directory)
          if (directory && myDirectory && directory !== myDirectory) return
        } catch {
          // If the lookup fails, still veto the retry below.
        }

        const state = await ensureState(event.sessionID)
        if (state && state.phase === "active") {
          pause(
            state,
            `quota:${cls.code}`,
            `goal paused: provider quota/balance exhausted (${shortError(event.error)}). Top up or switch provider, then /goal resume.`,
          )
        }
      } catch (error) {
        console.error(`${LOG} retry hook failed`, error)
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Registration / lifecycle                                               */
    /* ---------------------------------------------------------------------- */

    const commandRegistration = await ctx.command.transform((editor) => {
      editor.add({
        name: cfg.commandName,
        description:
          "Autonomous goal loop: /goal <objective>, /goal status|stop|resume|retry|clear",
        execute: runCommand,
      })
    })
    disposables.push(commandRegistration)

    const hookProviders: Array<string | undefined> =
      cfg.providerIDs && cfg.providerIDs.length > 0 ? cfg.providerIDs : [undefined]
    for (const providerID of hookProviders) {
      const registration = await ctx.session.hook(
        "retry",
        onRetry,
        providerID ? { providerID } : undefined,
      )
      disposables.push(registration)
    }

    const sleep = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (controller.signal.aborted) return resolve()
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = (): void => {
          if (timer !== undefined) clearTimeout(timer)
          controller.signal.removeEventListener("abort", done)
          resolve()
        }
        timer = setTimeout(done, ms)
        controller.signal.addEventListener("abort", done, { once: true })
      })

    void (async () => {
      let delay = 1_000
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            delay = 1_000
            try {
              await handleEvent(event)
            } catch (error) {
              console.error(`${LOG} event handler failed`, event?.type, error)
            }
          }
        } catch (error) {
          if (controller.signal.aborted) break
          console.error(`${LOG} event stream failed; reconnecting`, error)
        }
        if (controller.signal.aborted) break
        await sleep(delay)
        delay = Math.min(delay * 2, 30_000)
      }
    })()

    console.error(`${LOG} loaded (OpenCode ${ctx.app?.version ?? "?"})`)

    return async (): Promise<void> => {
      controller.abort()
      clearInterval(heartbeat)

      const owned: GoalState[] = []
      for (const state of states.values()) {
        clearRetry(state)
        if (!owns(state.sessionID)) continue
        owned.push(state)
      }
      await Promise.allSettled(owned.map((state) => persistNow(state)))
      for (const [sessionID, entry] of ownerRegistry.owners) {
        if (entry.instance === instanceID) ownerRegistry.owners.delete(sessionID)
      }

      for (const registration of disposables) {
        try {
          await registration.dispose()
        } catch (error) {
          debug("dispose failed", error)
        }
      }
      states.clear()
      hydrated.clear()
      foreign.clear()
    }
  },
}
