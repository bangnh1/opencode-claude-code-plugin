/**
 * The Claude conversation follows the opencode session across an agent or
 * effort change.
 *
 * The session key carries the opencode agent, so a plan-to-build switch used
 * to land on a key with no Claude session id: the old conversation was
 * abandoned, a clipped text transcript was replayed in its place, and
 * switching back to plan resumed the plan key's own, older conversation.
 * `handOffConversation` moves the id to the key the turn runs on instead.
 *
 * The pure half is exercised directly; then a fake CLI drives real `doStream`
 * turns through plan, build and plan again and checks each spawn's argv.
 *
 * Usage:
 *   npx tsx --test test/conversation-handoff.test.ts
 */
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider"

import {
  _resetConversationHandoffs,
  conversationSignature,
  deleteActiveProcess,
  deleteActiveProcessAndWait,
  deleteActiveProcessesForSession,
  deleteClaudeSessionId,
  effortSessionKey,
  getActiveProcess,
  getClaudeSessionId,
  handOffConversation,
  sessionKey,
  setActiveProcess,
  setClaudeSessionId,
  type ActiveProcess,
} from "../src/session-manager.js"
import {
  applyTaskCreateToolResult,
  applyTaskCreateToolUse,
  getLedger,
} from "../src/todo-ledger.js"
import { detectCliVersion } from "../src/cli-version.js"
import { createClaudeCode } from "../src/index.js"

const keyFor = (
  agent: string | null,
  opts: {
    affinity?: string
    model?: string
    provider?: string
    ttl?: string
    effort?: "high" | "max"
    scope?: string
  } = {},
) => {
  const context: (string | null)[] = [opts.provider ?? "claude-code", agent]
  if (opts.ttl) context.push(opts.ttl)
  return effortSessionKey(
    sessionKey(
      "/work/repo",
      `${opts.model ?? "claude-opus-5-5"}::${opts.scope ?? "tools"}::${opts.affinity ?? "ses_a"}::context=${JSON.stringify(context)}`,
    ),
    opts.effort,
  )
}

function idleProcess(cliPath?: string): ActiveProcess & { killed: () => boolean } {
  let killed = false
  return {
    proc: {
      kill() {
        killed = true
        return true
      },
    } as ActiveProcess["proc"],
    lineEmitter: new EventEmitter(),
    cliPath,
    killed: () => killed,
  }
}

function reset(...keys: string[]) {
  _resetConversationHandoffs()
  for (const key of keys) {
    deleteActiveProcess(key)
    deleteClaudeSessionId(key)
  }
}

test("conversationSignature ignores agent, cache TTL and effort only", () => {
  const plan = conversationSignature(keyFor("plan"))
  assert.ok(plan)
  assert.equal(conversationSignature(keyFor("build")), plan)
  assert.equal(conversationSignature(keyFor(null)), plan)
  assert.equal(conversationSignature(keyFor("build", { ttl: "5m" })), plan)
  assert.equal(conversationSignature(keyFor("build", { effort: "max" })), plan)

  assert.notEqual(conversationSignature(keyFor("build", { affinity: "ses_b" })), plan)
  assert.notEqual(conversationSignature(keyFor("build", { model: "claude-sonnet-5" })), plan)
  assert.notEqual(conversationSignature(keyFor("build", { provider: "claude-code-appical" })), plan)
  assert.notEqual(conversationSignature(keyFor("build", { scope: "no-tools" })), plan)
})

test("conversationSignature refuses compaction, the shared default bucket and junk", () => {
  assert.equal(
    conversationSignature(sessionKey("/work/repo", "claude-haiku-4-5::compaction::ses_a")),
    null,
  )
  assert.equal(conversationSignature(keyFor("plan", { affinity: "default" })), null)
  assert.equal(conversationSignature("/work/repo::claude-opus-5-5"), null)
  assert.equal(
    conversationSignature("/work/repo::m::tools::ses_a::context=not-json"),
    null,
  )
})

test("an agent switch moves the claude session id and switching back moves it again", () => {
  const plan = keyFor("plan")
  const build = keyFor("build")
  reset(plan, build)
  try {
    assert.deepEqual(handOffConversation(plan), { kind: "none" })
    setClaudeSessionId(plan, "claude-1")
    const planProcess = idleProcess()
    setActiveProcess(plan, planProcess)

    assert.deepEqual(handOffConversation(build), {
      kind: "handed-off",
      fromKey: plan,
      claudeSessionId: "claude-1",
    })
    assert.equal(getClaudeSessionId(build), "claude-1")
    assert.equal(getClaudeSessionId(plan), undefined)
    // Two children must never write one transcript.
    assert.equal(planProcess.killed(), true)

    // Same key again is the ordinary turn: nothing moves.
    assert.deepEqual(handOffConversation(build), { kind: "none" })

    // Back to plan resumes the conversation build continued, not plan's old one.
    const back = handOffConversation(plan)
    assert.equal(back.kind, "handed-off")
    assert.equal(getClaudeSessionId(plan), "claude-1")
    assert.equal(getClaudeSessionId(build), undefined)
  } finally {
    reset(plan, build)
  }
})

test("an effort change keeps the conversation too", () => {
  const high = keyFor("build", { effort: "high" })
  const max = keyFor("build", { effort: "max" })
  reset(high, max)
  try {
    handOffConversation(high)
    setClaudeSessionId(high, "claude-effort")
    assert.equal(handOffConversation(max).kind, "handed-off")
    assert.equal(getClaudeSessionId(max), "claude-effort")
  } finally {
    reset(high, max)
  }
})

test("a handoff keeps the todo ledger the same claude session owns", () => {
  const plan = keyFor("plan")
  const build = keyFor("build")
  reset(plan, build)
  try {
    handOffConversation(plan)
    setClaudeSessionId(plan, "claude-ledger")
    applyTaskCreateToolUse("claude-ledger", "toolu_1", { subject: "Write the fix" })
    applyTaskCreateToolResult("claude-ledger", "toolu_1", "Task #1 created")
    assert.equal(getLedger("claude-ledger").length, 1)

    handOffConversation(build)
    assert.equal(getLedger("claude-ledger").length, 1)
  } finally {
    reset(plan, build)
  }
})

test("a previous key with work in the air is not handed off and the turn replays", () => {
  const plan = keyFor("plan")
  const build = keyFor("build")
  reset(plan, build)
  try {
    handOffConversation(build)
    setClaudeSessionId(build, "claude-stale")
    handOffConversation(plan)
    setClaudeSessionId(plan, "claude-busy")
    const busy = idleProcess()
    busy.lineEmitter.on("line", () => {})
    setActiveProcess(plan, busy)

    assert.deepEqual(handOffConversation(build), {
      kind: "refused",
      fromKey: plan,
      reason: "busy",
    })
    // The previous key keeps its work...
    assert.equal(getClaudeSessionId(plan), "claude-busy")
    assert.equal(busy.killed(), false)
    // ...and this key's own id is older than the conversation, so it goes.
    assert.equal(getClaudeSessionId(build), undefined)
  } finally {
    reset(plan, build)
  }
})

test("a previous key whose live child runs on another account is not handed off", () => {
  const plan = keyFor("plan")
  const build = keyFor("build")
  reset(plan, build)
  try {
    handOffConversation(plan)
    setClaudeSessionId(plan, "claude-other-account")
    setActiveProcess(plan, idleProcess("/opt/claude-accounts/appical/claude"))

    const result = handOffConversation(build, {
      cliPath: "/opt/claude-accounts/default/claude",
    })
    assert.deepEqual(result, { kind: "refused", fromKey: plan, reason: "other-account" })
    assert.equal(getClaudeSessionId(build), undefined)
  } finally {
    reset(plan, build)
  }
})

test("another model, account or opencode session never takes the conversation", () => {
  const plan = keyFor("plan")
  const others = [
    keyFor("build", { model: "claude-sonnet-5" }),
    keyFor("build", { provider: "claude-code-appical" }),
    keyFor("build", { affinity: "ses_b" }),
  ]
  reset(plan, ...others)
  try {
    handOffConversation(plan)
    setClaudeSessionId(plan, "claude-mine")
    for (const key of others) {
      assert.deepEqual(handOffConversation(key), { kind: "none" })
      assert.equal(getClaudeSessionId(key), undefined)
    }
    assert.equal(getClaudeSessionId(plan), "claude-mine")
  } finally {
    reset(plan, ...others)
  }
})

test("a deleted opencode session forgets which key it last ran on", () => {
  const plan = keyFor("plan", { affinity: "ses_deleted" })
  const build = keyFor("build", { affinity: "ses_deleted" })
  reset(plan, build)
  try {
    handOffConversation(plan)
    setClaudeSessionId(plan, "claude-deleted")
    deleteActiveProcessesForSession("ses_deleted")
    // Even with an id planted again, nothing remembers plan as the current key.
    setClaudeSessionId(plan, "claude-deleted")
    assert.deepEqual(handOffConversation(build), { kind: "none" })
  } finally {
    reset(plan, build)
  }
})

/**
 * A fake `claude` that reports the session it resumed, or a fresh one, and
 * records every spawn's argv and every envelope it was sent.
 */
function createHandoffCli() {
  const cwd = mkdtempSync(join(tmpdir(), "opencode-conversation-handoff-"))
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
  process.stdout.write("2.1.280\\n")
  process.exit(0)
}
if (args.includes("--help")) {
  process.stdout.write("  --plugin-dir <path>\\n")
  process.exit(0)
}
const at = args.indexOf("--resume")
const sessionId = at >= 0 ? args[at + 1] : "claude-conversation-1"
record({ type: "spawn", args, sessionId })
emit({ type: "system", subtype: "init", session_id: sessionId })
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const envelope = JSON.parse(line)
  if (envelope.type !== "user") return
  record({ type: "input", sessionId, envelope })
  emit({
    type: "assistant",
    session_id: sessionId,
    message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
  })
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    usage: { input_tokens: 9, output_tokens: 4 },
  })
})
`,
    { mode: 0o755 },
  )

  const modelId = "claude-test-conversation-handoff"
  const model = createClaudeCode({
    cliPath,
    cwd,
    bridgeOpencodeMcp: false,
    proxyOpencodeMcpTools: false,
    proxyTools: [],
    interactive: false,
    autoContinueIncompleteTurns: false,
  }).languageModel(modelId)

  const affinity = "ses_handoff"
  const keyOf = (agent: string) =>
    sessionKey(
      cwd,
      `${modelId}::tools::${affinity}::context=${JSON.stringify(["claude-code", agent])}`,
    )

  return {
    keyOf,
    events: () =>
      readFileSync(eventsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as any),
    async turn(agent: string, prompt: any[]) {
      const call: LanguageModelV3CallOptions = {
        prompt,
        headers: { "x-session-affinity": affinity },
        providerOptions: { "claude-code": { opencodeAgent: agent } },
        tools: [
          { type: "function", name: "read", inputSchema: { type: "object", properties: {} } },
        ],
        abortSignal: AbortSignal.timeout(30_000),
      } as any
      const response = await model.doStream(call)
      const parts: LanguageModelV3StreamPart[] = []
      for await (const part of response.stream) parts.push(part)
      return parts
    },
    /** Resolve the version probe before any turn depends on it (h #g181). */
    async warmCliVersion() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const version = await detectCliVersion(cliPath)
        if (version) return version
      }
      throw new Error("the fake CLI never answered --version")
    },
    async cleanup() {
      for (const agent of ["plan", "build"]) {
        await deleteActiveProcessAndWait(keyOf(agent))
        deleteClaudeSessionId(keyOf(agent))
      }
      _resetConversationHandoffs()
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] }) as any
const assistant = (text: string) =>
  ({ role: "assistant", content: [{ type: "text", text }] }) as any

test("plan, then build, then plan again all continue one claude conversation", {
  timeout: 60_000,
}, async () => {
  _resetConversationHandoffs()
  const fake = createHandoffCli()
  try {
    assert.equal((await fake.warmCliVersion()).raw, "2.1.280")
    const system = { role: "system", content: "You are a helpful assistant." }

    await fake.turn("plan", [system, user("review the feature")])
    assert.equal(getClaudeSessionId(fake.keyOf("plan")), "claude-conversation-1")

    await fake.turn("build", [
      system,
      user("review the feature"),
      assistant("1. fix the door gate\n2. add a test"),
      user("1, 2 -> ok"),
    ])
    assert.equal(getClaudeSessionId(fake.keyOf("build")), "claude-conversation-1")
    assert.equal(getClaudeSessionId(fake.keyOf("plan")), undefined)
    assert.equal(getActiveProcess(fake.keyOf("plan")), undefined)

    await fake.turn("plan", [
      system,
      user("review the feature"),
      assistant("1. fix the door gate\n2. add a test"),
      user("1, 2 -> ok"),
      assistant("done"),
      user("anything left?"),
    ])
    assert.equal(getClaudeSessionId(fake.keyOf("plan")), "claude-conversation-1")

    const spawns = fake.events().filter((event) => event.type === "spawn")
    assert.equal(spawns.length, 3)
    assert.ok(!spawns[0].args.includes("--resume"))
    for (const spawn of spawns.slice(1)) {
      const at = spawn.args.indexOf("--resume")
      assert.ok(at >= 0, spawn.args.join(" "))
      assert.equal(spawn.args[at + 1], "claude-conversation-1")
    }

    // Nothing was replayed: each switched turn sent only its new message.
    const inputs = fake.events().filter((event) => event.type === "input")
    for (const input of inputs.slice(1)) {
      const sent = JSON.stringify(input.envelope)
      assert.ok(!sent.includes("conversation_history"), sent.slice(0, 400))
    }
    assert.ok(JSON.stringify(inputs[1].envelope).includes("1, 2 -> ok"))
    assert.ok(JSON.stringify(inputs[2].envelope).includes("anything left?"))
  } finally {
    await fake.cleanup()
  }
})
