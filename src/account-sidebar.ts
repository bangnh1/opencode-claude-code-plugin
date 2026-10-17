/**
 * The model behind the sidebar's `Accounts` section (`src/tui.ts`): one line
 * per account with a current usage reading, `appical · 5h 72% · resets 18:00`
 * today and `appical · 5h 72% · 2026-10-18 01:20` for a reset on another day
 * (h #g244, h #g246).
 *
 * Pure, like `src/subagent-sidebar.ts`, and for the same reason: the TUI bundle
 * runs on the terminal's own thread, where a logger writes over the interface
 * (h #g193). It imports only the store's reader types and that module's pure
 * helpers.
 *
 * Which window an account's line shows: a refused one first (the account is
 * out now, whatever its other windows say), else the fullest known one, else
 * any current reading (`ok`, a window the CLI reported without a utilization,
 * which is how it reports one with headroom). A reading whose reset has passed
 * describes a window that is over and is not shown at all.
 */
import { isReadingCurrent, usagePercent, type AccountUsage, type WindowUsage } from "./account-usage.js"
import { SIDEBAR_ROW_WIDTH, truncate, type Segment } from "./subagent-sidebar.js"

export interface AccountUsageLine {
  account: string
  window: string
  /** `limited` (refused), `warning` (at or past `WARNING_PERCENT`), or `ok`. */
  state: "limited" | "warning" | "ok"
  segments: Segment[]
}

/** Where a line takes the theme's warning colour: the CLI's own first warning level. */
export const WARNING_PERCENT = 75

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
    if (sameDay(new Date(entry.resetsAt), new Date(now))) return [`resets ${full}`]
    return [`resets ${full}`, full, formatResetClock(entry.resetsAt, now, false)]
  }
  if (entry.resetsText) return [`resets ${entry.resetsText}`, entry.resetsText]
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
  level: string
  name: string
  spellings: string[]
}

/**
 * Every account with a current reading, alphabetically, each laid out for
 * `width`. The reset is spelt the same way on every line, the widest spelling
 * in `resetSpellings` that fits all of them, so the column reads alike; a line
 * that fits no spelling is cut.
 */
export function accountUsageLines(
  usage: AccountUsage,
  now: number,
  width: number = SIDEBAR_ROW_WIDTH,
): AccountUsageLine[] {
  const drafts: LineDraft[] = []
  for (const account of [...usage.keys()].sort()) {
    const pressing = pressingWindow(usage.get(account)!, now)
    if (!pressing) continue
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
    drafts.push({
      account,
      window,
      state,
      level,
      name: truncate(account, Math.max(1, Math.floor(width / 2))),
      spellings: resetSpellings(entry, now),
    })
  }
  const cells = (value: string) => Array.from(value).length
  // `truncate` trims, so the space after the name is added outside it.
  const room = (draft: LineDraft) => Math.max(0, width - cells(draft.name) - 1)
  const rest = (draft: LineDraft, spelling: number) => {
    const reset = draft.spellings[Math.min(spelling, draft.spellings.length - 1)]
    return `· ${draft.level}${reset ? ` · ${reset}` : ""}`
  }
  const last = Math.max(0, ...drafts.map((draft) => draft.spellings.length - 1))
  let spelling = 0
  while (spelling < last && drafts.some((draft) => cells(rest(draft, spelling)) > room(draft))) spelling += 1
  return drafts.map((draft) => ({
    account: draft.account,
    window: draft.window,
    state: draft.state,
    segments: [
      { text: draft.name, role: "agent" },
      {
        text: ` ${truncate(rest(draft, spelling), room(draft))}`,
        role: draft.state === "limited" ? "error" : draft.state === "warning" ? "effort" : "muted",
      },
    ],
  }))
}

/** The plain text of a line, for tests and the collapsed summary. */
export function lineText(line: AccountUsageLine): string {
  return line.segments.map((segment) => segment.text).join("")
}
