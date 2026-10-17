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
 * recorded turns that lasted LONGER than `t` (the ones this turn can still
 * be like), the weighted median of what remained of them at `t`. The total
 * is `t` plus that, and the bar is `t` over the total. Conditioning on
 * survival is what keeps the bar honest once a turn runs long: the total
 * rises with `t` instead of the bar sitting full. The weights prefer turns
 * that started like this one: a Gaussian kernel on the log of the prompt's
 * length (`CHARS_BANDWIDTH`, so a prompt four times longer or shorter still
 * weighs e^-1/2, sixteen times e^-2), and `OTHER_EFFORT_WEIGHT` for a turn
 * at another effort. Past the longest recorded turn there is nothing left to
 * condition on, and the estimate says so (`over`): the bar is full, drawn in
 * the warning colour, and the total shown is the usual one, the weighted
 * median of every sample.
 *
 * Fewer than `MIN_TURN_SAMPLES` samples is no estimate at all, and the line
 * then draws no bar rather than a guess. The first turns of a new agent or
 * model show the spinner, the elapsed, the calls and the tool.
 *
 * ## The store
 *
 * ```json
 * { "version": 1, "turns": { "build/claude-opus-5-5": [
 *     { "ms": 61230, "chars": 420, "effort": "high", "at": 1760000000000 } ] } }
 * ```
 *
 * A duration, a character count, an effort level and a time: no prompt text,
 * no path, no session id, nothing secret. Same discipline as the spawn
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
  return true
}

function cleanSample(sample: TurnSample): TurnSample {
  return {
    ms: Math.round(sample.ms),
    ...(sample.chars !== undefined ? { chars: Math.round(sample.chars) } : {}),
    ...(sample.effort ? { effort: sample.effort } : {}),
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
 * What a turn that has run `elapsedMs` is expected to take in all, given the
 * recorded turns of its agent and model: the weighted median residual life
 * described at the top. `undefined` with fewer than `MIN_TURN_SAMPLES`
 * samples.
 */
export function estimateTurn(
  samples: readonly TurnSample[],
  input: { elapsedMs: number; chars?: number; effort?: string },
): TurnEstimate | undefined {
  const usable = samples.filter((sample) => Number.isFinite(sample.ms) && sample.ms >= 0)
  if (usable.length < MIN_TURN_SAMPLES) return undefined
  const elapsed = Math.max(0, input.elapsedMs)
  const weights = usable.map(
    (sample) => charsWeight(input.chars, sample.chars) * effortWeight(input.effort, sample.effort),
  )
  const survivors = usable
    .map((sample, index) => ({ ms: sample.ms, weight: weights[index] }))
    .filter((sample) => sample.ms > elapsed)
  if (survivors.length === 0) {
    const usual = weightedMedian(usable.map((sample) => sample.ms), weights)
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
