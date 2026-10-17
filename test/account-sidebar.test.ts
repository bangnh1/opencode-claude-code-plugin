/**
 * The sidebar's `Accounts` lines (`src/account-sidebar.ts`, h #g244, h #g248):
 * which window an account's line is about, how it reads, which colour each
 * piece takes, that every account registered at startup is listed from the
 * first draw, and that an account the store knows nothing about is not.
 *
 * Usage: npx tsx --test test/account-sidebar.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  NO_READING_TEXT,
  accountUsageLines,
  formatResetClock,
  lineText,
  pressingWindow,
  resetSpellings,
  shortWindowName,
  type AccountUsageLine,
} from "../src/account-sidebar.js"
import type { AccountUsage, KnownAccounts, WindowUsage } from "../src/account-usage.js"
import { SIDEBAR_ROW_WIDTH } from "../src/subagent-sidebar.js"

const NOW = new Date(2026, 9, 17, 15, 30).getTime()
const AT_18 = new Date(2026, 9, 17, 18, 0).getTime()

function reading(over: Partial<WindowUsage> = {}): WindowUsage {
  return { utilization: 0.72, resetsAt: AT_18, status: "allowed_warning", observedAt: NOW, noted: [], ...over }
}

function usage(entries: Record<string, Record<string, WindowUsage>>): AccountUsage {
  return new Map(
    Object.entries(entries).map(([account, windows]) => [account, new Map(Object.entries(windows))]),
  )
}

/** What the server half registered at startup. */
function known(entries: Record<string, { tier?: string }>): KnownAccounts {
  return new Map(Object.entries(entries).map(([account, record]) => [account, { ...record, at: NOW }]))
}

const roleOf = (line: AccountUsageLine, text: string) => line.segments.find((segment) => segment.text === text)?.role
const painted = (line: AccountUsageLine) => line.segments.map((segment) => [segment.text, segment.role])

test("one line per account: name, window, percent and the local reset", () => {
  const lines = accountUsageLines(usage({ appical: { five_hour: reading() } }), NOW)
  assert.equal(lines.length, 1)
  assert.equal(lineText(lines[0]), "appical · 5h 72% · resets 18:00")
  assert.equal(lines[0].state, "ok")
})

test("a reset on another day carries its date in the usage note's notation, with or without the year", () => {
  const oct21 = new Date(2026, 9, 21, 12, 0).getTime()
  assert.equal(formatResetClock(oct21, NOW), "2026-10-21 12:00")
  assert.equal(formatResetClock(oct21, NOW, false), "10-21 12:00")
  assert.equal(formatResetClock(AT_18, NOW), "18:00")
  assert.deepEqual(resetSpellings(reading({ resetsAt: oct21 }), NOW), [
    "resets 2026-10-21 12:00",
    "2026-10-21 12:00",
    "10-21 12:00",
  ])
  assert.deepEqual(resetSpellings(reading(), NOW), ["resets 18:00"])
  assert.deepEqual(resetSpellings(reading({ resetsAt: undefined, resetsText: "6pm" }), NOW), ["resets 6pm", "6pm"])
  assert.deepEqual(resetSpellings(reading({ resetsAt: undefined }), NOW), [])
})

test("a reset on another day fits the row by dropping the word, then the year, the same way on every line", () => {
  const tomorrow = new Date(2026, 9, 18, 1, 20).getTime()
  const appical = (over: Partial<WindowUsage> = {}) => ({ five_hour: reading({ resetsAt: tomorrow, ...over }) })
  // `resets 2026-10-18 01:20` would be 42 cells with the name; without the word it fits.
  assert.equal(lineText(accountUsageLines(usage({ appical: appical() }), NOW)[0]), "appical · 5h 72% · 2026-10-18 01:20")
  // Given the room, the word stays.
  assert.equal(
    lineText(accountUsageLines(usage({ appical: appical() }), NOW, 60)[0]),
    "appical · 5h 72% · resets 2026-10-18 01:20",
  )
  // A window name that pushes one line over takes the year off every line, so the column reads alike.
  const two = accountUsageLines(
    usage({
      appical: { seven_day_opus: reading({ resetsAt: tomorrow }) },
      default: appical({ utilization: null, status: "allowed" }),
    }),
    NOW,
  )
  assert.deepEqual(two.map(lineText), ["appical · 7d opus 72% · 10-18 01:20", "default · 5h ok · 10-18 01:20"])
  // A reset today keeps its word beside them: it always fits.
  const mixed = accountUsageLines(usage({ appical: appical(), default: { five_hour: reading() } }), NOW)
  assert.deepEqual(mixed.map(lineText), ["appical · 5h 72% · 2026-10-18 01:20", "default · 5h 72% · resets 18:00"])
})

test("window names are short, an unknown one is shown as itself and `unknown` as nothing", () => {
  assert.equal(shortWindowName("five_hour"), "5h")
  assert.equal(shortWindowName("seven_day"), "7d")
  assert.equal(shortWindowName("seven_day_opus"), "7d opus")
  assert.equal(shortWindowName("brand_new"), "brand new")
  assert.equal(shortWindowName("unknown"), "")
})

test("the line is about the refused window first, else the fullest one", () => {
  const windows = new Map([
    ["five_hour", reading({ utilization: 0.4 })],
    ["seven_day", reading({ utilization: 0.81 })],
  ])
  assert.equal(pressingWindow(windows, NOW)?.[0], "seven_day")
  windows.set("seven_day_opus", reading({ utilization: null, status: "rejected" }))
  assert.equal(pressingWindow(windows, NOW)?.[0], "seven_day_opus")
})

test("a refusal reads `limited`, the interactive transport's included, with whatever reset it named", () => {
  const lines = accountUsageLines(
    usage({
      appical: { five_hour: reading({ utilization: null, status: "rejected" }) },
      default: {
        unknown: reading({ utilization: null, status: "rejected", resetsAt: undefined, resetsText: "6pm" }),
      },
    }),
    NOW,
  )
  assert.deepEqual(lines.map(lineText), ["appical · limited · resets 18:00", "default · limited · resets 6pm"])
  assert.deepEqual(lines.map((line) => line.state), ["limited", "limited"])
  assert.equal(roleOf(lines[0], "limited"), "error")
})

test("the level and the reset time are different roles, and the word `resets` stays muted", () => {
  const [line] = accountUsageLines(usage({ appical: { five_hour: reading() } }), NOW)
  assert.deepEqual(painted(line), [
    ["appical", "agent"],
    [" · ", "muted"],
    ["5h 72%", "muted"],
    [" · ", "muted"],
    ["resets ", "muted"],
    ["18:00", "reset"],
  ])
  // A refusal colours the level, never the time: the time is what the operator waits for.
  const [limited] = accountUsageLines(
    usage({ appical: { five_hour: reading({ utilization: null, status: "rejected" }) } }),
    NOW,
  )
  assert.deepEqual(painted(limited).slice(2), [
    ["limited", "error"],
    [" · ", "muted"],
    ["resets ", "muted"],
    ["18:00", "reset"],
  ])
  // With the word dropped, the whole date and time is the reset's.
  const tomorrow = new Date(2026, 9, 18, 1, 20).getTime()
  const [dated] = accountUsageLines(usage({ appical: { five_hour: reading({ resetsAt: tomorrow }) } }), NOW)
  assert.deepEqual(painted(dated).slice(3), [[" · ", "muted"], ["2026-10-18 01:20", "reset"]])
  // The interactive transport's phrase splits the same way, given the room; at the row's width it is cut.
  const phrase = usage({ appical: { five_hour: reading({ resetsAt: undefined, resetsText: "6pm (Europe/Amsterdam)" }) } })
  const [phrased] = accountUsageLines(phrase, NOW, 60)
  assert.deepEqual(painted(phrased).slice(4), [["resets ", "muted"], ["6pm (Europe/Amsterdam)", "reset"]])
  assert.equal(lineText(accountUsageLines(phrase, NOW)[0]), "appical · 5h 72% · 6pm (Europe/Amst…")
})

test("every account registered at startup is listed from the first draw: its tier and `no reading yet` until one arrives", () => {
  const lines = accountUsageLines(
    usage({ appical: { five_hour: reading() } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ default: { tier: "Max 20x" }, appical: { tier: "Max 5x" } }),
  )
  assert.deepEqual(lines.map(lineText), ["appical · 5h 72% · resets 18:00", "default · Max 20x · no reading yet"])
  assert.deepEqual(lines.map((line) => line.state), ["ok", "none"])
  assert.equal(lines[1].window, "")
  assert.deepEqual(painted(lines[1]), [
    ["default", "agent"],
    [" · ", "muted"],
    ["Max 20x", "tier"],
    [" · ", "muted"],
    [NO_READING_TEXT, "muted"],
  ])
  // An account with a reading shows the reading, never its tier.
  assert.equal(roleOf(lines[0], "Max 5x"), undefined)
  // Without a tier the line says only that no reading has arrived.
  assert.equal(
    lineText(accountUsageLines(new Map(), NOW, SIDEBAR_ROW_WIDTH, known({ default: {} }))[0]),
    "default · no reading yet",
  )
  // An account the store knows only from a reading (one from before this install registered any) is still listed.
  assert.deepEqual(
    accountUsageLines(usage({ old: { five_hour: reading() } }), NOW, SIDEBAR_ROW_WIDTH, known({ default: {} })).map(lineText),
    ["default · no reading yet", "old · 5h 72% · resets 18:00"],
  )
})

test("a registered account whose window has reset reads `no reading yet` again, and gives up its tier before it is cut", () => {
  const over = accountUsageLines(
    usage({ appical: { five_hour: reading({ resetsAt: NOW - 1 }) } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ appical: { tier: "Max 20x" } }),
  )
  assert.deepEqual(over.map(lineText), ["appical · Max 20x · no reading yet"])
  assert.equal(over[0].state, "none")
  // `appical-work · Max 20x · no reading yet` is 39 cells; at 30 the tier goes and the rest stays whole.
  const tight = accountUsageLines(new Map(), NOW, 30, known({ "appical-work": { tier: "Max 20x" } }))
  assert.equal(lineText(tight[0]), "appical-work · no reading yet")
  // A line with no reading does not move the reset column of the lines that have one.
  const tomorrow = new Date(2026, 9, 18, 1, 20).getTime()
  const mixed = accountUsageLines(
    usage({ appical: { five_hour: reading({ resetsAt: tomorrow }) } }),
    NOW,
    SIDEBAR_ROW_WIDTH,
    known({ workstation: { tier: "Enterprise" } }),
  )
  assert.deepEqual(mixed.map(lineText), ["appical · 5h 72% · 2026-10-18 01:20", "workstation · no reading yet"])
})

test("unknown utilization is `ok`, never 0%, and 75% or more takes the warning colour", () => {
  const lines = accountUsageLines(
    usage({
      a: { five_hour: reading({ utilization: null, status: "allowed" }) },
      b: { five_hour: reading({ utilization: 0.75 }) },
    }),
    NOW,
  )
  assert.equal(lineText(lines[0]), "a · 5h ok · resets 18:00")
  assert.equal(roleOf(lines[0], "5h ok"), "muted")
  assert.equal(lineText(lines[1]), "b · 5h 75% · resets 18:00")
  assert.equal(lines[1].state, "warning")
  assert.equal(roleOf(lines[1], "5h 75%"), "effort")
})

test("nothing is drawn for an account the store knows nothing about: an empty store, or an unregistered account whose reset passed", () => {
  assert.deepEqual(accountUsageLines(new Map(), NOW), [])
  assert.deepEqual(
    accountUsageLines(usage({ appical: { five_hour: reading({ resetsAt: NOW - 1 }) } }), NOW),
    [],
  )
})

test("a line never runs past the sidebar's width", () => {
  const lines = accountUsageLines(
    usage({ "a-very-long-account-name-indeed": { seven_day_overage_included: reading() } }),
    NOW,
    24,
  )
  assert.ok(Array.from(lineText(lines[0])).length <= 24, lineText(lines[0]))
})
