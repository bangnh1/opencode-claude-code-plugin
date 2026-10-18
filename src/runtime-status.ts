import { MCP_PENDING_STATUS, type RuntimeMcpStatus } from "./mcp-bridge.js"
import { log } from "./logger.js"

/**
 * Captured opencode runtime context (SDK client + project directory) from
 * `PluginInput`. Lives in its own module to break the cycle that would
 * otherwise form between `index.ts` and `claude-code-language-model.ts`.
 * Values are `null`/`undefined` until the plugin's `server` factory runs
 * (e.g. early provider lookups, direct AI-SDK use, tests).
 */
type OpencodeClient = {
  mcp?: {
    status?: () => Promise<{ data?: unknown; error?: unknown }>
  }
  tool?: {
    list?: (options: {
      query: { provider: string; model: string; directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
  }
  session?: {
    /** `GET /session/{id}` — the returned Session carries `directory`. */
    get?: (options: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
    /**
     * `GET /session/status`: sessions missing from the map are idle. The map is
     * per workspace directory, so ask with the session's own `directory`.
     */
    status?: (options?: {
      query?: { directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
    /** `GET /session/{id}/message`: the child session's transcript. */
    messages?: (options: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
    /** `POST /session/{id}/abort`: stop whatever the session is running. */
    abort?: (options: {
      path: { id: string }
      query?: { directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

let opencodeClient: OpencodeClient | null = null

export function setOpencodeClient(client: unknown): void {
  if (client && typeof client === "object") {
    opencodeClient = client as OpencodeClient
    childSessionAnswers.clear()
  }
}

/**
 * The captured SDK client, untyped: callers narrow to the surface they use
 * (this module's `OpencodeClient` only mirrors the MCP/tool routes).
 */
export function getOpencodeClient(): unknown {
  return opencodeClient
}

/**
 * Captured opencode project directory from `PluginInput.directory` (with
 * `worktree` as secondary signal). Used as a *fallback* at Claude CLI
 * spawn time only when `process.cwd()` is unusable (macOS GUI launches
 * where launchd hands the process `cwd=/`).
 *
 * IMPORTANT: never bake this into provider config (`mergedOptions.cwd`).
 * Doing so freezes the value at plugin init and breaks workspace
 * switching mid-session, because subsequent workspace changes in
 * opencode's UI never get reflected in `this.config.cwd`. See issue #4.
 */
let opencodeProjectDirectory: string | undefined

export function setOpencodeProjectDirectory(dir: string | undefined): void {
  opencodeProjectDirectory = dir
}

export function getOpencodeProjectDirectory(): string | undefined {
  return opencodeProjectDirectory
}

export function isUsableDirectory(d: unknown): d is string {
  return typeof d === "string" && d.length > 1 && d !== "/"
}

/**
 * Resolve the cwd for a Claude CLI subprocess spawn. Priority:
 *
 * 1. Explicit `configured` value (`options.cwd` from `opencode.json`).
 *    Users who pinned a directory keep their override unconditionally.
 * 2. The opencode session's own `directory` (resolved per-call from the
 *    `x-session-affinity` id via the SDK). Authoritative for
 *    `opencode serve` / web-UI mode, where one long-lived server process
 *    handles many projects and `process.cwd()` is the server's launch
 *    dir — not the session's project. Equals `process.cwd()` in the TUI,
 *    so it does not regress that path.
 * 3. Live `process.cwd()` when it's a real directory. Lazy resolution
 *    that lets opencode's project-aware behavior (chdir on workspace
 *    switch, project-per-shell on terminal launch) flow through.
 * 4. Captured project directory from plugin init. Rescues macOS GUI
 *    launches where `process.cwd()` is `/`.
 * 5. Final fallback to `process.cwd()` (returns `/` in the pathological
 *    case where neither override nor capture is available).
 */
export function resolveSpawnCwd(configured: string | undefined): string {
  return resolveSpawnCwdFrom(
    configured,
    process.cwd(),
    opencodeProjectDirectory,
  )
}

export function resolveSpawnCwdFrom(
  configured: string | undefined,
  live: string,
  captured: string | undefined,
  sessionDir?: string,
): string {
  if (configured) return configured
  if (isUsableDirectory(sessionDir)) return sessionDir
  if (isUsableDirectory(live)) return live
  return captured ?? live
}

/**
 * Resolve the spawn cwd for a specific opencode session. Looks up the
 * session's `directory` via the SDK (keyed by the `x-session-affinity`
 * id opencode sets on LLM calls) and feeds it into `resolveSpawnCwdFrom`
 * as tier 2. Falls back cleanly to the non-session resolution when the
 * id is absent ("default"), no SDK client is captured, or the lookup
 * fails — so the TUI / direct-AI-SDK / test paths are unaffected.
 */
export async function resolveSpawnCwdForSession(
  configured: string | undefined,
  sessionID: string | undefined,
): Promise<string> {
  // An explicit pin wins unconditionally — skip the lookup entirely.
  if (configured) return configured
  const sessionDir = sessionID
    ? await fetchSessionDirectory(sessionID)
    : undefined
  return resolveSpawnCwdFrom(
    configured,
    process.cwd(),
    opencodeProjectDirectory,
    sessionDir,
  )
}

/**
 * Fetch an opencode session's project directory via `GET /session/{id}`.
 * Returns `undefined` on any failure (no client, "default"/empty id,
 * rejected call, malformed response, unusable directory) so callers fall
 * back to `process.cwd()`-based resolution. No caching: a session's
 * directory can change (workspace switch) and the call is a cheap
 * localhost round-trip relative to spawning Claude.
 */
export async function fetchSessionDirectory(
  sessionID: string,
): Promise<string | undefined> {
  if (!sessionID || sessionID === "default") return undefined
  const client = opencodeClient
  if (!client?.session?.get) return undefined
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const dir = (data as { directory?: unknown }).directory
    return isUsableDirectory(dir) ? dir : undefined
  } catch (err) {
    log.warn("failed to fetch opencode session directory", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * The id of the session that spawned this one, or undefined when it is a
 * top-level session (or the lookup is unavailable). Read off the same
 * `GET /session/{id}` response `fetchSessionDirectory` uses, kept separate
 * because the two are needed at different points in a turn.
 *
 * Account failover is the only caller: a subagent must never be shown the
 * switch form. It follows its parent's account for free, because the override
 * is scoped to the account rather than the session.
 */
export async function fetchSessionParentId(
  sessionID: string,
): Promise<string | undefined> {
  if (!sessionID || sessionID === "default") return undefined
  const client = opencodeClient
  if (!client?.session?.get) return undefined
  try {
    const res = await client.session.get({ path: { id: sessionID } })
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const parentID = (data as { parentID?: unknown }).parentID
    return typeof parentID === "string" && parentID.length > 0
      ? parentID
      : undefined
  } catch (err) {
    log.warn("failed to fetch opencode session parent", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/** Whether a session is a subagent's, per session id; a parent never changes. */
const childSessionAnswers = new Map<string, boolean>()
const MAX_CHILD_SESSION_ANSWERS = 256

/**
 * Whether `sessionID` is a child (subagent) session, asked once per session per
 * process and without waiting: the returned function reads `undefined` until
 * opencode has answered, which a caller must treat as "do not speak". For a
 * decision made inside a synchronous handler long after the prologue started
 * the lookup (the usage note, h #g244), so an ordinary turn neither waits on
 * the lookup nor repeats it. `"default"` has no session and is not a child.
 */
export function watchChildSession(sessionID: string): () => boolean | undefined {
  if (!sessionID || sessionID === "default") return () => false
  const known = childSessionAnswers.get(sessionID)
  if (known !== undefined) return () => known
  let answer: boolean | undefined
  void fetchSessionParentId(sessionID).then((parentID) => {
    answer = !!parentID
    if (childSessionAnswers.size >= MAX_CHILD_SESSION_ANSWERS) childSessionAnswers.clear()
    childSessionAnswers.set(sessionID, answer)
  })
  return () => answer
}

export type SessionRunState = "busy" | "idle" | "unknown"

/**
 * opencode 2 gives a plugin no run-state route (`session.active` is not in the
 * `SessionDomain` `Pick` it hands over, h #g176), but the event stream every
 * plugin can subscribe to brackets each execution: `session.execution.started`,
 * then `succeeded`, `failed` or `interrupted`. Measured on 2.0.31 (h #g253)
 * against `GET /api/session/active`: the two agree through a 15-second
 * permission hold and an 8-second tool run, which is exactly the window the
 * proxy deadline guard has to see as busy. `session.status` and `session.idle`
 * are in its generated types but were never emitted there; they are read too,
 * and nothing depends on them.
 *
 * Fed only by the V2 entry's subscription, so on opencode 1 this is never
 * consulted (its client has the status route) and never filled.
 */
const eventRunStates = new Map<string, "busy" | "idle">()
const MAX_EVENT_RUN_STATES = 512
let openEventFeeds = 0

/**
 * Declare an event subscription that will call `noteSessionRunEvent`. The
 * returned function closes it, and closing ANY feed forgets everything: a
 * subscription that ended can have missed the event that would have ended a
 * busy session, and a stale `busy` would keep a dead proxy call alive past its
 * deadline. `unknown` is what every caller already treats as "do not act".
 */
export function openSessionRunEventFeed(): () => void {
  openEventFeeds += 1
  let closed = false
  return () => {
    if (closed) return
    closed = true
    openEventFeeds = Math.max(0, openEventFeeds - 1)
    eventRunStates.clear()
  }
}

/** Fold one opencode 2 bus event into the run-state map. Ignores everything else. */
export function noteSessionRunEvent(event: unknown): void {
  if (openEventFeeds === 0 || !event || typeof event !== "object") return
  const { type, data } = event as { type?: unknown; data?: unknown }
  if (typeof type !== "string" || !data || typeof data !== "object") return
  const sessionID = (data as { sessionID?: unknown }).sessionID
  if (typeof sessionID !== "string" || !sessionID || sessionID === "default") return
  if (type === "session.deleted") {
    eventRunStates.delete(sessionID)
    return
  }
  let next: "busy" | "idle" | undefined
  switch (type) {
    case "session.execution.started":
      next = "busy"
      break
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.idle":
      next = "idle"
      break
    case "session.status": {
      const status = (data as { status?: { type?: unknown } }).status?.type
      // The same reading opencode 1's status map gets: anything but idle is a
      // turn still running, a `retry` included.
      if (typeof status === "string") next = status === "idle" ? "idle" : "busy"
      break
    }
  }
  if (!next) return
  eventRunStates.delete(sessionID)
  eventRunStates.set(sessionID, next)
  while (eventRunStates.size > MAX_EVENT_RUN_STATES) {
    const oldest = eventRunStates.keys().next().value
    if (oldest === undefined) break
    eventRunStates.delete(oldest)
  }
}

/**
 * The run state the event stream reported, or `unknown` when no feed is open
 * or this session has not been seen since it opened. A session that started
 * before the plugin subscribed stays `unknown` until its next execution.
 */
export function sessionRunStateFromEvents(sessionID: string): SessionRunState {
  if (openEventFeeds === 0) return "unknown"
  return eventRunStates.get(sessionID) ?? "unknown"
}

/**
 * Every session the event stream reports running, in opencode 1's
 * `GET /session/status` shape (a session missing from it is idle), or
 * undefined when no feed is open and nothing can be said. `/btw` reads it.
 */
export function busySessionsFromEvents(): Record<string, { type: "busy" }> | undefined {
  if (openEventFeeds === 0) return undefined
  const busy: Record<string, { type: "busy" }> = {}
  for (const [sessionID, state] of eventRunStates) {
    if (state === "busy") busy[sessionID] = { type: "busy" }
  }
  return busy
}

/** Test seam: no feeds, nothing remembered. */
export function _resetSessionRunEventsForTests(): void {
  openEventFeeds = 0
  eventRunStates.clear()
}

/**
 * Whether opencode still considers this session to be running a turn.
 * `unknown` when there is no client or the route is missing, which every
 * caller must treat as "do not act": a wrong guess here is worse than no
 * answer. On opencode 2, which has no route, the event stream answers instead
 * whenever it can (`sessionRunStateFromEvents`).
 */
export async function fetchSessionRunState(
  sessionID: string,
  directory?: string,
): Promise<SessionRunState> {
  if (!sessionID || sessionID === "default") return "unknown"
  const status = opencodeClient?.session?.status
  if (!status) return sessionRunStateFromEvents(sessionID)
  try {
    // opencode keeps one status map per workspace directory, and the client
    // the plugin holds is scoped to whichever directory loaded it last. Asked
    // without a directory, a session running in any other workspace is absent
    // from the map and reads as `idle`, which releases its parked proxy calls
    // (measured on 1.18.32: five busy sessions, an empty unscoped map). So ask
    // for the session's own directory. `""` means the caller already looked
    // and found none.
    const dir = directory ?? (await fetchSessionDirectory(sessionID))
    const res = await status.call(
      opencodeClient!.session,
      dir ? { query: { directory: dir } } : undefined,
    )
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return "unknown"
    const entry = (data as Record<string, unknown>)[sessionID]
    if (!entry || typeof entry !== "object") return "idle"
    const type = (entry as { type?: unknown }).type
    return type === "idle" ? "idle" : "busy"
  } catch (err) {
    log.debug("failed to read opencode session status", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return "unknown"
  }
}

/**
 * The session's run state, given a moment to settle. opencode 1.18.32 aborts
 * the provider signal of every step that ends in tool calls, roughly a second
 * after the finish, while it runs the tool; that looks exactly like an
 * operator abort at the signal. The session stays busy through the tool run
 * and goes idle when the turn really stops, so one `busy` reading inside the
 * window is enough to tell them apart, and the poll exists because an abort
 * can arrive before opencode has updated the map.
 */
export async function settleSessionRunState(
  sessionID: string,
  options: { pollMs?: number; windowMs?: number; directory?: string } = {},
): Promise<SessionRunState> {
  const pollMs = options.pollMs ?? 150
  const windowMs = options.windowMs ?? 1_500
  const started = Date.now()
  let last: SessionRunState = "unknown"
  // Looked up once and kept; a lookup that failed is retried on the next
  // poll, so one transient failure does not leave the window unscoped.
  let directory = options.directory
  for (;;) {
    directory ??= await fetchSessionDirectory(sessionID)
    const state = await fetchSessionRunState(sessionID, directory ?? "")
    if (state === "busy") return "busy"
    if (state !== "unknown") last = state
    if (Date.now() - started >= windowMs) return last
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * How long a turn will wait for servers the host reports as `pending` before
 * it plans the spawn anyway. Only opencode 2 ever reports that status, so on
 * opencode 1 this costs exactly nothing: its `GET /mcp` already blocks until
 * every server has reached a decision, which is the behaviour this budget
 * reproduces on the host that does not.
 *
 * Three seconds is the measured shape of the problem rather than a guess: a
 * local stdio server on this machine reaches `connected` in well under a
 * second, and the budget only has to outlast a process start. A server that
 * is slower than this is not lost, it joins through the hot reload on the
 * next turn; the budget decides how often that second spawn is needed.
 */
export const DEFAULT_MCP_CONNECT_WAIT_MS = 3000

/** How often the wait re-reads the host's status while something is pending. */
const MCP_CONNECT_POLL_MS = 100

/**
 * `mcpConnectWaitMs`, with `0` meaning "do not wait" and anything unusable
 * (negative, NaN, not a number) falling back to the default rather than
 * silently disabling the wait.
 */
export function resolveMcpConnectWaitMs(configured: unknown): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_MCP_CONNECT_WAIT_MS
  }
  if (configured < 0) return DEFAULT_MCP_CONNECT_WAIT_MS
  return configured
}

/** Server names the host says it is still connecting to. */
export function pendingMcpServers(status: RuntimeMcpStatus): string[] {
  return Object.keys(status).filter(
    (name) => status[name] === MCP_PENDING_STATUS,
  )
}

async function fetchRuntimeMcpStatus(): Promise<RuntimeMcpStatus | undefined> {
  const client = opencodeClient
  if (!client?.mcp?.status) return undefined
  try {
    const res = await client.mcp.status()
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const out: RuntimeMcpStatus = {}
    for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        const status = (entry as { status?: unknown }).status
        if (typeof status === "string") out[name] = status
      }
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode MCP runtime status", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * Snapshot opencode's current MCP runtime status so the bridge can overlay
 * UI-toggled state on top of disk config. Returns `undefined` on any
 * failure (no client captured, status call rejected, malformed response)
 * so the bridge falls back to disk-only.
 *
 * `waitForPendingMs` gives servers the host reports as `pending` a bounded
 * moment to reach a decision. Nothing is pending on an ordinary turn, so the
 * wait costs one status call exactly as before; it only engages while a
 * conversation's first turn races the host's own MCP startup.
 *
 * `signal` ends that wait early. It is the turn's own abort signal: a stopped
 * turn plans no spawn, so holding a 100 ms poll timer open for up to three
 * seconds after the operator pressed stop is pure delay. The snapshot already
 * in hand is returned, exactly as a status call that stops answering does.
 */
export async function getRuntimeMcpStatus(
  options: { waitForPendingMs?: number; signal?: AbortSignal } = {},
): Promise<RuntimeMcpStatus | undefined> {
  const current = await fetchRuntimeMcpStatus()
  const budgetMs = options.waitForPendingMs ?? 0
  if (!current || budgetMs <= 0) return current
  return waitForPendingMcpServers(current, budgetMs, options.signal)
}

async function waitForPendingMcpServers(
  first: RuntimeMcpStatus,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<RuntimeMcpStatus> {
  let current = first
  const waitedFor = pendingMcpServers(current)
  if (waitedFor.length === 0) return current

  const started = Date.now()
  for (;;) {
    if (Date.now() - started >= budgetMs) break
    if (signal?.aborted) break
    await new Promise((resolve) => setTimeout(resolve, MCP_CONNECT_POLL_MS))
    if (signal?.aborted) break
    // A status call that stops answering mid-wait is not a reason to throw
    // away the snapshot we already have: keep it and plan the spawn.
    const next = await fetchRuntimeMcpStatus()
    if (!next) break
    current = next
    if (pendingMcpServers(current).length === 0) break
  }

  const stillPending = pendingMcpServers(current)
  log.info("waited for opencode MCP servers to finish connecting", {
    waitedFor,
    stillPending,
    budgetMs,
    elapsedMs: Date.now() - started,
    aborted: signal?.aborted === true,
  })
  return current
}

export interface OpencodeToolListItem {
  id: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Fetch opencode's full tool catalog (built-ins + MCP-bridged) with JSON
 * Schema parameters via `client.tool.list()`. The provider/model query
 * narrows the schema variants opencode returns; in practice MCP-origin
 * tool schemas are model-agnostic, so any registered (provider, model)
 * works as the query target. Returns `undefined` on any failure so callers
 * can fall back to direct-bridge behavior.
 */
export async function fetchOpencodeToolList(
  provider: string,
  model: string,
  directory?: string,
): Promise<OpencodeToolListItem[] | undefined> {
  const client = opencodeClient
  if (!client?.tool?.list) return undefined
  try {
    const res = await client.tool.list({
      query: { provider, model, ...(directory ? { directory } : {}) },
    })
    const data = (res as { data?: unknown }).data
    if (!Array.isArray(data)) return undefined
    const out: OpencodeToolListItem[] = []
    for (const entry of data as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : null
      const description =
        typeof e.description === "string" ? e.description : ""
      const parameters =
        e.parameters && typeof e.parameters === "object"
          ? (e.parameters as Record<string, unknown>)
          : {}
      if (!id) continue
      out.push({ id, description, parameters })
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode tool list", {
      provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * One assistant reply in an opencode session, flattened to what a background
 * collect needs: whether it finished, whether it failed, and its text.
 */
export interface SessionReply {
  role: string
  completed: boolean
  error: string | undefined
  text: string
}

/**
 * An opencode session's transcript via `GET /session/{id}/message`, flattened.
 * Returns `undefined` on any failure (no client, missing route, rejected call,
 * malformed response) so every caller keeps its no-client path. Deliberately
 * keeps only role, completion, error and text: a background collect reports a
 * subagent's answer, never its tool inputs, which can be whole files.
 */
export async function fetchSessionReplies(
  sessionID: string,
): Promise<SessionReply[] | undefined> {
  if (!sessionID || sessionID === "default") return undefined
  const client = opencodeClient
  if (!client?.session?.messages) return undefined
  try {
    const res = await client.session.messages({ path: { id: sessionID } })
    const data = (res as { data?: unknown }).data
    if (!Array.isArray(data)) return undefined
    const out: SessionReply[] = []
    for (const entry of data as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const info = (entry as { info?: unknown }).info
      if (!info || typeof info !== "object") continue
      const record = info as {
        role?: unknown
        time?: { completed?: unknown }
        error?: { name?: unknown; data?: { message?: unknown } }
      }
      const parts = (entry as { parts?: unknown }).parts
      const text = Array.isArray(parts)
        ? (parts as unknown[])
            .flatMap((part) => {
              if (!part || typeof part !== "object") return []
              const p = part as { type?: unknown; text?: unknown; synthetic?: unknown }
              if (p.type !== "text" || typeof p.text !== "string") return []
              return p.synthetic === true ? [] : [p.text]
            })
            .join("\n")
            .trim()
        : ""
      const error = record.error
      const message =
        error && typeof error === "object"
          ? typeof error.data?.message === "string"
            ? error.data.message
            : typeof error.name === "string"
              ? error.name
              : undefined
          : undefined
      out.push({
        role: typeof record.role === "string" ? record.role : "",
        completed: typeof record.time?.completed === "number",
        error: message,
        text,
      })
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode session messages", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

/**
 * Stop whatever an opencode session is running, via `POST /session/{id}/abort`.
 * Returns false when there is no client, the route is missing, or the call
 * threw: a cancel that did not happen must never read as one that did.
 *
 * Both majors answer with a boolean saying whether anything was stopped (V1's
 * route is documented `200: boolean`; V2's `session.interrupt` returns
 * `{ interrupted: boolean }`, which the V2 client shim puts in the same slot),
 * so an explicit `false` is reported as a refused cancel. Anything else,
 * including a build that answers with no body at all, keeps the old
 * "it did not throw, so it happened" reading.
 */
export async function abortSession(sessionID: string): Promise<boolean> {
  if (!sessionID || sessionID === "default") return false
  const client = opencodeClient
  if (!client?.session?.abort) return false
  try {
    const res = await client.session.abort({ path: { id: sessionID } })
    return (res as { data?: unknown }).data !== false
  } catch (err) {
    log.warn("failed to abort opencode session", {
      sessionID,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
