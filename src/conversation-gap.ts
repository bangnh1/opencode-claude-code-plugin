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
 * The messages `sessionKey`'s Claude session missed, or null.
 *
 * Null for every ordinary turn: no record, a chain that is not a prefix of
 * this prompt (a regenerated reply, an edited message: the session is reused
 * as it always was and nothing is invented about what it saw), a chain longer
 * than this prompt, or a tail past the chain holding nothing but assistant and
 * tool content, which is the session's own last reply.
 *
 * The prompt should be the conversation as the envelope builder sees it
 * (`filterSideQuestionHistory`), the same view `recordServedConversation` was
 * given, so a `/btw` or a doctor exchange that never reached the CLI is
 * neither recorded as seen nor replayed as missed.
 */
export function findMissedMessages(
  sessionKey: string,
  prompt: Prompt,
): MissedMessages | null {
  const record = served.get(sessionKey)
  if (!record) return null

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

  const recorded = record.chain
  if (recorded.length === 0 || recorded.length > history.length) return null
  for (let i = 0; i < recorded.length; i++) {
    if (recorded[i].role !== history[i].role) return null
    if (recorded[i].digest !== history[i].digest) return null
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
  return { messages: missed, userMessages }
}
