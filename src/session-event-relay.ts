/**
 * One relay per opencode process for opencode 2's session events, shared by
 * every copy of this plugin the process has loaded (h #g268).
 *
 * opencode 2 re-imports a plugin whose files change (measured on 2.1.4: an
 * `npm run build` of a `file://` install, within a second, in every running
 * process) and disposes the old copy's setup, which ends the subscription
 * `followSessionEvents` runs. It keeps serving turns from the language model
 * the FIRST copy's `sdk` hook built, though. So after a reload the copy that
 * owns the `claude` processes and their parked proxy calls heard no event, and
 * the copy that heard them owned nothing: an operator's stop at a parked call
 * rejected nothing and interrupted nothing, a deleted session kept its
 * process, and the proxy deadline guard read every session as `unknown`.
 *
 * Every copy joins here, under a `Symbol.for` key on `globalThis`, the one
 * place two copies of a module can both reach. Whichever copy's subscription
 * is alive hands each event to every member, and each member acts only on its
 * own state, which is what already made two locations' subscriptions safe to
 * run side by side (h #g253). A member's run-state feed is open while ANY
 * subscription in the process is, and closes (forgetting, as a closed feed
 * must) only when the last one ends.
 *
 * Membership: a copy joins when its own subscription opens or when it first
 * registers a `claude` process (`noteRelayMemberServing`), and a copy that
 * never registered one leaves when its last subscription ends, so rebuilds do
 * not pin every copy they leave behind. A copy that served stays, because
 * opencode may hand it the next turn at any time and that execution's
 * `started` would otherwise be missed.
 *
 * The shape under the key is shared by every plugin version a process loads,
 * so it may only grow: a change that breaks it takes a new key.
 */

/** What a copy of the plugin hands the relay: its own handling, and its feed. */
export interface SessionEventRelayMember {
  /** Act on one event, on this copy's own state only. Idempotent. */
  handle(event: unknown): void
  /** A subscription is alive in the process: start trusting events. Idempotent. */
  feedOpened(): void
  /** No subscription is: forget what the events said. Idempotent. */
  feedClosed(): void
}

interface RelayState {
  members: Set<SessionEventRelayMember>
  /** Live subscriptions in the process, every copy's together. */
  followers: number
}

const RELAY_KEY = Symbol.for("@khalilgharbaoui/opencode-claude-code-plugin/session-event-relay")

function relayState(): RelayState {
  const holder = globalThis as { [RELAY_KEY]?: RelayState }
  let state = holder[RELAY_KEY]
  if (!state) {
    state = { members: new Set(), followers: 0 }
    holder[RELAY_KEY] = state
  }
  return state
}

/** One copy's fault must not cost the others their stop. */
function safely(action: () => void): void {
  try {
    action()
  } catch {
    // each member's handling logs its own outcomes
  }
}

let ownMember: SessionEventRelayMember | undefined
let ownFollowers = 0
let ownServed = false

function join(): void {
  if (!ownMember) return
  const state = relayState()
  if (state.members.has(ownMember)) return
  state.members.add(ownMember)
  if (state.followers > 0) safely(() => ownMember?.feedOpened())
}

function leave(): void {
  if (!ownMember) return
  if (relayState().members.delete(ownMember)) safely(() => ownMember?.feedClosed())
}

/** This copy's handling. Set once, at module load, by the V2 entry. */
export function defineOwnRelayMember(member: SessionEventRelayMember): void {
  ownMember = member
  if (ownServed) join()
}

/** This copy registered a `claude` process: it needs the events from now on. */
export function noteRelayMemberServing(): void {
  ownServed = true
  join()
}

/** Whether this copy ever registered a `claude` process. */
export function relayMemberHasServed(): boolean {
  return ownServed
}

/**
 * Leave the relay although this copy served: it was disposed and holds nothing
 * now (h #g269), so staying would only pin it in memory. A later spawn here
 * joins again through `noteRelayMemberServing`.
 */
export function leaveSessionEventRelay(): void {
  leave()
}

/** Declare one live subscription. The returned function ends it; calling it twice is a no-op. */
export function openRelayFollower(): () => void {
  const state = relayState()
  join()
  ownFollowers += 1
  state.followers += 1
  if (state.followers === 1) {
    for (const member of state.members) safely(() => member.feedOpened())
  }
  let closed = false
  return () => {
    if (closed) return
    closed = true
    ownFollowers = Math.max(0, ownFollowers - 1)
    state.followers = Math.max(0, state.followers - 1)
    if (state.followers === 0) {
      for (const member of state.members) safely(() => member.feedClosed())
    }
    if (ownFollowers === 0 && !ownServed) leave()
  }
}

/** Hand one event to every copy in the process, this one included. */
export function relaySessionEvent(event: unknown): void {
  const members = relayState().members
  if (ownMember && !members.has(ownMember)) safely(() => ownMember?.handle(event))
  for (const member of [...members]) safely(() => member.handle(event))
}

/**
 * Test seam: another copy of the plugin joining, as its own module would.
 * Returns its leave.
 */
export function _joinForeignRelayMemberForTests(member: SessionEventRelayMember): () => void {
  const state = relayState()
  state.members.add(member)
  if (state.followers > 0) member.feedOpened()
  return () => {
    if (state.members.delete(member)) member.feedClosed()
  }
}

/**
 * Test seam: another copy's live subscription, as its `openRelayFollower`
 * would count it. Events it receives go through `relaySessionEvent`, which is
 * the same code in every copy. Returns its end.
 */
export function _openForeignRelayFollowerForTests(): () => void {
  const state = relayState()
  state.followers += 1
  if (state.followers === 1) {
    for (const member of state.members) safely(() => member.feedOpened())
  }
  let closed = false
  return () => {
    if (closed) return
    closed = true
    state.followers = Math.max(0, state.followers - 1)
    if (state.followers === 0) {
      for (const member of state.members) safely(() => member.feedClosed())
    }
  }
}

/** Test seam: an empty relay, and this copy neither following nor serving. */
export function _resetSessionEventRelayForTests(): void {
  const state = relayState()
  for (const member of state.members) safely(() => member.feedClosed())
  state.members.clear()
  state.followers = 0
  ownFollowers = 0
  ownServed = false
}

/** Test seam: how many copies the relay holds, and how many subscriptions are live. */
export function _sessionEventRelaySizeForTests(): { members: number; followers: number } {
  const state = relayState()
  return { members: state.members.size, followers: state.followers }
}
