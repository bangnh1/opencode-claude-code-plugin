/**
 * The sidebar's `Accounts` lines (`src/account-sidebar.ts`, h #g244): which
 * window an account's line is about, how it reads, and that nothing is drawn
 * without a current reading.
 *
 * Usage: npx tsx --test test/account-sidebar.test.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  accountUsageLines,
  formatResetClock,
  lineText,
  pressingWindow,
  resetSpellings,
  shortWindowName,
} from "../src/account-sidebar.js"
import type { AccountUsage, WindowUsage } from "../src/account-usage.js"

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
  assert.equal(lines[0].segments[1].role, "error")
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
  assert.equal(lines[0].segments[1].role, "muted")
  assert.equal(lineText(lines[1]), "b · 5h 75% · resets 18:00")
  assert.equal(lines[1].state, "warning")
  assert.equal(lines[1].segments[1].role, "effort")
})

test("nothing is drawn without a current reading: an empty store, or a window whose reset passed", () => {
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
