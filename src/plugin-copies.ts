import type { LanguageModelV3 } from "@ai-sdk/provider"
import { log } from "./logger.js"

/**
 * Every copy of this plugin one opencode 2 process has loaded, and which of
 * them runs each turn, so a rebuild applies without a restart (h #g269).
 *
 * opencode 2 re-imports a plugin whose files change and sets the new copy up,
 * but keeps calling the language model the FIRST copy's `sdk` hook built, in
 * every session, old and new (measured on 2.1.4, h #g268). Each copy is its own
 * module with its own state: its `claude` children, their parked proxy calls,
 * its forms, the Claude sessions it remembers. So a turn cannot simply be
 * handed to the newest copy's code; the conversation has to move with it.
 *
 * It moves the way an opencode restart moves it, which is already safe: the
 * old copy stops its idle `claude` and keeps the resume record on disk
 * (`src/session-resume-store.ts`), and the new copy's first turn `--resume`s
 * from that record. Two rules decide when:
 *
 *  - The process switches to the newest copy at the first turn that finds
 *    every OTHER copy `quiet`: no turn streaming or parked, no proxied call
 *    outstanding, no explicit task model waiting for its child. Process-wide
 *    rather than per session, because a parent and the children its `task`
 *    calls start share in-memory state in the copy that served the parent. At
 *    the switch every older copy stops its idle `claude` children.
 *  - A session an older copy still `holds` (a turn in flight, a parked call, a
 *    form whose answer its next turn carries) is finished there, and moves on
 *    its first turn after.
 *
 * What a switch loses is what a restart loses: in-memory conveniences (the
 * todo ledger, a child's explicit model after its first turn, the background
 * collect ledger), never work in flight.
 *
 * The shape under the key is a contract between builds. The FIRST copy's
 * routing code runs for the life of the process and calls methods that every
 * later copy implements, so it may only grow; a change that breaks it takes a
 * new key, and a copy under a key the first copy does not read is never routed
 * to (the restart note then stays true, and says so).
 */

/** What a copy needs to build its own model for a turn another copy was called for. */
export interface PluginCopyTurn {
  /** The `setup` location whose `sdk` hook built the calling model. */
  directory: string | undefined
  providerID: string
  modelId: string
  /** What opencode's `sdk` hook handed the calling copy. */
  sdkOptions: Record<string, unknown>
}

export interface PluginCopy {
  /** Unique per module evaluation, so two loads of one version differ. */
  readonly id: string
  readonly version: string
  /** The build this copy was imported from, as `src/stale-build.ts` recorded it. */
  readonly build: { entryPath: string; mtimeMs: number | undefined; size: number | undefined }
  /** Every `setup` of this copy was disposed: the process never switches TO it. */
  disposed: boolean
  /** Work for this session that only this copy can finish. */
  holds(sessionID: string): boolean
  /** Nothing in flight in any session. */
  quiet(): boolean
  /** Stop idle `claude` children (one session's, or all), keeping resume records on disk. */
  release(sessionID?: string): Promise<unknown>
  /** This copy's own model for the turn. Never routes again. */
  modelFor(turn: PluginCopyTurn): Promise<LanguageModelV3>
}

/** A turn routed to a copy whose stream has not ended yet. */
interface RoutedTurn {
  copy: PluginCopy
  sessionID: string | undefined
  startedAt: number
}

interface PluginCopiesState {
  /** In load order. */
  copies: PluginCopy[]
  /** The copy new work goes to. */
  active: PluginCopy | undefined
  /** Set while the older copies stop their children after a switch. */
  switching: Promise<void> | undefined
  /**
   * From routing to the end of the turn's stream. A copy's own `quiet` sees a
   * turn only once its `claude` is writing, and the prologue before that can
   * take seconds; a switch in that gap would stop the child the turn is about
   * to use.
   */
  turns: Map<object, RoutedTurn>
}

/**
 * A routed turn older than this is taken to have been dropped without its
 * stream ending, and stops holding the switch back. A turn's stream ends at
 * every proxied tool call (a parked call is `quiet`'s business), so a real one
 * is far shorter.
 */
export const ROUTED_TURN_LIMIT_MS = 2 * 60 * 60_000

const COPIES_KEY = Symbol.for("@khalilgharbaoui/opencode-claude-code-plugin/copies/v1")

function copiesState(): PluginCopiesState {
  const holder = globalThis as { [COPIES_KEY]?: PluginCopiesState }
  let state = holder[COPIES_KEY]
  if (!state) {
    state = { copies: [], active: undefined, switching: undefined, turns: new Map() }
    holder[COPIES_KEY] = state
  }
  return state
}

function routedTurns(state: PluginCopiesState, now: number): RoutedTurn[] {
  for (const [token, turn] of state.turns) {
    if (now - turn.startedAt > ROUTED_TURN_LIMIT_MS) state.turns.delete(token)
  }
  return [...state.turns.values()]
}

/** A copy's answer, or `fallback` when its code throws: one broken build must not stop the rest. */
function ask<T>(question: () => T, fallback: T): T {
  try {
    return question()
  } catch {
    return fallback
  }
}

async function releaseQuietly(copy: PluginCopy, sessionID?: string): Promise<void> {
  try {
    await copy.release(sessionID)
  } catch (err) {
    log.warn("an older plugin build failed to release its claude sessions", {
      version: copy.version,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Join the process's copies. The first copy to register is the active one
 * until a newer one takes over at a quiet moment.
 */
export function registerPluginCopy(copy: PluginCopy): void {
  const state = copiesState()
  if (state.copies.includes(copy)) return
  state.copies.push(copy)
  state.active ??= copy
}

/**
 * Leave the process's copies: a disposed copy with nothing left that could
 * need it. If it was the active one, the next turn's switch picks another.
 */
export function unregisterPluginCopy(copy: PluginCopy): void {
  const state = copiesState()
  const index = state.copies.indexOf(copy)
  if (index !== -1) state.copies.splice(index, 1)
  if (state.active === copy) state.active = undefined
}

/** Whether `copy` is the one new work goes to. */
export function isActivePluginCopy(copy: PluginCopy): boolean {
  return copiesState().active === copy
}

/**
 * Whether a copy this process loaded was imported from exactly this build. The
 * stale-build note asks it: a build already loaded here takes over at the next
 * quiet moment, so there is nothing to restart for.
 */
export function processLoadedBuild(build: {
  entryPath: string
  version: string
  mtimeMs: number
  size: number
}): boolean {
  return copiesState().copies.some(
    (copy) =>
      !copy.disposed &&
      copy.version === build.version &&
      copy.build.entryPath === build.entryPath &&
      copy.build.mtimeMs === build.mtimeMs &&
      copy.build.size === build.size,
  )
}

/** Make the newest copy active once every other copy is quiet. */
function switchWhenQuiet(state: PluginCopiesState, now: number): void {
  if (state.switching) return
  const newest = [...state.copies].reverse().find((copy) => !copy.disposed)
  if (!newest || newest === state.active) return
  const others = state.copies.filter((copy) => copy !== newest)
  const busy = new Set(routedTurns(state, now).map((turn) => turn.copy))
  if (!others.every((copy) => !busy.has(copy) && ask(() => copy.quiet(), false))) return
  const previous = state.active
  state.active = newest
  log.info("switched to the newest plugin build", {
    from: previous?.version,
    to: newest.version,
  })
  state.switching = Promise.all(others.map((copy) => releaseQuietly(copy))).then(() => {
    state.switching = undefined
  })
}

/**
 * The copy that runs a turn: the one holding the session, else the active one.
 * A turn beside another of the same session (a title request beside the first
 * turn) lands where the first did, because a routed turn holds the switch back.
 */
function servingCopy(
  state: PluginCopiesState,
  sessionID: string | undefined,
  own: PluginCopy,
): PluginCopy {
  if (sessionID) {
    const holder = state.copies.find((copy) => ask(() => copy.holds(sessionID), false))
    if (holder) return holder
  }
  return state.active ?? own
}

/** The same stream, calling `end` once when it finishes, fails or is cancelled. */
function followStream<R>(source: ReadableStream<R>, end: () => void): ReadableStream<R> {
  const reader = source.getReader()
  return new ReadableStream<R>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          end()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        end()
        controller.error(err)
      }
    },
    async cancel(reason) {
      end()
      await reader.cancel(reason)
    },
  })
}

/** `result` with `end` called when the turn is over: after its stream, or now if it has none. */
function untilTurnEnds<T>(result: T, end: () => void): T {
  const stream = (result as { stream?: unknown } | undefined)?.stream
  if (!(stream instanceof ReadableStream)) {
    end()
    return result
  }
  return { ...result, stream: followStream(stream, end) }
}

/**
 * Run one turn on the copy that should serve it. `runHere` is the calling
 * copy's own turn; `runOn` runs it on another copy's model. With one copy this
 * is `runHere` with the turn's stream followed to its end.
 */
export async function routeTurn<T>(input: {
  own: PluginCopy
  turn: PluginCopyTurn
  sessionID: string | undefined
  runHere: () => PromiseLike<T>
  runOn: (model: LanguageModelV3) => PromiseLike<T>
  now?: () => number
}): Promise<T> {
  const state = copiesState()
  if (state.copies.length === 0) return input.runHere()
  const now = input.now ?? Date.now
  if (state.switching) await state.switching
  switchWhenQuiet(state, now())
  if (state.switching) await state.switching

  const sessionID =
    input.sessionID && input.sessionID !== "default" ? input.sessionID : undefined
  const target = servingCopy(state, sessionID, input.own)
  const token = {}
  state.turns.set(token, { copy: target, sessionID, startedAt: now() })
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    state.turns.delete(token)
  }
  try {
    // Whoever serves resumes this session's Claude conversation, so no other
    // copy may still have a child on it: two children never write one transcript.
    if (sessionID) {
      await Promise.all(
        state.copies
          .filter((copy) => copy !== target)
          .map((copy) => releaseQuietly(copy, sessionID)),
      )
    }
    if (target === input.own) return untilTurnEnds(await input.runHere(), end)

    let model: LanguageModelV3
    try {
      model = await target.modelFor(input.turn)
    } catch (err) {
      log.warn("the plugin build chosen for this turn could not take it; running it on this one", {
        version: target.version,
        error: err instanceof Error ? err.message : String(err),
      })
      const turn = state.turns.get(token)
      if (turn) turn.copy = input.own
      return untilTurnEnds(await input.runHere(), end)
    }
    return untilTurnEnds(await input.runOn(model), end)
  } catch (err) {
    end()
    throw err
  }
}

/** Test seam: forget every copy. */
export function _resetPluginCopiesForTests(): void {
  const state = copiesState()
  state.copies.length = 0
  state.active = undefined
  state.switching = undefined
  state.turns.clear()
}

/** Test seam: the copies in load order, and the active one. */
export function _pluginCopiesForTests(): { copies: PluginCopy[]; active: PluginCopy | undefined } {
  const state = copiesState()
  return { copies: [...state.copies], active: state.active }
}
