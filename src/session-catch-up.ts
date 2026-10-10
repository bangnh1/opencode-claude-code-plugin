import type { LanguageModelV3 } from "@ai-sdk/provider"
import { conversationDigests, type ForkMessageDigest } from "./session-fork.js"

type Prompt = Parameters<LanguageModelV3["doGenerate"]>[0]["prompt"]

/**
 * What each session key's Claude session has been shown, so a turn can tell
 * which messages of the opencode conversation it has NOT seen.
 *
 * The opencode agent is part of the session key (a resumed Claude conversation
 * answers under the system prompt recorded on its first request, so plan and
 * build must not share one, h #g223). That gives every agent its own Claude
 * session, and the first switch to an agent replays the whole thread because
 * its key has nothing yet. The SECOND return to an agent is the gap: its key
 * already holds a session or a live child, so only the newest user message is
 * sent, and everything the other agent was asked and answered in between never
 * reaches it. Seen on an opencode 2 session: plan asked three numbered
 * questions, the operator switched to build and answered "1 -> ok 2 -> ok
 * 3 -> no", and build replied that the previous message had no numbered
 * questions.
 *
 * The chain is the same strict digest chain `forkSessions` and
 * `resumeAfterRestart` compare (`conversationDigests`), recorded every time the
 * plugin writes to the CLI, so it is current within a turn (tool-result steps
 * included) and holds with `resumeAfterRestart: false`. It lives in memory
 * only: after a restart a key with no record simply takes no catch-up, and the
 * restart lookup already refuses a conversation with user content past its
 * record, which replays the thread instead.
 */
const sentChains = new Map<string, ForkMessageDigest[]>()

/** Same bound and reasoning as `MAX_FORK_FINGERPRINTS`. */
export const MAX_SENT_CHAINS = 64

/** Remember that this key's Claude session has now been shown `prompt`. */
export function noteConversationSent(sessionKey: string, prompt: Prompt): void {
  const entries = conversationDigests(prompt)
  if (entries.length === 0) return
  sentChains.delete(sessionKey)
  sentChains.set(sessionKey, entries)
  while (sentChains.size > MAX_SENT_CHAINS) {
    const oldest = sentChains.keys().next()
    if (oldest.done) break
    sentChains.delete(oldest.value)
  }
}

/** Drop the record of a key whose Claude session is gone. */
export function forgetConversationSent(sessionKey: string): void {
  sentChains.delete(sessionKey)
}

/** Follow a Claude session that moved to another key. */
export function moveConversationSent(fromKey: string, toKey: string): void {
  const entries = sentChains.get(fromKey)
  sentChains.delete(fromKey)
  if (entries) {
    sentChains.delete(toKey)
    sentChains.set(toKey, entries)
  }
}

/** Test seam. */
export function _resetConversationsSent(): void {
  sentChains.clear()
}

export type MissedConversation =
  /** Nothing recorded for this key, or nothing it has not seen. */
  | { kind: "none" }
  /**
   * The recorded chain is not a prefix of this prompt: opencode compacted,
   * reverted or rewrote the conversation. Nothing is inserted, which is what
   * every turn did before this module existed.
   */
  | { kind: "diverged" }
  /**
   * `messages` are the prompt's messages this Claude session never saw, in
   * order, ending on the last assistant message before the current turn's own
   * trailing segment.
   */
  | { kind: "missed"; messages: Prompt }

/**
 * The part of `prompt` this key's Claude session has not been shown.
 *
 * Past the recorded prefix, everything up to the first user message is the
 * session's own reply to what it was last sent, which is in its transcript
 * already. From that user message to the last assistant message is what was
 * exchanged without it. The trailing segment after the last assistant message
 * is the current message, which `getClaudeUserMessage` sends as it always has.
 */
export function findMissedConversation(sessionKey: string, prompt: Prompt): MissedConversation {
  const recorded = sentChains.get(sessionKey)
  if (!recorded || recorded.length === 0) return { kind: "none" }

  const messages = prompt as Array<{ role: string; content: unknown }>
  const conversation: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const role = messages[i].role
    if (role === "user" || role === "assistant" || role === "tool") conversation.push(i)
  }
  const history = conversationDigests(prompt)
  if (recorded.length > history.length) return { kind: "diverged" }
  for (let i = 0; i < recorded.length; i++) {
    if (recorded[i].role !== history[i].role || recorded[i].digest !== history[i].digest) {
      return { kind: "diverged" }
    }
  }

  let lastAssistant = -1
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }
  let firstUnseenUser = -1
  for (let i = recorded.length; i < history.length; i++) {
    if (history[i].role === "user") {
      firstUnseenUser = i
      break
    }
  }
  if (firstUnseenUser < 0 || lastAssistant < firstUnseenUser) return { kind: "none" }
  // A trailing segment carrying a tool result is the middle of a tool round
  // trip: the CLI is parked inside a proxied call and a text block in front of
  // its `tool_result` is not something this has measured.
  for (let i = conversation[lastAssistant] + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === "tool") return { kind: "none" }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content as Array<{ type?: string }>) {
        if (part?.type === "tool-result") return { kind: "none" }
      }
    }
  }

  const from = conversation[firstUnseenUser]
  const to = conversation[lastAssistant]
  return { kind: "missed", messages: messages.slice(from, to + 1) as Prompt }
}
