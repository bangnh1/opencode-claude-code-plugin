/**
 * The messages a reused Claude session missed while the conversation ran under
 * another session key (issue #114, h #g239): `src/conversation-gap.ts` on its
 * own, then a fake CLI driving real `doStream` turns over two opencode agents
 * in one conversation.
 *
 * Usage: npx tsx --test test/conversation-gap.test.ts
 */
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"
import {
  _resetServedConversations,
  findMissedMessages,
  forgetServedConversation,
  MAX_SERVED_CONVERSATIONS,
  moveServedConversation,
  recordServedConversation,
} from "../src/conversation-gap.js"
import { createClaudeCode } from "../src/index.js"
import {
  deleteActiveProcessAndWait,
  deleteClaudeSessionId,
  getClaudeSessionId,
  killAllActiveProcesses,
  sessionKey,
  setClaudeSessionId,
  transferClaudeSession,
} from "../src/session-manager.js"

const u = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }] })
const a = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
})
const p = (messages: unknown[]) => messages as any

// ---------------------------------------------------------------------------
// The finder on its own
// ---------------------------------------------------------------------------

test("a tail of nothing but the session's own reply is not a gap", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]))
  assert.equal(findMissedMessages("k", p([u("one"), a("reply"), u("two")])), null)

  // A reply that ran tools: assistant and tool content past the chain, no
  // user message, so still the session's own reply.
  recordServedConversation("k", p([u("one")]))
  assert.equal(
    findMissedMessages(
      "k",
      p([
        u("one"),
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { filePath: "/x" } }],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "x" } }],
        },
        a("done"),
        u("two"),
      ]),
    ),
    null,
  )
})

test("user messages past the recorded chain are the missed stretch, up to the last reply", () => {
  _resetServedConversations()
  recordServedConversation("k", p([u("one")]))
  const prompt = p([u("one"), a("A1"), u("two"), a("A2"), u("three"), a("A3"), u("four")])
  const missed = findMissedMessages("k", prompt)
  assert.ok(missed)
  // The prompt's own objects, from the first foreign user message to the last
  // reply, never the trailing message the envelope sends anyway.
  assert.deepEqual(
    missed.messages.map((m: any) => m.content[0].text),
    ["two", "A2", "three", "A3"],
  )
  assert.equal(missed.messages[0], prompt[2])
  assert.equal(missed.userMessages, 2)

  // Once this key's session has been asked the whole thread, nothing is missed.
  recordServedConversation("k", prompt)
  assert.equal(findMissedMessages("k", p([...prompt, a("A4"), u("five")])), null)
})

test("nothing is invented for a session never asked, a diverged chain or a shortened prompt", () => {
  _resetServedConversations()
  assert.equal(findMissedMessages("k", p([u("one"), a("A1"), u("two"), a("A2"), u("three")])), null)

  // An edited message: the chain is not a prefix, so the session is reused
  // as it always was and nothing is claimed about what it saw.
  recordServedConversation("k", p([u("one")]))
  assert.equal(findMissedMessages("k", p([u("ONE, edited"), a("A1"), u("two"), a("A2"), u("three")])), null)

  // A regenerated reply: the prompt is shorter than what the session was
  // asked, so the chain cannot be a prefix of it.
  recordServedConversation("k", p([u("one"), a("A1"), u("two")]))
  assert.equal(findMissedMessages("k", p([u("one"), a("A1"), u("two")])), null)

  // No reply at all yet: there is nothing before the current message to miss.
  recordServedConversation("k", p([u("one")]))
  assert.equal(findMissedMessages("k", p([u("one")])), null)
})

test("the chain is the conversation's shape, so a reply flattened for another model still matches", () => {
  _resetServedConversations()
  // Recorded with the reply's reasoning as a `reasoning` part, as opencode
  // hands it to the model that produced it ...
  recordServedConversation(
    "k",
    p([
      u("one"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking about it" },
          { type: "text", text: "A1" },
        ],
      },
      u("two"),
    ]),
  )
  // ... and asked again with it flattened into a leading text part, as every
  // other model gets it (h #g215). Still a prefix: assistant by position.
  const missed = findMissedMessages(
    "k",
    p([
      u("one"),
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking about it" },
          { type: "text", text: "A1" },
        ],
      },
      u("two"),
      a("A2"),
      u("three"),
      a("A3"),
      u("four"),
    ]),
  )
  assert.ok(missed)
  assert.deepEqual(
    missed.messages.map((m: any) => m.content[0].text),
    ["three", "A3"],
  )
})

test("the record is forgotten, moved with the session, and capped", () => {
  _resetServedConversations()
  const thread = p([u("one"), a("A1"), u("two"), a("A2"), u("three")])
  recordServedConversation("from", p([u("one")]))
  moveServedConversation("from", "to")
  assert.equal(findMissedMessages("from", thread), null)
  assert.ok(findMissedMessages("to", thread))
  forgetServedConversation("to")
  assert.equal(findMissedMessages("to", thread), null)

  // `transferClaudeSession` carries it with the id.
  setClaudeSessionId("sm-from", "sid")
  recordServedConversation("sm-from", p([u("one")]))
  try {
    assert.equal(transferClaudeSession("sm-from", "sm-to"), "sid")
    assert.ok(findMissedMessages("sm-to", thread))
    assert.equal(findMissedMessages("sm-from", thread), null)
    // And `deleteClaudeSessionId` drops it with the id.
    deleteClaudeSessionId("sm-to")
    assert.equal(findMissedMessages("sm-to", thread), null)
  } finally {
    deleteClaudeSessionId("sm-from")
    deleteClaudeSessionId("sm-to")
  }

  _resetServedConversations()
  for (let i = 0; i <= MAX_SERVED_CONVERSATIONS; i++) {
    recordServedConversation(`cap-${i}`, p([u("one")]))
  }
  assert.equal(findMissedMessages("cap-0", thread), null, "the quietest key is shed")
  assert.ok(findMissedMessages(`cap-${MAX_SERVED_CONVERSATIONS}`, thread))
})

// ---------------------------------------------------------------------------
// Through a real doStream: two opencode agents, one conversation
// ---------------------------------------------------------------------------

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-gap-"))
  const cliPath = join(cwd, "fake-claude.cjs")
  const record = join(cwd, "envelopes.jsonl")
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const readline = require("node:readline")
if (process.argv.includes("--version")) {
  console.log("2.1.258")
  process.exit(0)
}
const emit = (message) => console.log(JSON.stringify(message))
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
    pid: process.pid, argv: process.argv.slice(2), stdin: line,
  }) + "\\n")
  emit({ type: "assistant", session_id: "session-" + process.pid, message: {
    role: "assistant", stop_reason: "end_turn",
    content: [{ type: "text", text: "answered by " + process.pid }],
  } })
  emit({ type: "result", subtype: "success", session_id: "session-" + process.pid,
    is_error: false, usage: { input_tokens: 1, output_tokens: 1 } })
})
`,
    { mode: 0o755 },
  )
  const modelId = "claude-haiku-4-5"
  const provider = createClaudeCode({
    cwd,
    cliPath,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
    // Nothing here depends on the store, and a single-file run must not
    // write the operator's.
    resumeAfterRestart: false,
  })
  const keyFor = (agent: string) =>
    sessionKey(cwd, `${modelId}::tools::conversation::context=["claude-code","${agent}"]`)
  const turn = async (agent: string, prompt: unknown[]) => {
    const options: LanguageModelV3CallOptions = {
      tools: [{ type: "function", name: "read", inputSchema: { type: "object" } }],
      providerOptions: {
        "claude-code": { opencodeSessionID: "conversation", opencodeAgent: agent },
      },
      prompt: p(prompt),
    }
    const response = await provider.languageModel(modelId).doStream(options)
    for await (const part of response.stream) {
      if (part.type === "error") throw part.error
    }
  }
  const envelopes = (): Array<{ pid: number; argv: string[]; stdin: string }> =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  const cleanup = async () => {
    killAllActiveProcesses()
    for (const agent of ["build", "plan"]) deleteClaudeSessionId(keyFor(agent))
    _resetServedConversations()
    rmSync(cwd, { recursive: true, force: true })
  }
  return { cwd, keyFor, turn, envelopes, cleanup }
}

const missedBlock = (stdin: string): string | null => {
  const start = stdin.indexOf("<missed_conversation>")
  if (start < 0) return null
  return stdin.slice(start, stdin.indexOf("</missed_conversation>"))
}

test("a reused claude process is told what the other agent said in between", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    // build -> plan -> plan -> build, one opencode conversation.
    await f.turn("build", [u("one")])
    await f.turn("plan", [u("one"), a("A1"), u("two")])
    await f.turn("plan", [u("one"), a("A1"), u("two"), a("A2"), u("three")])
    await f.turn("build", [u("one"), a("A1"), u("two"), a("A2"), u("three"), a("A3"), u("four")])

    const sent = f.envelopes()
    assert.equal(sent.length, 4)
    const [build1, plan1, plan2, build2] = sent
    // Two processes: the plan agent's own key spawned once and was reused;
    // the build agent's process answered its first and fourth turn.
    assert.notEqual(plan1.pid, build1.pid)
    assert.equal(plan2.pid, plan1.pid)
    assert.equal(build2.pid, build1.pid, "the build process was reused, not respawned")

    // The plan key had no session: the whole thread so far was replayed.
    assert.match(plan1.stdin, /<conversation_history>/)
    // Its second turn was its own continuation: just the message.
    assert.equal(missedBlock(plan2.stdin), null)
    assert.doesNotMatch(plan2.stdin, /conversation_history/)

    // The build process never saw the plan exchange, so it gets exactly that,
    // ahead of the current message, and not its own first exchange again.
    const block = missedBlock(build2.stdin)
    assert.ok(block, build2.stdin.slice(0, 400))
    assert.match(block, /User: two/)
    assert.match(block, /Assistant: A2/)
    assert.match(block, /User: three/)
    assert.match(block, /Assistant: A3/)
    assert.doesNotMatch(block, /User: one/)
    assert.doesNotMatch(block, /Assistant: A1/)
    assert.match(block, /continued under another opencode agent or model/)
    assert.doesNotMatch(build2.stdin, /<conversation_history>/)
    const envelope = JSON.parse(build2.stdin)
    const texts = envelope.message.content.map((c: any) => c.text)
    assert.equal(texts[texts.length - 1], "four", "the current message follows the replay")

    // Back on build with nothing in between: an ordinary turn again.
    await f.turn("build", [
      u("one"), a("A1"), u("two"), a("A2"), u("three"), a("A3"), u("four"), a("A4"), u("five"),
    ])
    const build3 = f.envelopes()[4]
    assert.equal(build3.pid, build1.pid)
    assert.equal(missedBlock(build3.stdin), null)
    assert.match(build3.stdin, /"five"/)
  } finally {
    await f.cleanup()
  }
})

test("a session resumed with --resume after its process was evicted gets the same replay", async () => {
  _resetServedConversations()
  const f = fixture()
  try {
    await f.turn("build", [u("one")])
    await f.turn("plan", [u("one"), a("A1"), u("two")])
    const buildKey = f.keyFor("build")
    const buildSession = getClaudeSessionId(buildKey)
    assert.ok(buildSession)
    // Idle eviction, the LRU cap: the process goes, the id stays.
    await deleteActiveProcessAndWait(buildKey)

    await f.turn("build", [u("one"), a("A1"), u("two"), a("A2"), u("three")])
    const sent = f.envelopes()
    assert.equal(sent.length, 3)
    const resumed = sent[2]
    assert.notEqual(resumed.pid, sent[0].pid, "a fresh process")
    assert.deepEqual(
      resumed.argv.slice(resumed.argv.indexOf("--resume"), resumed.argv.indexOf("--resume") + 2),
      ["--resume", buildSession],
    )
    const block = missedBlock(resumed.stdin)
    assert.ok(block, resumed.stdin.slice(0, 400))
    assert.match(block, /User: two/)
    assert.match(block, /Assistant: A2/)
    assert.doesNotMatch(block, /User: one/)
    assert.doesNotMatch(resumed.stdin, /<conversation_history>/)
  } finally {
    await f.cleanup()
  }
})
