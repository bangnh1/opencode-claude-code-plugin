/**
 * How long a turn usually takes, for the sidebar's progress bar (h #g247):
 * one sample per finished turn, keyed by the agent and the model it ran as,
 * written by the server half at the CLI's `result` and read by the TUI half
 * (`src/tui.ts`), plus the estimate the bar is drawn from.
 *
 * ## What is estimated, and how
 *
 * A turn's length is not knowable up front: it depends on what the tools
 * return, which has not happened yet. What IS known is how long turns like
 * it took before, so the bar is drawn from this install's own record. The
 * key is the agent and the model, the two inputs that move a duration most;
 * the prompt's length and the effort ride on the sample and weight it.
 *
 * At elapsed `t` the estimate is the weighted median residual life: over the
 * recorded turns that lasted LONGER than `t` and made at least as many tool
 * calls as this turn has so far (the ones this turn can still be like), the
 * weighted median of what remained of them at `t`. The total is `t` plus
 * that, and the bar is `t` over the total. Conditioning on survival is what
 * keeps the bar honest once a turn runs long: the total rises with `t`
 * instead of the bar sitting full, and a turn on its twelfth call is not
 * expected to end like the two-call ones (h #g250). The weights prefer turns
 * that started like this one: a Gaussian kernel on the log of the prompt's
 * length (`CHARS_BANDWIDTH`, so a prompt four times longer or shorter still
 * weighs e^-1/2, sixteen times e^-2), and `OTHER_EFFORT_WEIGHT` for a turn
 * at another effort. Effort multiplies the thinking a turn does rather than
 * labelling it, so once a key holds `MIN_EFFORT_RATIO_SAMPLES` turns at this
 * effort and as many at another, the other effort's durations are scaled by
 * the ratio of the two groups' weighted medians before they are conditioned
 * on (h #g250): a key full of `low` turns then still says something about a
 * `high` one. Past every recorded turn, in time or in calls, there is
 * nothing left to condition on, and the estimate says so (`over`): the bar
 * is full, drawn in the warning colour, and the total shown is the usual
 * one, the weighted median of every sample.
 *
 * Fewer than `MIN_TURN_SAMPLES` samples is no estimate at all, and the line
 * then draws no bar rather than a guess. The first turns of a new agent or
 * model show the spinner, the elapsed, the calls and the tool.
 *
 * ## The store
 *
 * ```json
 * { "version": 1, "turns": { "build/claude-opus-5-5": [
 *     { "ms": 61230, "chars": 420, "effort": "high", "calls": 3, "at": 1760000000000 } ] } }
 * ```
 *
 * A duration, a character count, an effort level, a tool-call count and a
 * time: no prompt text, no path, no session id, nothing secret. Same discipline as the spawn
 * record store (h #g234): merge-on-write so two opencode processes do not
 * erase each other, atomic rename, `0600` in the `0700` directory, bounded
 * at `MAX_TURN_SAMPLES` newest samples per key, `MAX_TURN_KEYS` keys and
 * `TURN_SAMPLE_MAX_AGE_MS`. A missing, unreadable or half-written file is
 * an empty store, which costs a bar and nothing else.
 *
 * Imports nothing that logs, because the TUI bundle reads it on the
 * terminal's own thread (h #g193): every function here is silent and never
 * throws.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface TurnSample {
  /** How long the turn took, from the prompt reaching the provider to the CLI's `result`. */
  ms: number
  /** The prompt's length in characters, the host's injected blocks taken off; absent when unknown. */
  chars?: number
  effort?: string
  /** Tool calls the turn made, counted as the TUI counts a turn's tool parts; absent on a sample from before 0.57.2. */
  calls?: number
  at: number
}

/** Samples per key, oldest first. */
export type TurnHistory = Map<string, TurnSample[]>

/** Samples kept per agent and model: enough for a median, few enough to read every tick. */
export const MAX_TURN_SAMPLES = 48
/** Agent and model pairs kept at once. */
export const MAX_TURN_KEYS = 64
/** A turn older than this says little about how the agent runs now. */
export const TURN_SAMPLE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** Fewer samples than this is no estimate. */
export const MIN_TURN_SAMPLES = 3
/** The prompt-length kernel's bandwidth, in log-length: a factor of four is one standard deviation. */
export const CHARS_BANDWIDTH = Math.log(4)
/** What a sample at another effort weighs against one at the same. */
export const OTHER_EFFORT_WEIGHT = 0.5
/** Turns at each of two efforts before the ratio of their durations is measured and the other effort's scaled by it. */
export const MIN_EFFORT_RATIO_SAMPLES = 2
/** Added to both lengths before the log, so a one-word prompt is not infinitely far from an empty one. */
const CHARS_FLOOR = 50

let pathOverride: string | null = null

export function turnHistoryStorePath(): string {
  if (pathOverride) return pathOverride
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(stateRoot, "opencode-claude-code-plugin", "turn-history.json")
}

/** The key a turn's samples live under: the agent it ran as and the model, `build/claude-opus-5-5`. */
export function turnHistoryKey(agent: string | undefined, model: string): string {
  return `${agent || "main"}/${model}`
}

// ---------------------------------------------------------------------------
// The prompt's length, counted the same on both halves
// ---------------------------------------------------------------------------

const INJECTED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>/g,
  /<dcp-message-id>[\s\S]*?<\/dcp-message-id>/g,
]

/**
 * How long a prompt is, in characters, with the blocks a host injects at
 * provider time taken off (opencode's `<system-reminder>`, opencode-dcp's
 * reminder and its message id): the TUI counts the stored message and the
 * server the forwarded one, and the kernel needs both to count the same
 * text. `undefined` for no text at all, which is "unknown", never zero.
 */
export function promptChars(texts: readonly string[]): number | undefined {
  if (texts.length === 0) return undefined
  let total = 0
  for (const text of texts) {
    let stripped = text
    for (const block of INJECTED_BLOCKS) stripped = stripped.replace(block, "")
    total += stripped.trim().length
  }
  return total
}

interface PromptMessageLike {
  role: string
  content: unknown
}

function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text") continue
    const text = (part as { text?: unknown }).text
    if (typeof text === "string") texts.push(text)
  }
  return texts
}

/** The newest user message's length: the one this turn answers. */
export function newestPromptChars(prompt: readonly PromptMessageLike[]): number | undefined {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index].role === "user") return promptChars(textsOf(prompt[index].content))
  }
  return undefined
}

/**
 * Whether a prompt STARTS a turn: it ends in a user message that does not
 * follow a tool result. A tool-result prompt continues the turn that made
 * the call, and so does a user message the host promoted beside one (h #g204).
 */
export function startsTurn(prompt: readonly PromptMessageLike[]): boolean {
  const last = prompt[prompt.length - 1]
  if (!last || last.role !== "user") return false
  const before = prompt[prompt.length - 2]
  return before === undefined || before.role !== "tool"
}

/**
 * How many tool calls the turn a prompt continues has made so far: the
 * `tool-call` parts of the assistant messages since the message that started
 * it (the last user message not following a tool result, `startsTurn`'s
 * rule, so a message the host steered in mid-turn does not restart the
 * count). Every proxied and CLI-executed call the plugin emitted in an
 * earlier step is one of them, because opencode stores each as a tool part
 * and hands them back here; the step that sees the `result` adds its own
 * emitted calls, which are not in its prompt yet. That is the count the TUI
 * reads off the turn's tool parts (`measureProgress`), which is what lets the
 * estimate condition on it mid-turn (h #g250).
 */
export function turnToolCalls(prompt: readonly PromptMessageLike[]): number {
  let start = 0
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    if (prompt[index].role !== "user") continue
    const before = prompt[index - 1]
    if (before === undefined || before.role !== "tool") {
      start = index
      break
    }
  }
  let calls = 0
  for (let index = start; index < prompt.length; index += 1) {
    const message = prompt[index]
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "tool-call") calls += 1
    }
  }
  return calls
}

// ---------------------------------------------------------------------------
// When a turn started, held from its first step to its result
// ---------------------------------------------------------------------------

const MAX_TURN_STARTS = 256
const turnStarts = new Map<string, { at: number; chars?: number }>()

/**
 * Note that a turn on `key` started at `at`. A turn is a run of steps (every
 * proxied tool call ends one), and only its last step sees the `result`, so
 * the start waits here, keyed like the process, until `takeTurnStart`. A
 * turn that never reaches a result leaves its start to be overwritten by
 * the key's next one.
 */
export function markTurnStart(key: string, at: number, chars?: number): void {
  turnStarts.delete(key)
  if (turnStarts.size >= MAX_TURN_STARTS) {
    const oldest = turnStarts.keys().next().value
    if (oldest !== undefined) turnStarts.delete(oldest)
  }
  turnStarts.set(key, { at, ...(chars !== undefined ? { chars } : {}) })
}

/** The start noted for `key`, once: a second `result` in the same turn finds nothing. */
export function takeTurnStart(key: string): { at: number; chars?: number } | undefined {
  const start = turnStarts.get(key)
  turnStarts.delete(key)
  return start
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

function isSample(value: unknown): value is TurnSample {
  const sample = value as TurnSample | null
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) return false
  if (typeof sample.ms !== "number" || !Number.isFinite(sample.ms) || sample.ms < 0) return false
  if (typeof sample.at !== "number" || !Number.isFinite(sample.at)) return false
  if (sample.chars !== undefined && (typeof sample.chars !== "number" || !Number.isFinite(sample.chars) || sample.chars < 0)) {
    return false
  }
  if (sample.effort !== undefined && typeof sample.effort !== "string") return false
  if (sample.calls !== undefined && (typeof sample.calls !== "number" || !Number.isFinite(sample.calls) || sample.calls < 0)) {
    return false
  }
  return true
}

function cleanSample(sample: TurnSample): TurnSample {
  return {
    ms: Math.round(sample.ms),
    ...(sample.chars !== undefined ? { chars: Math.round(sample.chars) } : {}),
    ...(sample.effort ? { effort: sample.effort } : {}),
    ...(sample.calls !== undefined ? { calls: Math.round(sample.calls) } : {}),
    at: sample.at,
  }
}

function readEntries(file: string, now: number): TurnHistory {
  const out: TurnHistory = new Map()
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entries = parsed && typeof parsed === "object" ? parsed.turns : null
    if (!entries || typeof entries !== "object") return out
    const cutoff = now - TURN_SAMPLE_MAX_AGE_MS
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!key || !Array.isArray(value)) continue
      const samples = value
        .filter(isSample)
        .filter((sample) => sample.at >= cutoff)
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_TURN_SAMPLES)
        .map(cleanSample)
      if (samples.length > 0) out.set(key, samples)
    }
  } catch {
    // ENOENT before the first turn, or a file another process is renaming
    // into place: the empty store is the answer.
  }
  return out
}

/** The keys with the newest samples, `MAX_TURN_KEYS` of them. */
function bounded(history: TurnHistory): TurnHistory {
  const newest = (samples: TurnSample[]) => samples[samples.length - 1]?.at ?? 0
  return new Map([...history.entries()].sort((a, b) => newest(a[1]) - newest(b[1])).slice(-MAX_TURN_KEYS))
}

/**
 * Record one finished turn under `key`. Returns whether the disk was
 * written, which is false for an unusable sample and a failed write alike:
 * the caller has nothing to do about either.
 */
export function recordTurnSample(key: string, sample: TurnSample): boolean {
  if (!key || !isSample(sample)) return false
  const file = turnHistoryStorePath()
  const merged = readEntries(file, sample.at)
  const samples = [...(merged.get(key) ?? []), cleanSample(sample)].sort((a, b) => a.at - b.at).slice(-MAX_TURN_SAMPLES)
  merged.set(key, samples)
  const kept = bounded(merged)
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, turns: Object.fromEntries(kept) }), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    return false
  }
  return true
}

/**
 * A reader that re-parses the file only when it changed. The TUI calls
 * `read()` on every refresh while something runs; an unchanged file costs
 * one `stat`.
 */
export function createTurnHistoryReader(file: () => string = turnHistoryStorePath) {
  let identity = ""
  let cached: TurnHistory = new Map()
  return {
    read(now: number = Date.now()): TurnHistory {
      const path = file()
      let next = ""
      try {
        const stats = statSync(path)
        next = `${stats.mtimeMs}:${stats.size}:${stats.ino}`
      } catch {
        next = "missing"
      }
      if (next !== identity) {
        identity = next
        cached = next === "missing" ? new Map() : readEntries(path, now)
      }
      return cached
    },
  }
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

export interface TurnEstimate {
  /** What the whole turn is expected to take, elapsed included; once `over`, the usual duration. */
  totalMs: number
  /** Elapsed over that total, 0 to 1; 1 once past every recorded turn. */
  fill: number
  /** The turn has outlasted every recorded one: nothing is left to condition on. */
  over: boolean
}

/** The value at which the cumulative weight first reaches half the total. */
function weightedMedian(values: readonly number[], weights: readonly number[]): number {
  const order = values.map((_, index) => index).sort((a, b) => values[a] - values[b])
  const total = order.reduce((sum, index) => sum + weights[index], 0)
  let cumulative = 0
  for (const index of order) {
    cumulative += weights[index]
    if (cumulative >= total / 2) return values[index]
  }
  return values[order[order.length - 1]]
}

function charsWeight(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return 1
  const distance = Math.log((a + CHARS_FLOOR) / (b + CHARS_FLOOR)) / CHARS_BANDWIDTH
  return Math.exp(-0.5 * distance * distance)
}

function effortWeight(a: string | undefined, b: string | undefined): number {
  return a === undefined || b === undefined || a === b ? 1 : OTHER_EFFORT_WEIGHT
}

/**
 * The factor each other effort's durations are scaled by before the estimate
 * conditions on them: the weighted median of this effort's turns over the
 * weighted median of that effort's. Measured only once both groups hold
 * `MIN_EFFORT_RATIO_SAMPLES` (a ratio of one turn to one turn is noise),
 * with the prompt-length kernel on both medians so a group of long prompts
 * is not read as a slow effort. An effort with no measurable ratio is left
 * as recorded, at `OTHER_EFFORT_WEIGHT`; a sample with no effort is never
 * scaled.
 */
function effortScales(
  samples: readonly TurnSample[],
  charsWeights: readonly number[],
  effort: string | undefined,
): Map<string, number> {
  const scales = new Map<string, number>()
  if (effort === undefined) return scales
  const groups = new Map<string, number[]>()
  samples.forEach((sample, index) => {
    if (sample.effort === undefined) return
    const group = groups.get(sample.effort) ?? []
    group.push(index)
    groups.set(sample.effort, group)
  })
  const own = groups.get(effort)
  if (!own || own.length < MIN_EFFORT_RATIO_SAMPLES) return scales
  const medianOf = (indices: readonly number[]) =>
    weightedMedian(
      indices.map((index) => samples[index].ms),
      indices.map((index) => charsWeights[index]),
    )
  const ownMedian = medianOf(own)
  for (const [other, indices] of groups) {
    if (other === effort || indices.length < MIN_EFFORT_RATIO_SAMPLES) continue
    const otherMedian = medianOf(indices)
    if (ownMedian > 0 && otherMedian > 0) scales.set(other, ownMedian / otherMedian)
  }
  return scales
}

/**
 * What a turn that has run `elapsedMs` and made `calls` tool calls is
 * expected to take in all, given the recorded turns of its agent and model:
 * the weighted median residual life described at the top. `undefined` with
 * fewer than `MIN_TURN_SAMPLES` samples. A sample recorded without a call
 * count, or a turn whose count is unknown, is conditioned on time alone.
 */
export function estimateTurn(
  samples: readonly TurnSample[],
  input: { elapsedMs: number; chars?: number; effort?: string; calls?: number },
): TurnEstimate | undefined {
  const usable = samples.filter((sample) => Number.isFinite(sample.ms) && sample.ms >= 0)
  if (usable.length < MIN_TURN_SAMPLES) return undefined
  const elapsed = Math.max(0, input.elapsedMs)
  const charsWeights = usable.map((sample) => charsWeight(input.chars, sample.chars))
  const scales = effortScales(usable, charsWeights, input.effort)
  const scaled = usable.map((sample, index) => ({
    ms: sample.ms * (sample.effort !== undefined ? (scales.get(sample.effort) ?? 1) : 1),
    calls: sample.calls,
    weight: charsWeights[index] * effortWeight(input.effort, sample.effort),
  }))
  const survivors = scaled.filter(
    (sample) =>
      sample.ms > elapsed &&
      (sample.calls === undefined || input.calls === undefined || sample.calls >= input.calls),
  )
  if (survivors.length === 0) {
    const usual = weightedMedian(
      scaled.map((sample) => sample.ms),
      scaled.map((sample) => sample.weight),
    )
    return { totalMs: usual, fill: 1, over: true }
  }
  const residual = weightedMedian(
    survivors.map((sample) => sample.ms - elapsed),
    survivors.map((sample) => sample.weight),
  )
  const totalMs = elapsed + residual
  return { totalMs, fill: totalMs > 0 ? elapsed / totalMs : 0, over: false }
}

export function _setTurnHistoryStorePathForTests(path: string | null): void {
  pathOverride = path
  turnStarts.clear()
}
