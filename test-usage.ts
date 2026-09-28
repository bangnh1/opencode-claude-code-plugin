/**
 * `toUsage` and `withLastIterationUsage`: mapping the CLI's counters onto the
 * AI SDK usage shape, and de-cumulating the turn total into the last internal
 * iteration so opencode reads the real end-of-turn context size — not the sum
 * across every tool-use iteration, which triggered compaction after one prompt.
 *
 * Usage: npx tsx --test test-usage.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { toUsage, withLastIterationUsage } from "./src/usage.js"

test("toUsage totals non-cached input, cache read and cache write", () => {
  const u = toUsage({
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 40,
  })
  assert.equal(u.inputTokens?.noCache, 10)
  assert.equal(u.inputTokens?.cacheRead, 400)
  assert.equal(u.inputTokens?.cacheWrite, 40)
  assert.equal(u.inputTokens?.total, 450)
  assert.equal(u.outputTokens?.total, 5)
})

test("toUsage prefers the last iteration over cumulative totals", () => {
  const u = toUsage({
    // The cumulative turn total the CLI reports on the result frame.
    input_tokens: 100,
    output_tokens: 5000,
    cache_read_input_tokens: 20_507_334,
    cache_creation_input_tokens: 9000,
    iterations: [
      { input_tokens: 3, output_tokens: 10, cache_read_input_tokens: 480_000, cache_creation_input_tokens: 2000 },
      { input_tokens: 6, output_tokens: 40, cache_read_input_tokens: 520_000, cache_creation_input_tokens: 3000 },
    ],
  })
  // The last iteration, never the 20.5M cumulative cache read.
  assert.equal(u.inputTokens?.cacheRead, 520_000)
  assert.equal(u.inputTokens?.cacheWrite, 3000)
  assert.equal(u.inputTokens?.noCache, 6)
  assert.equal(u.inputTokens?.total, 523_006)
  assert.equal(u.outputTokens?.total, 40)
})

test("withLastIterationUsage folds the last frame in as the single iteration", () => {
  const cumulative = {
    input_tokens: 10,
    output_tokens: 999,
    cache_read_input_tokens: 20_507_334,
    cache_creation_input_tokens: 3000,
  }
  const lastFrame = {
    input_tokens: 6,
    output_tokens: 30,
    cache_read_input_tokens: 520_000,
    cache_creation_input_tokens: 2000,
  }
  const merged = withLastIterationUsage(cumulative, lastFrame, 50)!
  // Cumulative fields are preserved for providerMetadata / billing fidelity.
  assert.equal(merged.cache_read_input_tokens, 20_507_334)
  // The de-cumulated last frame is the single iteration `toUsage` prefers,
  // with output summed across the turn's generations.
  assert.equal(merged.iterations?.length, 1)
  assert.equal(merged.iterations?.[0]?.cache_read_input_tokens, 520_000)
  assert.equal(merged.iterations?.[0]?.output_tokens, 50)

  // Fed through toUsage, opencode sees the real context, not the sum.
  const u = toUsage(merged)
  assert.equal(u.inputTokens?.cacheRead, 520_000)
  assert.equal(u.inputTokens?.total, 522_006) // 6 + 520000 + 2000
  assert.equal(u.outputTokens?.total, 50)
})

test("withLastIterationUsage falls back to cumulative when no frame carried usage", () => {
  const cumulative = { input_tokens: 11, output_tokens: 7 }
  const merged = withLastIterationUsage(cumulative, undefined, 0)
  assert.deepEqual(merged, cumulative)
  const u = toUsage(merged)
  assert.equal(u.inputTokens?.total, 11)
  assert.equal(u.outputTokens?.total, 7)
})

test("withLastIterationUsage uses the last frame's own output when the sum is zero", () => {
  const merged = withLastIterationUsage(
    { input_tokens: 1, output_tokens: 3 },
    { input_tokens: 6, output_tokens: 30, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    0,
  )!
  assert.equal(merged.iterations?.[0]?.output_tokens, 30)
})
