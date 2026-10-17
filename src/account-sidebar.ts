/**
 * The model behind the sidebar's `Accounts` section (`src/tui.ts`): one line
 * per account with a current usage reading, `appical · 5h 72% · resets 18:00`
 * (h #g244).
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/**
 * A reset time in local time, as short as it can be unambiguous: `18:00` today,
 * `Oct 21 12:00` on another day.
 */
export function formatResetClock(resetsAt: number, now: number): string {
  const when = new Date(resetsAt)
  const today = new Date(now)
  const pad = (value: number) => String(value).padStart(2, "0")
  const clock = `${pad(when.getHours())}:${pad(when.getMinutes())}`
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  return sameDay ? clock : `${MONTHS[when.getMonth()]} ${when.getDate()} ${clock}`
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

/** Every account with a current reading, alphabetically, each laid out for `width`. */
export function accountUsageLines(
  usage: AccountUsage,
  now: number,
  width: number = SIDEBAR_ROW_WIDTH,
): AccountUsageLine[] {
  const lines: AccountUsageLine[] = []
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
    const resets =
      entry.resetsAt !== undefined
        ? ` · resets ${formatResetClock(entry.resetsAt, now)}`
        : entry.resetsText
          ? ` · resets ${entry.resetsText}`
          : ""
    const name = truncate(account, Math.max(1, Math.floor(width / 2)))
    // `truncate` trims, so the space after the name is added outside it.
    const rest = ` ${truncate(`· ${level}${resets}`, Math.max(0, width - Array.from(name).length - 1))}`
    lines.push({
      account,
      window,
      state,
      segments: [
        { text: name, role: "agent" },
        { text: rest, role: state === "limited" ? "error" : state === "warning" ? "effort" : "muted" },
      ],
    })
  }
  return lines
}

/** The plain text of a line, for tests and the collapsed summary. */
export function lineText(line: AccountUsageLine): string {
  return line.segments.map((segment) => segment.text).join("")
}
