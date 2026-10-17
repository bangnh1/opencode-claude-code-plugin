/**
 * The model behind the sidebar's progress lines (`src/tui.ts`, h #g246): one
 * for the session on screen, under a `Progress` heading above `Subagents`, and
 * one under each RUNNING subagent row:
 *
 *     Progress
 *     ⠋ ▰▰▰▰▰▱▱▱▱▱ 2/4 · 1m03s · bash
 *     Subagents
 *     ⠋ implementor Fix the dispatch form…
 *       sonnet-5.5 · high · alpha        $0.42
 *       ▰▰▰▱▱▱▱▱▱▱ 45s · 12 calls · read
 *
 * Everything on the line is measured; nothing is estimated:
 *
 *   - With a todo list the bar is the fraction of items completed and the
 *     line says which, `2/4`. opencode 1.x's TUI store holds every session's
 *     list (the CLI's TaskCreate family reaches it as `todowrite`, h #g85);
 *     opencode 2.x exposes none to a TUI plugin, so there every line is the
 *     next kind. A bar is never full before the last item is done and never
 *     empty once the first is.
 *   - Without one the bar is a pulse, `PULSE_RUN` cells sweeping the track,
 *     because nothing known predicts how much is left. The prompt, the model,
 *     the effort and the token count are deliberately not inputs: a bar fed by
 *     them would be a guess drawn as a measurement.
 *   - The rest is the turn's own record: elapsed since the last user message
 *     (else since the TUI first saw the session busy), the tool calls made
 *     since it, and the tool running now.
 *   - A turn that ended lingers `PROGRESS_LINGER_MS` with its final state, the
 *     bar filled and ✓ or ✗ off the last reply's error, then the line leaves.
 *     A subagent row's line leaves with the row's spinner.
 *
 * Pure, like `src/subagent-sidebar.ts` and for the same reason: the TUI bundle
 * runs on the terminal's own thread, where a logger writes over the interface
 * (h #g193). It imports only that module's text helpers.
 */
import {
  SIDEBAR_ROW_WIDTH,
  SPINNER_FRAMES,
  truncate,
  type ChildRunState,
  type Segment,
} from "./subagent-sidebar.js"

/** The bar's width in cells, and how many of them a pulse lights. */
export const BAR_WIDTH = 10
export const PULSE_RUN = 3
/** How long a finished turn's line stays, showing its final state. */
export const PROGRESS_LINGER_MS = 15_000
export const BAR_DONE = "▰"
export const BAR_TODO = "▱"

export interface ProgressToolCall {
  name?: string
  status?: string
}

export interface ProgressMessage {
  role: string
  created?: number
  /** The message ended in an error (an assistant message's `error`). */
  error?: boolean
  /** The message's tool calls, in order. */
  tools: ProgressToolCall[]
}

export interface ProgressTodo {
  status?: string
}

/** What a session's own store holds that its progress line is measured from. */
export interface ProgressSource {
  messages: ProgressMessage[]
  todos: ProgressTodo[]
}

export interface ProgressPlan {
  done: number
  total: number
}

export interface ProgressMeasure {
  /** The todo list's completed count over its total; absent without a list. */
  plan?: ProgressPlan
  /** The last user message's time, which is when the turn started. */
  startedAt?: number
  /** Tool calls since that message. */
  calls: number
  /** The tool running now, if one is. */
  tool?: string
  /** The newest reply since that message ended in an error. */
  failed: boolean
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function cells(value: string): number {
  return Array.from(value).length
}

/**
 * The messages a line is measured from: the last user message and everything
 * after it, all of them when there is none. A host hands `measureProgress`
 * only these, so it reads the tool parts of the turn on screen and a long
 * session's earlier messages cost nothing per tick.
 */
export function turnMessages<T>(messages: readonly T[], isUser: (message: T) => boolean): readonly T[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isUser(messages[index])) return index === 0 ? messages : messages.slice(index)
  }
  return messages
}

/**
 * The facts a line is built from. The turn is everything after the last user
 * message (all of it when there is none); the tool running now is the newest
 * call only while it is still pending or running; a todo marked `cancelled`
 * is not part of the plan.
 */
export function measureProgress(source: ProgressSource): ProgressMeasure {
  const messages = source.messages
  let turnStart = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      turnStart = index
      break
    }
  }
  let calls = 0
  let tool: string | undefined
  let failed = false
  for (let index = turnStart + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    failed = message.error === true
    for (const call of message.tools) {
      calls += 1
      const running = call.status === "running" || call.status === "pending"
      tool = running ? text(call.name) : undefined
    }
  }
  let total = 0
  let done = 0
  for (const todo of source.todos) {
    if (todo.status === "cancelled") continue
    total += 1
    if (todo.status === "completed") done += 1
  }
  return {
    plan: total > 0 ? { done, total } : undefined,
    startedAt: turnStart >= 0 ? messages[turnStart].created : undefined,
    calls,
    tool,
    failed,
  }
}

/** One line, ready to lay out. */
export interface ProgressView {
  state: "running" | "done" | "error"
  /** Whether the pulse moves: the session is busy right now. */
  animate: boolean
  plan?: ProgressPlan
  elapsedMs: number
  calls: number
  tool?: string
}

/**
 * The line for the session on screen. Running while opencode reports the
 * session busy; after it stopped, its final state for `PROGRESS_LINGER_MS`
 * from the stop; otherwise nothing. A stop older than the turn's own start is
 * an earlier turn's and shows nothing either.
 */
export function sessionProgress(
  measure: ProgressMeasure,
  input: { status: ChildRunState; busySince?: number; stoppedAt?: number; now: number },
): ProgressView | undefined {
  const startedAt = measure.startedAt ?? input.busySince
  if (input.status === "busy") {
    return {
      state: "running",
      animate: true,
      plan: measure.plan,
      elapsedMs: Math.max(0, input.now - (startedAt ?? input.now)),
      calls: measure.calls,
      tool: measure.tool,
    }
  }
  if (input.stoppedAt === undefined) return undefined
  if (startedAt !== undefined && input.stoppedAt < startedAt) return undefined
  if (input.now - input.stoppedAt > PROGRESS_LINGER_MS) return undefined
  return {
    state: measure.failed ? "error" : "done",
    animate: false,
    plan: measure.plan,
    elapsedMs: Math.max(0, input.stoppedAt - (startedAt ?? input.stoppedAt)),
    calls: measure.calls,
    tool: undefined,
  }
}

/**
 * The line under a running subagent row. The row's own state says it runs;
 * the pulse moves only while opencode reports the child busy (a background
 * child inside `STARTING_GRACE_MS` reads idle), and the turn's start falls
 * back to the row's, which is the dispatch.
 */
export function rowProgress(
  measure: ProgressMeasure,
  input: { started: number; status: ChildRunState; now: number },
): ProgressView {
  const startedAt = measure.startedAt ?? input.started
  return {
    state: "running",
    animate: input.status === "busy",
    plan: measure.plan,
    elapsedMs: Math.max(0, input.now - startedAt),
    calls: measure.calls,
    tool: measure.tool,
  }
}

/** What the TUI remembers about a session's status, for the two inputs no store carries. */
export interface StatusMemory {
  /** When the TUI first saw the session busy, this run. */
  busySince?: number
  /** When the TUI saw it go idle after that. */
  stoppedAt?: number
}

/** How many sessions the watch remembers; the oldest observed is forgotten first. */
export const STATUS_WATCH_CAP = 256

/**
 * Status transitions as the TUI observes them. Busy after anything else dates
 * the run and forgets the earlier stop; idle after busy dates the stop; an
 * unchanged status, and `unknown`, change nothing. Both dates are kept until
 * the next run starts, which is what lets a finished line linger.
 */
export function createStatusWatch() {
  const seen = new Map<string, { status: ChildRunState } & StatusMemory>()
  return {
    observe(sessionID: string, status: ChildRunState, now: number): StatusMemory {
      let entry = seen.get(sessionID)
      if (!entry) {
        entry = { status: "unknown" }
        if (seen.size >= STATUS_WATCH_CAP) {
          const oldest = seen.keys().next().value
          if (oldest !== undefined) seen.delete(oldest)
        }
        seen.set(sessionID, entry)
      }
      if (status === "busy" && entry.status !== "busy") {
        entry.busySince = now
        entry.stoppedAt = undefined
      } else if (status === "idle" && entry.status === "busy") {
        entry.stoppedAt = now
      }
      if (status !== "unknown") entry.status = status
      return { busySince: entry.busySince, stoppedAt: entry.stoppedAt }
    },
  }
}

/**
 * How many cells a plan fills: proportional and rounded, but never the whole
 * bar before the last item is done and never none once the first is, so the
 * bar can only say "finished" when the list does.
 */
export function filledCells(plan: ProgressPlan, width: number = BAR_WIDTH): number {
  if (plan.total <= 0 || plan.done <= 0) return 0
  if (plan.done >= plan.total) return width
  return Math.min(width - 1, Math.max(1, Math.round((plan.done / plan.total) * width)))
}

/** Whether `cell` is lit by a pulse at `position`: a run of `PULSE_RUN` cells that wraps round the end. */
export function pulseLit(position: number, cell: number, width: number = BAR_WIDTH): boolean {
  const start = ((position % width) + width) % width
  return (cell - start + width) % width < PULSE_RUN
}

/** `12s`, `1m03s`, `1h02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const pad = (value: number) => String(value).padStart(2, "0")
  if (minutes < 60) return `${minutes}m${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}m`
}

/** The three runs of one line: what leads it, the bar's cells (one segment each), the rest. */
export interface ProgressLayout {
  lead: Segment[]
  bar: Segment[]
  tail: Segment[]
}

/**
 * One line laid out for `width` cells:
 *
 *     ⠋ ▰▰▰▰▰▱▱▱▱▱ 2/4 · 1m03s · bash        (lead "glyph": the session's own)
 *       ▰▰▰▱▱▱▱▱▱▱ 45s · 12 calls · read     (lead "indent": under a row)
 *
 * The bar is one segment per cell so a renderer can animate the pulse cell by
 * cell. With a plan the fraction takes the call count's place. When the line
 * is too wide the call count goes first, then the tool's name is cut, then
 * the tool goes. An ended line keeps no tool: nothing runs.
 */
export function layoutProgressLine(
  view: ProgressView,
  lead: "glyph" | "indent",
  width: number = SIDEBAR_ROW_WIDTH,
  frame = 0,
  pulse = 0,
): ProgressLayout {
  const ended = view.state !== "running"
  const endedRole: Segment["role"] = view.state === "error" ? "error" : "done"
  const leadSegments: Segment[] =
    lead === "indent"
      ? [{ text: "  ", role: "muted" }]
      : [
          view.state === "running"
            ? { text: SPINNER_FRAMES[frame % SPINNER_FRAMES.length], role: "spinner" }
            : { text: view.state === "done" ? "✓" : "✗", role: endedRole },
          { text: " ", role: "muted" },
        ]
  const filled = view.plan ? filledCells(view.plan) : undefined
  const litRole: Segment["role"] = ended ? endedRole : view.plan ? "bar-done" : "bar-pulse"
  const bar: Segment[] = []
  for (let cell = 0; cell < BAR_WIDTH; cell += 1) {
    const lit = filled !== undefined ? cell < filled : ended ? true : pulseLit(pulse, cell)
    bar.push(lit ? { text: BAR_DONE, role: litRole } : { text: BAR_TODO, role: "bar-track" })
  }

  const required: Segment[] = []
  if (view.plan) {
    required.push({ text: `${view.plan.done}/${view.plan.total}`, role: ended ? "muted" : "fraction" })
  }
  required.push({ text: formatElapsed(view.elapsedMs), role: "muted" })
  const calls: Segment | undefined =
    !view.plan && view.calls > 0
      ? { text: `${view.calls} call${view.calls === 1 ? "" : "s"}`, role: "muted" }
      : undefined
  const tool: Segment | undefined = !ended && view.tool ? { text: view.tool, role: "tool" } : undefined
  const budget = width - leadSegments.reduce((sum, segment) => sum + cells(segment.text), 0) - BAR_WIDTH - 1
  const widthOf = (pieces: Segment[]) =>
    pieces.reduce((sum, piece) => sum + cells(piece.text), 0) + 3 * Math.max(0, pieces.length - 1)
  let pieces = [...required, ...(calls ? [calls] : []), ...(tool ? [tool] : [])]
  if (widthOf(pieces) > budget && calls) pieces = [...required, ...(tool ? [tool] : [])]
  if (widthOf(pieces) > budget && tool) {
    const room = budget - widthOf(required) - 3
    pieces = room >= 2 ? [...required, { text: truncate(tool.text, room), role: "tool" }] : required
  }
  const tail: Segment[] = [{ text: " ", role: "muted" }]
  pieces.forEach((piece, index) => {
    if (index > 0) tail.push({ text: " · ", role: "muted" })
    tail.push(piece)
  })
  return { lead: leadSegments, bar, tail }
}

/** The plain text of a laid-out line, for tests. */
export function progressLineText(layout: ProgressLayout): string {
  return [...layout.lead, ...layout.bar, ...layout.tail].map((segment) => segment.text).join("")
}
