import type { LanguageModelV3 } from "@ai-sdk/provider"
import { conversationDigests, type ForkMessageDigest } from "./session-fork.js"
import { log } from "./logger.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * What each session key's Claude session was last asked, so a turn can tell
 * whether the conversation moved on without it (issue #114).
 *
 * The opencode agent is part of the session key, so one opencode conversation
 * that goes build -> plan -> build runs on two keys and two `claude`
 * processes, each with its own transcript. That is deliberate: a Claude
 * conversation answers under the system prompt recorded on its FIRST request
 * (h #g187, h #g223), so handing the plan agent's session to the build agent
 * would leave Claude under the plan agent's instructions while opencode has
 * granted build permissions. The cost of keeping them apart was this: a turn
 * on a reused process, or on a `--resume` of its own session, sends only the
 * messages after the last assistant reply, which is exactly right when that
 * reply was its own and exactly wrong when the other agent answered in
 * between. The build session was never told what the plan agent said, and
 * carried on from its own last reply, which the reporter saw as the agent
 * "referring to much earlier messages instead of the latest plan".
 *
 * So every key records the SHAPE of the conversation it was last asked to
 * continue (`conversationDigests` with `assistantContent: false`: user and
 * tool messages by content, assistant messages by position, the chain
 * `findSiblingResumePoint` compares, because a strict one cannot survive a
 * model change, h #g215), and the next turn on that key asks what lies
 * between that chain and the message it is about to send. A tail of nothing
 * but the session's own reply is the ordinary case and answers null. A tail
 * with a USER message in it is a conversation that went elsewhere, and the
 * slice from that message to the last assistant reply is what the caller
 * replays ahead of the current message, bounded like any replay.
 *
 * In memory only, like the fork fingerprints: after an opencode restart the
 * resume store (`findResumePoint`) refuses a session whose chain has user
 * messages past it and the whole thread is replayed, which covers the gap by
 * the expensive route. Pure apart from the map, injected with nothing, and
 * the caller decides what to do with the slice.
 */

interface ServedConversation {
  chain: ForkMessageDigest[]
  /** Insertion counter, for the cap's eviction order. */
  seq: number
}

const served = new Map<string, ServedConversation>()
let servedSeq = 0

/**
 * Same bound and reasoning as `MAX_CLAUDE_SESSION_ENTRIES` and
 * `MAX_FORK_FINGERPRINTS`: written only for keys this provider serves, and
 * capped so a long-lived `opencode serve` cannot grow it forever.
 */
export const MAX_SERVED_CONVERSATIONS = 64

/** Remember the conversation `sessionKey`'s Claude session was just asked to continue. */
export function recordServedConversation(sessionKey: string, prompt: Prompt): void {
  const chain = conversationDigests(prompt, { assistantContent: false })
  if (chain.length === 0) return
  // Re-inserting moves the key to the back, so the cap sheds the conversation
  // that has been quiet longest.
  served.delete(sessionKey)
  served.set(sessionKey, { chain, seq: ++servedSeq })
  while (served.size > MAX_SERVED_CONVERSATIONS) {
    const oldest = served.keys().next()
    if (oldest.done) break
    served.delete(oldest.value)
  }
}

/** Drop what was remembered for a key whose Claude session is gone. */
export function forgetServedConversation(sessionKey: string): void {
  served.delete(sessionKey)
}

/**
 * Move the record onto the key that is taking over the Claude conversation
 * (`transferClaudeSession`): the session is the same, so what it has seen is.
 */
export function moveServedConversation(fromKey: string, toKey: string): void {
  const record = served.get(fromKey)
  if (!record) return
  served.delete(fromKey)
  served.delete(toKey)
  served.set(toKey, { ...record, seq: ++servedSeq })
}

/** Test seam. */
export function _resetServedConversations(): void {
  served.clear()
  servedSeq = 0
}

export interface MissedMessages {
  kind: "missed"
  /**
   * The messages the session never saw, in order: from the first user message
   * past the recorded chain to the last assistant reply in the prompt. The
   * caller's own prompt objects, so it can hand them to the same renderer and
   * the same cleaning the rest of the envelope goes through.
   */
  messages: Prompt
  /** How many of them are user messages, for the log line. */
  userMessages: number
}

/**
 * The conversation this key's Claude session was asked to continue no longer
 * exists: the operator undid it, edited a message in it, or regenerated the
 * last reply, and the thread opencode is sending now is a different one that
 * shares a beginning with it.
 *
 * The session still holds the removed turns and will act on them, which is
 * what the caller fixes by starting a fresh one. Counts only: there is nothing
 * here to replay, because what is gone is gone and the thread that remains is
 * in the prompt.
 */
export interface RewoundConversation {
  kind: "rewound"
  /** How many messages of the recorded chain this prompt still has, in order. */
  sharedMessages: number
  /** How many recorded messages past that prefix this prompt does not have. */
  removedMessages: number
  /** How many of those were user messages. */
  removedUserMessages: number
}

export type ConversationChange = MissedMessages | RewoundConversation

/**
 * How the conversation moved since `sessionKey`'s Claude session was last
 * asked to continue it, or null when nothing can be said about it.
 *
 * Three answers:
 *
 * - `missed`: the recorded chain is a prefix of this prompt's history and
 *   there are USER messages past it. The conversation ran under another key
 *   (another opencode agent, another model) and came back, so the session
 *   needs to be told what it was. Issue #114, h #g239.
 * - `rewound`: the recorded chain and this prompt's history share a non-empty
 *   prefix, and the chain holds user messages past it that the prompt does
 *   not. The thread got shorter or diverged: an `/undo`, an edited message, a
 *   regenerated reply. The session's context still holds those turns, which is
 *   the caller's cue to drop it. h #g242.
 * - null: every ordinary turn, and anything neither rule can name.
 *
 * Two refusals are the point rather than an oversight, and both of them keep
 * today's behaviour:
 *
 * - A shared prefix of ZERO is never `rewound`. That is what an opencode
 *   compaction looks like from here (the head of the thread replaced by a
 *   summary), and a reused session has to survive one. The cost is that an
 *   undo back to the very first message, or an edit of it, is not recognised.
 * - A removed stretch with no USER message in it is never `rewound` either.
 *   A turn following a proxied tool call can re-render one opencode message's
 *   tool-call and text halves as one assistant message where the recorded
 *   chain has two messages and a `tool` between them, and killing a healthy
 *   session on every such turn would be far worse than the bug being fixed.
 *   An undo, an edit and a regenerate all remove at least one user message.
 *
 * The prompt should be the conversation as the envelope builder sees it
 * (`filterSideQuestionHistory`), the same view `recordServedConversation` was
 * given, so a `/btw` or a doctor exchange that never reached the CLI is
 * neither recorded as seen, replayed as missed, nor read as a rewind.
 */
export function classifyConversationChange(
  sessionKey: string,
  prompt: Prompt,
): ConversationChange | null {
  const record = served.get(sessionKey)
  if (!record) return null
  const recorded = record.chain
  if (recorded.length === 0) return null

  const messages = prompt as Array<{ role: string; content: unknown }>
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return null

  // Each conversation message up to the last reply, with the prompt index it
  // came from: `conversationDigests` skips system messages, so its positions
  // are not prompt positions.
  const history: Array<{ index: number; role: string; digest: string }> = []
  for (let i = 0; i <= lastAssistant; i++) {
    const msg = messages[i]
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") continue
    const [entry] = conversationDigests([msg] as Prompt, { assistantContent: false })
    history.push({ index: i, role: entry.role, digest: entry.digest })
  }

  let shared = 0
  while (
    shared < recorded.length &&
    shared < history.length &&
    recorded[shared].role === history[shared].role &&
    recorded[shared].digest === history[shared].digest
  ) {
    shared++
  }

  if (shared < recorded.length) {
    // The chain this prompt cannot account for. Both refusals documented
    // above live here, and both of them answer null, which is what every
    // caller did with this shape before.
    if (shared === 0) return null
    let removedUserMessages = 0
    for (let i = shared; i < recorded.length; i++) {
      if (recorded[i].role === "user") removedUserMessages++
    }
    if (removedUserMessages === 0) return null
    log.debug("this claude session holds turns the conversation no longer has", {
      sessionKey,
      recorded: recorded.length,
      shared,
      removedUserMessages,
    })
    return {
      kind: "rewound",
      sharedMessages: shared,
      removedMessages: recorded.length - shared,
      removedUserMessages,
    }
  }

  let firstUser = -1
  for (let i = recorded.length; i < history.length; i++) {
    if (history[i].role === "user") {
      firstUser = i
      break
    }
  }
  if (firstUser < 0) return null

  const from = history[firstUser].index
  const missed = messages.slice(from, lastAssistant + 1) as Prompt
  let userMessages = 0
  for (let i = firstUser; i < history.length; i++) {
    if (history[i].role === "user") userMessages++
  }
  log.debug("this claude session missed part of the conversation", {
    sessionKey,
    recorded: recorded.length,
    missed: missed.length,
    userMessages,
  })
  return { kind: "missed", messages: missed, userMessages }
}

/**
 * The messages `sessionKey`'s Claude session missed, or null. The `missed`
 * half of `classifyConversationChange`, kept because it is what the gap
 * replay is about and what most of its tests read.
 */
export function findMissedMessages(
  sessionKey: string,
  prompt: Prompt,
): MissedMessages | null {
  const change = classifyConversationChange(sessionKey, prompt)
  return change?.kind === "missed" ? change : null
}

/** Leading characters of the note a rewound thread writes into the reply. */
export const CONVERSATION_REWOUND_MARKER = "▌ **conversation rewound:**"

/**
 * The one thing on screen saying this turn started a new Claude session
 * because the thread it had been answering no longer exists (h #g242).
 */
export function formatConversationRewoundNote(): string {
  return (
    `\n${CONVERSATION_REWOUND_MARKER} this conversation was edited or undone, so the ` +
    `Claude session answering it still held the turns that were removed. This turn ` +
    `replays the thread as it stands now into a fresh Claude session, which no longer ` +
    `has them.\n`
  )
}
