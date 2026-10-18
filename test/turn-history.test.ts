/**
 * The turn-history store and the estimate drawn from it (h #g247): the
 * store's round trip, bounds and discipline; the prompt-length count both
 * halves share; the turn-start registry; the estimator's survival
 * conditioning, kernel weights and `over` state; and a real `doStream`
 * through a fake CLI writing one sample keyed on the agent and model it
 * spawned, with the prompt's length and the effort on it.
 */
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  MAX_TURN_KEYS,
  MAX_TURN_SAMPLES,
  MIN_EFFORT_RATIO_SAMPLES,
  MIN_TURN_SAMPLES,
  TURN_SAMPLE_MAX_AGE_MS,
  _setTurnHistoryStorePathForTests,
  createTurnHistoryReader,
  estimateTurn,
  markTurnStart,
  newestPromptChars,
  promptChars,
  recordTurnSample,
  startsTurn,
  takeTurnStart,
  turnHistoryKey,
  turnHistoryStorePath,
  turnToolCalls,
  type TurnSample,
} from "../src/turn-history.js"

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-turn-history-"))
  _setTurnHistoryStorePathForTests(join(dir, "state", "turn-history.json"))
  return dir
}

const onDisk = () => JSON.parse(readFileSync(turnHistoryStorePath(), "utf8"))
const NOW = 1_800_000_000_000
const sample = (ms: number, over: Partial<TurnSample> = {}): TurnSample => ({ ms, at: NOW, ...over })
const seconds = (value: number) => value * 1000

test("turnHistoryKey is the agent and the model, `main` when the turn has no agent", () => {
  assert.equal(turnHistoryKey("build", "claude-opus-5-5"), "build/claude-opus-5-5")
  assert.equal(turnHistoryKey("explore", "claude-haiku-5-5"), "explore/claude-haiku-5-5")
  assert.equal(turnHistoryKey(undefined, "claude-opus-5-5"), "main/claude-opus-5-5")
  assert.equal(turnHistoryKey("", "claude-opus-5-5"), "main/claude-opus-5-5")
})

test("promptChars counts the text with the host's injected blocks taken off, and no text at all is unknown", () => {
  assert.equal(promptChars(["hello world"]), 11)
  assert.equal(promptChars(["hello <system-reminder>\nlong\n</system-reminder> world"]), 12)
  assert.equal(promptChars(["go<dcp-message-id>m0141</dcp-message-id>"]), 2)
  assert.equal(promptChars(["<dcp-system-reminder>only this</dcp-system-reminder>"]), 0)
  assert.equal(promptChars(["  padded  ", "two"]), 9)
  assert.equal(promptChars([]), undefined)
})

test("newestPromptChars reads the last user message, and startsTurn tells a fresh prompt from a continuation", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] })
  const assistant = { role: "assistant", content: [{ type: "text", text: "a much longer reply than the prompt" }] }
  const tool = { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", output: { type: "text", value: "x" } }] }
  assert.equal(newestPromptChars([user("first"), assistant, user("second one")]), 10)
  assert.equal(newestPromptChars([user("first"), assistant, tool]), 5)
  assert.equal(newestPromptChars([{ role: "user", content: "plain string" }]), 12)
  assert.equal(newestPromptChars([{ role: "user", content: [{ type: "file", data: "..." }] }]), undefined)
  assert.equal(newestPromptChars([]), undefined)

  assert.equal(startsTurn([user("hello")]), true)
  assert.equal(startsTurn([user("hello"), assistant, user("again")]), true)
  // A tool result continues the turn that made the call.
  assert.equal(startsTurn([user("hello"), assistant, tool]), false)
  // So does a user message the host promoted beside one.
  assert.equal(startsTurn([user("hello"), assistant, tool, user("steer")]), false)
  assert.equal(startsTurn([user("hello"), assistant]), false)
  assert.equal(startsTurn([]), false)
})

test("a turn's start is taken once, and the newest mark on a key wins", () => {
  _setTurnHistoryStorePathForTests(null)
  markTurnStart("key-a", 1_000, 42)
  markTurnStart("key-a", 2_000)
  assert.deepEqual(takeTurnStart("key-a"), { at: 2_000 })
  assert.equal(takeTurnStart("key-a"), undefined, "a second result in the same turn finds nothing")
  assert.equal(takeTurnStart("never-marked"), undefined)
})

test("a sample round-trips with nothing but its five fields", () => {
  const dir = scratch()
  try {
    assert.equal(
      recordTurnSample("build/claude-opus-5-5", {
        ms: 61_230.4,
        chars: 420,
        effort: "high",
        calls: 3.2,
        at: NOW,
        ...({ prompt: "secret", sessionKey: "/x" } as object),
      } as TurnSample),
      true,
    )
    const [entry] = onDisk().turns["build/claude-opus-5-5"]
    assert.deepEqual(entry, { ms: 61_230, chars: 420, effort: "high", calls: 3, at: NOW })
    assert.deepEqual(Object.keys(entry).sort(), ["at", "calls", "chars", "effort", "ms"])
    // An unusable sample is not written, and says so.
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: -1, at: NOW }), false)
    assert.equal(recordTurnSample("build/claude-opus-5-5", { ms: 1, calls: -1, at: NOW }), false)
    assert.equal(recordTurnSample("", { ms: 1, at: NOW }), false)
    assert.equal(onDisk().turns["build/claude-opus-5-5"].length, 1)
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the file is 0600 in a 0700 directory, because the state directory is shared", { skip: process.platform === "win32" }, () => {
  const dir = scratch()
  try {
    recordTurnSample("build/claude-opus-5-5", sample(1_000))
    assert.equal(statSync(turnHistoryStorePath()).mode & 0o777, 0o600)
    assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700)
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a second writer's keys survive a write, and the store is bounded per key, in keys, and by age", () => {
  const dir = scratch()
  try {
    mkdirSync(join(dir, "state"), { recursive: true })
    const turns: Record<string, unknown> = {
      "explore/claude-haiku-5-5": [{ ms: 9_000, at: NOW - 10 }],
      "plan/claude-opus-5-5": [{ ms: 9_000, at: NOW - TURN_SAMPLE_MAX_AGE_MS - 1 }],
      "junk/claude-opus-5-5": [{ ms: "fast", at: NOW }, "not a sample", { ms: 1, at: NOW, chars: -5 }],
      "": [{ ms: 1, at: NOW }],
    }
    writeFileSync(turnHistoryStorePath(), JSON.stringify({ version: 1, turns }))
    recordTurnSample("build/claude-opus-5-5", sample(61_000))
    assert.deepEqual(Object.keys(onDisk().turns).sort(), ["build/claude-opus-5-5", "explore/claude-haiku-5-5"])

    for (let index = 0; index < MAX_TURN_SAMPLES + 5; index += 1) {
      recordTurnSample("build/claude-opus-5-5", sample(1_000 + index, { at: NOW + index + 1 }))
    }
    const kept = onDisk().turns["build/claude-opus-5-5"]
    assert.equal(kept.length, MAX_TURN_SAMPLES)
    assert.equal(kept[kept.length - 1].ms, 1_000 + MAX_TURN_SAMPLES + 4, "the newest is kept")
    assert.equal(kept[0].at, NOW + 6, "the oldest went first")

    for (let index = 0; index < MAX_TURN_KEYS + 3; index += 1) {
      recordTurnSample(`agent-${index}/claude-opus-5-5`, sample(1_000, { at: NOW + 1_000 + index }))
    }
    const keys = Object.keys(onDisk().turns)
    assert.equal(keys.length, MAX_TURN_KEYS)
    assert.ok(keys.includes(`agent-${MAX_TURN_KEYS + 2}/claude-opus-5-5`), "the key written last is kept")
    assert.ok(!keys.includes("explore/claude-haiku-5-5"), "the key with the oldest samples went first")
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the reader re-parses only a changed file and treats a broken one as empty", () => {
  const dir = scratch()
  try {
    const reader = createTurnHistoryReader()
    assert.equal(reader.read().size, 0, "no file yet")
    recordTurnSample("build/claude-opus-5-5", sample(61_000, { effort: "low" }))
    const first = reader.read()
    assert.equal(first.get("build/claude-opus-5-5")?.[0].effort, "low")
    assert.equal(reader.read(), first, "an unchanged file returns the same map")

    writeFileSync(turnHistoryStorePath(), "{ half written")
    assert.equal(reader.read().size, 0)
  } finally {
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("estimateTurn needs MIN_TURN_SAMPLES, conditions on the turns that outlasted this one, and says over past the longest", () => {
  const samples = [sample(seconds(20)), sample(seconds(60)), sample(seconds(100))]
  assert.equal(MIN_TURN_SAMPLES, 3)
  assert.equal(estimateTurn(samples.slice(0, 2), { elapsedMs: 0 }), undefined)
  // Ten seconds in, every turn is still a candidate: the median of what
  // remained of them is 50 s, so the total is 60 s.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(10) }), {
    totalMs: seconds(60),
    fill: 1 / 6,
    over: false,
  })
  // Seventy seconds in, only the 100 s turn is left to be like: 30 s remain.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(70) }), {
    totalMs: seconds(100),
    fill: 0.7,
    over: false,
  })
  // Past every recorded turn: full, over, the usual duration shown.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(120) }), {
    totalMs: seconds(60),
    fill: 1,
    over: true,
  })
  // A negative elapsed is zero; an unusable sample does not count toward the minimum.
  assert.equal(estimateTurn(samples, { elapsedMs: -5 })?.fill, 0)
  assert.equal(estimateTurn([...samples.slice(0, 2), sample(Number.NaN)], { elapsedMs: 0 }), undefined)
})

test("the estimate weighs toward turns whose prompt was about this long", () => {
  const samples = [
    sample(seconds(10), { chars: 10 }),
    sample(seconds(10), { chars: 10 }),
    sample(seconds(100), { chars: 10_000 }),
    sample(seconds(100), { chars: 10_000 }),
  ]
  assert.equal(estimateTurn(samples, { elapsedMs: 0, chars: 10 })?.totalMs, seconds(10))
  assert.equal(estimateTurn(samples, { elapsedMs: 0, chars: 10_000 })?.totalMs, seconds(100))
  // A prompt of unknown length weighs every sample alike; with an even count the lower middle is the median.
  assert.equal(estimateTurn(samples, { elapsedMs: 0 })?.totalMs, seconds(10))
  // A sample of unknown length weighs like a match.
  const unknown = [sample(seconds(10)), sample(seconds(10)), sample(seconds(100), { chars: 10 })]
  assert.equal(estimateTurn(unknown, { elapsedMs: 0, chars: 10 })?.totalMs, seconds(10))
})

test("a turn at another effort weighs half, and once two turns at each effort are on record its duration is scaled by their measured ratio", () => {
  assert.equal(MIN_EFFORT_RATIO_SAMPLES, 2)
  // One `low` turn is no ratio: the `high` turns count at half weight, as recorded.
  const samples = [sample(seconds(10), { effort: "low" }), sample(seconds(100), { effort: "high" }), sample(seconds(100), { effort: "high" })]
  assert.equal(estimateTurn(samples, { elapsedMs: 0, effort: "low" })?.totalMs, seconds(10))
  assert.equal(estimateTurn(samples, { elapsedMs: 0, effort: "high" })?.totalMs, seconds(100))
  assert.equal(estimateTurn(samples, { elapsedMs: 0 })?.totalMs, seconds(100))
  // A key full of `low` turns and two `high` ones: the `low` durations are
  // stretched by the measured ratio (100 s over 10 s), so a `high` turn is
  // expected to take 100 s, where the half weight alone still said 10 s.
  const mostlyLow = [
    ...Array.from({ length: 6 }, () => sample(seconds(10), { effort: "low" })),
    sample(seconds(100), { effort: "high" }),
    sample(seconds(100), { effort: "high" }),
  ]
  assert.equal(estimateTurn(mostlyLow, { elapsedMs: 0, effort: "high" })?.totalMs, seconds(100))
  assert.equal(estimateTurn(mostlyLow, { elapsedMs: 0, effort: "low" })?.totalMs, seconds(10))
  // The scaled duration is what the turn is conditioned on: fifty seconds
  // into a `high` turn, every stretched `low` sample is still a candidate.
  assert.deepEqual(estimateTurn(mostlyLow, { elapsedMs: seconds(50), effort: "high" }), {
    totalMs: seconds(100),
    fill: 0.5,
    over: false,
  })
  // An unknown effort scales nothing and weighs every sample alike.
  assert.equal(estimateTurn(mostlyLow, { elapsedMs: 0 })?.totalMs, seconds(10))
})

test("the estimate conditions on the turn's tool calls too: a recorded turn with fewer calls than this one has made is not how it ends", () => {
  const samples = [sample(seconds(20), { calls: 1 }), sample(seconds(60), { calls: 3 }), sample(seconds(100), { calls: 8 })]
  // Ten seconds in with no call yet, every turn is a candidate, as without the count.
  assert.equal(estimateTurn(samples, { elapsedMs: seconds(10), calls: 0 })?.totalMs, seconds(60))
  // On its fourth call, only the eight-call turn is left to be like.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(10), calls: 4 }), {
    totalMs: seconds(100),
    fill: 0.1,
    over: false,
  })
  // Beyond every recorded turn's calls is over, as beyond its time is.
  assert.deepEqual(estimateTurn(samples, { elapsedMs: seconds(10), calls: 9 }), {
    totalMs: seconds(60),
    fill: 1,
    over: true,
  })
  // A sample recorded before the count existed survives on time alone.
  const older = [sample(seconds(20)), ...samples.slice(1)]
  assert.equal(estimateTurn(older, { elapsedMs: seconds(10), calls: 4 })?.totalMs, seconds(20))
  // A turn whose count is unknown is conditioned on time alone.
  assert.equal(estimateTurn(samples, { elapsedMs: seconds(10) })?.totalMs, seconds(60))
})

test("turnToolCalls counts the turn's tool calls since the message that started it, a steered message included", () => {
  const call = { type: "tool-call", toolCallId: "t", toolName: "bash", input: {} }
  const prompt = [
    { role: "user", content: [{ type: "text", text: "earlier" }] },
    { role: "assistant", content: [call] },
    { role: "tool", content: [] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "now" }] },
    { role: "assistant", content: [call, call] },
    { role: "tool", content: [] },
    { role: "assistant", content: [{ type: "text", text: "and" }, call] },
    { role: "tool", content: [] },
    { role: "user", content: [{ type: "text", text: "steered" }] },
  ]
  assert.equal(turnToolCalls(prompt), 3, "the earlier turn's call is not counted, and the steered message does not restart the count")
  assert.equal(turnToolCalls(prompt.slice(0, 5)), 0, "a fresh message has made none")
  assert.equal(turnToolCalls(prompt.slice(0, 7)), 2)
  assert.equal(turnToolCalls([]), 0)
})

// The fake CLI is a shebang script made executable with chmod, which means
// nothing on Windows (see .github/windows-skipped-tests.txt).
test("a real turn records its duration under the agent and model it spawned, with the prompt's length, the effort and its tool calls", { skip: process.platform === "win32" }, async () => {
  const dir = scratch()
  const savedHome = process.env.HOME
  const savedState = process.env.XDG_STATE_HOME
  const { createClaudeCode } = await import("../src/index.js")
  const { deleteActiveProcessAndWait, snapshotActiveProcesses } = await import("../src/session-manager.js")
  const cwd = join(dir, "project")
  mkdirSync(cwd, { recursive: true })
  const cliPath = join(dir, "fake-claude.cjs")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) { process.stdout.write("2.1.293\\n"); process.exit(0) }
if (process.argv.includes("--help")) { process.stdout.write("Usage: claude\\n"); process.exit(0) }
const session_id = "fake-turn-history"
const emit = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
require("node:readline").createInterface({ input: process.stdin }).on("line", () => {
  emit({ type: "system", subtype: "init", session_id })
  // One CLI-executed call, then the reply: the sample counts the call.
  emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/x" } }] } })
  emit({ type: "user", session_id, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: "x" }] } })
  emit({ type: "assistant", session_id, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })
  setTimeout(() => {
    emit({ type: "result", subtype: "success", session_id, is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
  }, 80)
})
`,
  )
  chmodSync(cliPath, 0o755)
  process.env.HOME = dir
  process.env.XDG_STATE_HOME = join(dir, "xdg-state")
  const modelId = "claude-sonnet-5-5"
  const affinity = "ses_turn_history"
  try {
    const model = createClaudeCode({
      cliPath,
      cwd,
      bridgeOpencodeMcp: false,
      bridgeOpencodeSkills: false,
      proxyTools: [],
      autoContinueIncompleteTurns: false,
    }).languageModel(modelId)
    const started = Date.now()
    const result = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "hello world <system-reminder>ignored</system-reminder>" }] }],
      // A tool set, or the turn is a title request and never spawns.
      tools: [{ type: "function", name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
      headers: { "x-session-affinity": affinity },
      providerOptions: { "claude-code": { reasoningEffort: "high", opencodeAgent: "build" } },
    } as never)
    for await (const _part of (result as { stream: AsyncIterable<unknown> }).stream) {
      // drain
    }
    const elapsed = Date.now() - started
    const turns = onDisk().turns
    assert.deepEqual(Object.keys(turns), [`build/${modelId}`])
    const [entry] = turns[`build/${modelId}`]
    assert.ok(entry.ms >= 80 && entry.ms <= elapsed, `the sample's duration is the turn's: ${entry.ms} of ${elapsed}`)
    assert.equal(entry.chars, 11, "the prompt's length, the reminder block taken off")
    assert.equal(entry.effort, "high")
    assert.equal(entry.calls, 1, "the step's own CLI-executed call is counted")
    assert.ok(entry.at >= started)
  } finally {
    for (const active of snapshotActiveProcesses()) {
      if (active.sessionKey.includes(affinity)) await deleteActiveProcessAndWait(active.sessionKey)
    }
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedState === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedState
    _setTurnHistoryStorePathForTests(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
