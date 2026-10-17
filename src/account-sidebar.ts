/**
 * The model behind the sidebar's `Accounts` section (`src/tui.ts`): one line
 * per account this install runs, from the sidebar's first draw (h #g248).
 * With a current usage reading the line is `appical · 5h 72% · resets 18:00`
 * (`appical · 5h 72% · 2026-10-18 01:20` for a reset on another day, h #g244,
 * h #g246); before one has arrived it is `appical · Max 20x · no reading yet`.
 *
 * Pure, like `src/subagent-sidebar.ts`, and for the same reason: the TUI bundle
 * runs on the terminal's own thread, where a logger writes over the interface
 * (h #g193). It imports only the store's reader types and that module's pure
 * helpers.
 *
 * Which accounts: every account the server half registered at startup (the
 * configured list, or the one `default` account) plus any with a reading,
 * alphabetically. Which window an account's line shows: a refused one first
 * (the account is out now, whatever its other windows say), else the fullest
 * known one, else any current reading (`ok`, a window the CLI reported without
 * a utilization, which is how it reports one with headroom). A reading whose
 * reset has passed describes a window that is over and is not shown; the
 * account then reads `no reading yet` again, with the plan tier read off its
 * own `.claude.json` (`src/account-tier.ts`) when the store has one.
 *
 * Colours, by segment: the name in the text colour; the level in its state's
 * (`limited` in the error colour, 75% and up in the warning colour, else
 * muted); the reset time in its own (`reset`, the theme's info colour), so it
 * reads apart from the level beside it; the word `resets` and every separator
 * muted; the tier in its own (`tier`, the secondary colour).
 */
import {
  isReadingCurrent,
  usagePercent,
  type AccountUsage,
  type KnownAccounts,
  type WindowUsage,
} from "./account-usage.js"
import { SIDEBAR_ROW_WIDTH, truncate, type Segment } from "./subagent-sidebar.js"

export interface AccountUsageLine {
  account: string
  /** The window the line is about; empty on a line with no current reading. */
  window: string
  /**
   * `limited` (refused), `warning` (at or past `WARNING_PERCENT`), `ok`, or
   * `none` for an account no current reading describes.
   */
  state: "limited" | "warning" | "ok" | "none"
  segments: Segment[]
}

/** Where a line takes the theme's warning colour: the CLI's own first warning level. */
export const WARNING_PERCENT = 75

/** What a line says for an account no current reading describes. */
export const NO_READING_TEXT = "no reading yet"

/** The word ahead of a reset time, muted while the time takes its own colour. */
const RESET_WORD = "resets "
const SEPARATOR = " · "

const SHORT_WINDOWS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_opus: "7d opus",
  seven_day_sonnet: "7d sonnet",
  seven_day_overage_included: "7d extra",
  overage: "extra",
}

/** `five_hour` -> `5h`; an unknown window name is shown as itself, `unknown` as nothing. */
export function shortWindowName(window: string): string {
  if (window === "unknown") return ""
  return SHORT_WINDOWS[window] ?? window.replace(/_/g, " ")
}

const pad = (value: number) => String(value).padStart(2, "0")

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/**
 * A reset time in local time, in the usage-limit note's own notation
 * (`formatLocalMinute` in `src/cli-events.ts`, which this module cannot import
 * because that one logs): `18:00` today, `2026-10-21 12:00` on another day,
 * and `10-21 12:00` with `year` off, which is what a line falls back on.
 */
export function formatResetClock(resetsAt: number, now: number, year = true): string {
  const when = new Date(resetsAt)
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`
  if (sameDay(when, new Date(now))) return clock
  const date = `${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${clock}`
  return year ? `${when.getFullYear()}-${date}` : date
}

/**
 * How a line may say when its window resets, widest first: `resets 2026-10-18
 * 01:20`, then without the word, then without the year. A reset today is
 * `resets 01:20` only, since that always fits, and the interactive transport's
 * phrase has no year to drop. Empty when nothing is known.
 */
export function resetSpellings(entry: WindowUsage, now: number): string[] {
  if (entry.resetsAt !== undefined) {
    const full = formatResetClock(entry.resetsAt, now)
    if (sameDay(new Date(entry.resetsAt), new Date(now))) return [`${RESET_WORD}${full}`]
    return [`${RESET_WORD}${full}`, full, formatResetClock(entry.resetsAt, now, false)]
  }
  if (entry.resetsText) return [`${RESET_WORD}${entry.resetsText}`, entry.resetsText]
  return []
}

function rank(entry: WindowUsage): number {
  if (entry.status === "rejected") return 1000
  if (entry.utilization === null) return -1
  return usagePercent(entry.utilization)
}

/** The window an account's line is about, or undefined when none is current. */
export function pressingWindow(
  windows: ReadonlyMap<string, WindowUsage>,
  now: number,
): [string, WindowUsage] | undefined {
  let best: [string, WindowUsage] | undefined
  for (const [window, entry] of windows) {
    if (!isReadingCurrent(entry, now)) continue
    if (!best || rank(entry) > rank(best[1])) best = [window, entry]
  }
  return best
}

interface LineDraft {
  account: string
  window: string
  state: AccountUsageLine["state"]
  name: string
  /** `5h 72%`, `limited`, `7d ok`; empty on a line with no reading. */
  level: string
  /** The plan tier, drawn only on a line with no reading. */
  tier?: string
  spellings: string[]
}

const cells = (value: string) => Array.from(value).length
const segmentsCells = (segments: Segment[]) => segments.reduce((sum, segment) => sum + cells(segment.text), 0)

function levelRole(state: AccountUsageLine["state"]): Segment["role"] {
  return state === "limited" ? "error" : state === "warning" ? "effort" : "muted"
}

/**
 * Segments cut to `budget` cells: a run that does not fit is cut with `…`, and
 * a separator that does not fit ends the line, since nothing it would
 * introduce fits either.
 */
function fitSegments(segments: Segment[], budget: number): Segment[] {
  const out: Segment[] = []
  let used = 0
  for (const segment of segments) {
    const length = cells(segment.text)
    if (used + length <= budget) {
      out.push(segment)
      used += length
      continue
    }
    if (segment.text !== SEPARATOR) {
      const cut = truncate(segment.text, budget - used)
      if (cut) out.push({ ...segment, text: cut })
    }
    break
  }
  return out
}

/**
 * What follows the name: the level and the reset for a reading, each in its
 * own colour; the tier (while `withTier`) and `no reading yet` without one.
 */
function tailSegments(draft: LineDraft, spelling: number, withTier: boolean): Segment[] {
  if (draft.state === "none") {
    const out: Segment[] = []
    if (withTier && draft.tier) out.push({ text: SEPARATOR, role: "muted" }, { text: draft.tier, role: "tier" })
    out.push({ text: SEPARATOR, role: "muted" }, { text: NO_READING_TEXT, role: "muted" })
    return out
  }
  const out: Segment[] = [
    { text: SEPARATOR, role: "muted" },
    { text: draft.level, role: levelRole(draft.state) },
  ]
  const reset = draft.spellings[Math.min(spelling, draft.spellings.length - 1)]
  if (reset) {
    out.push({ text: SEPARATOR, role: "muted" })
    if (reset.startsWith(RESET_WORD)) {
      out.push({ text: RESET_WORD, role: "muted" }, { text: reset.slice(RESET_WORD.length), role: "reset" })
    } else {
      out.push({ text: reset, role: "reset" })
    }
  }
  return out
}

/**
 * Every account with a current reading or a registration, alphabetically, each
 * laid out for `width`. The reset is spelt the same way on every line, the
 * widest spelling in `resetSpellings` that fits all of them, so the column
 * reads alike; a line with no reading gives up its tier before it is cut, and
 * a line that fits nothing else is cut.
 */
export function accountUsageLines(
  usage: AccountUsage,
  now: number,
  width: number = SIDEBAR_ROW_WIDTH,
  known: KnownAccounts = new Map(),
): AccountUsageLine[] {
  const drafts: LineDraft[] = []
  const names = [...new Set([...usage.keys(), ...known.keys()])].sort()
  for (const account of names) {
    const name = truncate(account, Math.max(1, Math.floor(width / 2)))
    const windows = usage.get(account)
    const pressing = windows ? pressingWindow(windows, now) : undefined
    if (!pressing) {
      if (!known.has(account)) continue
      drafts.push({
        account,
        window: "",
        state: "none",
        name,
        level: "",
        tier: known.get(account)?.tier,
        spellings: [],
      })
      continue
    }
    const [window, entry] = pressing
    const state: AccountUsageLine["state"] =
      entry.status === "rejected"
        ? "limited"
        : entry.utilization !== null && usagePercent(entry.utilization) >= WARNING_PERCENT
          ? "warning"
          : "ok"
    const short = shortWindowName(window)
    const level =
      state === "limited"
        ? "limited"
        : entry.utilization === null
          ? `${short ? `${short} ` : ""}ok`
          : `${short ? `${short} ` : ""}${Math.round(usagePercent(entry.utilization))}%`
    drafts.push({ account, window, state, name, level, spellings: resetSpellings(entry, now) })
  }
  const budget = (draft: LineDraft) => Math.max(0, width - cells(draft.name))
  // The reset's spelling is decided over the lines that have one; a line with
  // no reading has nothing to spell and does not move the column.
  const spelt = drafts.filter((draft) => draft.state !== "none")
  const last = Math.max(0, ...spelt.map((draft) => draft.spellings.length - 1))
  let spelling = 0
  while (
    spelling < last &&
    spelt.some((draft) => segmentsCells(tailSegments(draft, spelling, true)) > budget(draft))
  ) {
    spelling += 1
  }
  return drafts.map((draft) => {
    const full = tailSegments(draft, spelling, true)
    const tail = segmentsCells(full) <= budget(draft) ? full : tailSegments(draft, spelling, false)
    return {
      account: draft.account,
      window: draft.window,
      state: draft.state,
      segments: [{ text: draft.name, role: "agent" }, ...fitSegments(tail, budget(draft))],
    }
  })
}

/** The plain text of a line, for tests and the collapsed summary. */
export function lineText(line: AccountUsageLine): string {
  return line.segments.map((segment) => segment.text).join("")
}
