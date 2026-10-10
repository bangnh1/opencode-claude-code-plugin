/**
 * Catching a resumed Claude session up on the messages another opencode agent
 * answered (h #g236).
 *
 * The agent is in the session key, so plan and build each own a Claude
 * session. Switching back to an agent whose key already has one used to send
 * only the newest message, so whatever the other agent was asked and answered
 * in between never reached it. The unit half drives `findMissedConversation`
 * and `renderMissedConversation`; the end-to-end half drives plan -> build ->
 * plan -> build through real `doStream` turns and a fake CLI, and reads what
 * the second build turn was sent.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider"

import {
  _resetConversationsSent,
  findMissedConversation,
  forgetConversationSent,
  moveConversationSent,
  noteConversationSent,
} from "../src/session-catch-up.js"
import {
  getClaudeUserMessage,
  MAX_MISSED_CONVERSATION_CHARS,
  renderMissedConversation,
} from "../src/message-builder.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  sessionKey,
} from "../src/session-manager.js"
import { _setResumeStorePath } from "../src/session-resume-store.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"

const userText = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistantText = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any
const toolCall = (id: string) =>
  ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { path: "a.ts" } }],
  }) as any
const toolResult = (id: string, output: string) =>
  ({
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, toolName: "read", output: { type: "text", value: output } },
    ],
  }) as any

const SYSTEM = { role: "system", content: "You are a helpful assistant." } as any

/** Build's first turn. */
const BUILD_1 = [SYSTEM, userText("Add item stats to the bag.")]
/** Then plan answered two messages build never saw. */
const PLAN_1 = [
  ...BUILD_1,
  assistantText("Done: the bag shows stats."),
  userText("Can we read stats after an upgrade?"),
]
const PLAN_2 = [
  ...PLAN_1,
  assistantText("Yes. Questions: 1) cache it? 2) show the delta? 3) add a button?"),
  userText("See https://example.test/upgrade for reference."),
]
/** And the operator answers plan's questions on build. */
const BUILD_2 = [
  ...PLAN_2,
  assistantText("Read the reference: upgrades add +5 per level."),
  userText("1 -> ok 2 -> ok 3 -> no"),
]

const KEY = "/work::claude-opus-5-5::tools::ses_x::context=[\"claude-code\",\"build\"]"

// ---------------------------------------------------------------------------
// findMissedConversation
// ---------------------------------------------------------------------------

test("a key with no record has nothing missed", () => {
  _resetConversationsSent()
  assert.deepEqual(findMissedConversation(KEY, BUILD_2 as any), { kind: "none" })
})

test("the messages answered under another key are what was missed, and nothing else", () => {
  _resetConversationsSent()
  noteConversationSent(KEY, BUILD_1 as any)
  const missed = findMissedConversation(KEY, BUILD_2 as any)
  assert.equal(missed.kind, "missed")
  const texts = (missed as any).messages.map((m: any) => m.content[0].text)
  // Build's own reply to what it was sent ("Done: ...") is in its transcript
  // already; the current message ("1 -> ok ...") is sent as it always was.
  assert.deepEqual(texts, [
    "Can we read stats after an upgrade?",
    "Yes. Questions: 1) cache it? 2) show the delta? 3) add a button?",
    "See https://example.test/upgrade for reference.",
    "Read the reference: upgrades add +5 per level.",
  ])
})

test("an ordinary next turn on the same agent has nothing missed", () => {
  _resetConversationsSent()
  noteConversationSent(KEY, BUILD_1 as any)
  const next = [...BUILD_1, toolCall("c1"), toolResult("c1", "file"), assistantText("Done."), userText("Thanks")]
  assert.deepEqual(findMissedConversation(KEY, next as any), { kind: "none" })
})

test("a conversation that no longer starts with what was sent is diverged", () => {
  _resetConversationsSent()
  noteConversationSent(KEY, BUILD_1 as any)
  const compacted = [SYSTEM, userText("Summary of earlier work."), assistantText("ok"), userText("go on")]
  assert.deepEqual(findMissedConversation(KEY, compacted as any), { kind: "diverged" })
})

test("a tool-result turn takes no catch-up", () => {
  _resetConversationsSent()
  noteConversationSent(KEY, BUILD_1 as any)
  const parked = [...PLAN_2, toolCall("c2"), toolResult("c2", "out")]
  assert.deepEqual(findMissedConversation(KEY, parked as any), { kind: "none" })
})

test("the record follows a moved session and goes with a forgotten one", () => {
  _resetConversationsSent()
  const other = KEY.replace("opus", "sonnet")
  noteConversationSent(KEY, BUILD_1 as any)
  moveConversationSent(KEY, other)
  assert.deepEqual(findMissedConversation(KEY, BUILD_2 as any), { kind: "none" })
  assert.equal(findMissedConversation(other, BUILD_2 as any).kind, "missed")
  forgetConversationSent(other)
  assert.deepEqual(findMissedConversation(other, BUILD_2 as any), { kind: "none" })
})

// ---------------------------------------------------------------------------
// renderMissedConversation and the envelope
// ---------------------------------------------------------------------------

test("the missed messages render with their tool output and land before the current message", () => {
  const missed = [
    userText("Check the upgrade table."),
    toolCall("c1"),
    toolResult("c1", "LEVEL_TABLE"),
    assistantText("Upgrades add +5 per level."),
  ]
  const rendered = renderMissedConversation(missed as any)!
  assert.equal(rendered.condensed, false)
  assert.equal(rendered.dropped, 0)
  assert.ok(rendered.text.includes("LEVEL_TABLE"))
  assert.ok(rendered.text.includes("Assistant: Upgrades add +5 per level."))

  const envelope = JSON.parse(
    getClaudeUserMessage(BUILD_2 as any, false, { missedConversation: rendered.text }),
  )
  const blocks = envelope.message.content
  assert.ok(blocks[0].text.startsWith("<conversation_you_missed>"))
  assert.ok(blocks[0].text.includes("LEVEL_TABLE"))
  assert.equal(blocks.at(-1).text, "1 -> ok 2 -> ok 3 -> no")
})

test("a full replay ignores the catch-up block, which it already covers", () => {
  const envelope = getClaudeUserMessage(BUILD_2 as any, true, { missedConversation: "X-MISSED" })
  assert.ok(envelope.includes("<conversation_history>"))
  assert.ok(!envelope.includes("X-MISSED"))
})

test("an oversized catch-up drops tool output first, then the oldest messages", () => {
  const big = "x".repeat(1_900)
  const withTools = [
    userText("go"),
    ...Array.from({ length: 20 }, (_, i) => [toolCall(`c${i}`), toolResult(`c${i}`, big)]).flat(),
    assistantText("short answer"),
  ]
  const condensed = renderMissedConversation(withTools as any)!
  assert.equal(condensed.condensed, true)
  assert.equal(condensed.dropped, 0)
  assert.ok(!condensed.text.includes(big.slice(0, 100)))
  assert.ok(condensed.text.includes("short answer"))

  const chatty = Array.from({ length: 40 }, (_, i) =>
    i % 2 ? assistantText(`${i}:${big}`) : userText(`${i}:${big}`),
  )
  const trimmed = renderMissedConversation(chatty as any)!
  assert.ok(trimmed.dropped > 0)
  assert.ok(trimmed.text.length <= MAX_MISSED_CONVERSATION_CHARS + 200)
  assert.ok(trimmed.text.includes("39:"), "the newest message is kept")
  assert.ok(!trimmed.text.includes("User: 0:"), "the oldest is dropped")
})

// ---------------------------------------------------------------------------
// End to end: plan -> build -> plan -> build through real doStream turns.
// ---------------------------------------------------------------------------

function createAgentCli(options: { catchUpMissedMessages?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-catch-up-e2e-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const eventsPath = join(cwd, "events.jsonl")
  writeFileSync(eventsPath, "")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
const args = process.argv.slice(2)
const record = (event) => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n")
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
if (args.includes("--version")) {
  process.stdout.write("2.1.288\\n")
  process.exit(0)
}
if (args.includes("--help")) process.exit(0)
const at = args.indexOf("--resume")
const sessionId = at >= 0 ? args[at + 1] : "claude-" + process.pid
record({ type: "spawn", args, sessionId })
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, envelope })
  emit({ type: "assistant", session_id: sessionId, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } })
  emit({ type: "result", subtype: "success", session_id: sessionId, is_error: false, usage: { input_tokens: 9, output_tokens: 4 } })
})
`,
    { mode: 0o755 },
  )
  _setResumeStorePath(join(cwd, "state", "claude-sessions.json"))

  const provider = createClaudeCode({
    cliPath,
    cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    ...(options.catchUpMissedMessages === undefined
      ? {}
      : { catchUpMissedMessages: options.catchUpMissedMessages }),
  } as any)

  const MODEL = "claude-opus-5-5"
  const key = (agent: string) =>
    sessionKey(cwd, `${MODEL}::tools::ses_agents::context=${JSON.stringify(["claude-code", agent])}`)
  const events = () =>
    readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as any)

  return {
    key,
    events,
    inputs: () => events().filter((event) => event.type === "input"),
    async turn(agent: string, prompt: any[]) {
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": "ses_agents", "x-opencode-agent": agent },
        tools: [{ type: "function", name: "read", inputSchema: { type: "object", properties: {} } }],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await provider.languageModel(MODEL).doStream(call)
      for await (const part of response.stream as AsyncIterable<LanguageModelV3StreamPart>) {
        if (part.type === "error") throw (part as any).error
      }
    },
    async warm() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        if (await detectCliVersion(cliPath)) return
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const agent of ["plan", "build"]) {
        await deleteActiveProcessAndWait(key(agent))
        deleteClaudeSessionId(key(agent))
      }
      _setResumeStorePath(null)
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

/** plan -> build -> plan -> build, as opencode would prompt each turn. */
const PLAN_TURN_1 = [SYSTEM, userText("Items lack stats. Plan it.")]
const BUILD_TURN_1 = [...PLAN_TURN_1, assistantText("Plan: show stats."), userText("Implement it.")]
const PLAN_TURN_2 = [
  ...BUILD_TURN_1,
  assistantText("Implemented."),
  userText("Can we read stats after an upgrade?"),
]
const BUILD_TURN_2 = [
  ...PLAN_TURN_2,
  assistantText("PLAN-QUESTIONS: 1) cache 2) delta 3) button"),
  userText("1 -> ok 2 -> ok 3 -> no"),
]

test("switching back to an agent sends its session what the other agent answered", {
  timeout: 60_000,
}, async () => {
  const fake = createAgentCli()
  try {
    await fake.warm()
    await fake.turn("plan", PLAN_TURN_1)
    await fake.turn("build", BUILD_TURN_1)
    await fake.turn("plan", PLAN_TURN_2)
    const buildSession = getClaudeSessionId(fake.key("build"))
    assert.ok(buildSession)

    await fake.turn("build", BUILD_TURN_2)

    const last = fake.inputs().at(-1)
    assert.equal(last.sessionId, buildSession, "build's own session, not plan's")
    const sent = JSON.stringify(last.envelope)
    assert.ok(sent.includes("conversation_you_missed"), sent.slice(0, 400))
    assert.ok(sent.includes("Can we read stats after an upgrade?"))
    assert.ok(sent.includes("PLAN-QUESTIONS"))
    assert.ok(!sent.includes("conversation_history"), "no full replay")
    assert.ok(!sent.includes("Implement it."), "nothing build already saw")
  } finally {
    await fake.cleanup()
  }
})

test("catchUpMissedMessages: false sends only the current message, as before", {
  timeout: 60_000,
}, async () => {
  const fake = createAgentCli({ catchUpMissedMessages: false })
  try {
    await fake.warm()
    await fake.turn("plan", PLAN_TURN_1)
    await fake.turn("build", BUILD_TURN_1)
    await fake.turn("plan", PLAN_TURN_2)
    await fake.turn("build", BUILD_TURN_2)
    const sent = JSON.stringify(fake.inputs().at(-1).envelope)
    assert.ok(!sent.includes("conversation_you_missed"))
    assert.ok(!sent.includes("PLAN-QUESTIONS"))
  } finally {
    await fake.cleanup()
  }
})
