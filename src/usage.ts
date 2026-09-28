/**
 * Mapping the Claude CLI's own counters onto the AI SDK's usage and finish
 * shapes.
 *
 * Split out of `claude-code-language-model.ts` verbatim. Neither function
 * ever read `this`, so both became free functions unchanged and the class
 * keeps its `toUsage` / `toFinishReason` methods as one-line delegates (the
 * turn controller binds them).
 */
import type {
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
} from "@ai-sdk/provider"
import type { ClaudeStreamMessage } from "./types.js"

export function toUsage(rawUsage?: ClaudeStreamMessage["usage"]): LanguageModelV3Usage {
  // Prefer the last iteration's counters over cumulative totals.
  // CLI usage is the sum across all internal tool-use iterations;
  // using it directly inflates context size and triggers premature compaction.
  const iter = rawUsage?.iterations
  const effective = iter?.length ? iter[iter.length - 1] : rawUsage
  // Claude CLI reports input_tokens as non-cached input only.
  // OpenCode expects total = noCache + cacheRead + cacheWrite.
  const noCache = effective?.input_tokens ?? 0
  const cacheRead = effective?.cache_read_input_tokens ?? 0
  const cacheWrite = effective?.cache_creation_input_tokens ?? 0
  return {
    inputTokens: {
      total: noCache + cacheRead + cacheWrite,
      noCache,
      cacheRead: cacheRead || undefined,
      cacheWrite: cacheWrite || undefined,
    },
    outputTokens: {
      total: effective?.output_tokens,
      text: effective?.output_tokens,
      reasoning: undefined,
    },
    raw: rawUsage as any,
  }
}

/**
 * Fold the last assistant frame's own usage into the terminal `result` frame's
 * usage so `toUsage` reports the real end-of-turn context size, not the turn's
 * cumulative total.
 *
 * The CLI's `result` frame sums input, cache and output across EVERY internal
 * API iteration of the turn. On a tool-heavy turn that runs the same cached
 * prompt through dozens of iterations, its `cache_read_input_tokens` sums into
 * the tens of millions — measured at 20.5M against a 1M window — so opencode
 * reads the context as thousands of percent full and compacts after a single
 * prompt. The last assistant frame's counters are the true final context, and
 * its outputs summed across frames are the turn's total generation.
 *
 * We hand that to `toUsage` as the single `iterations` entry it already
 * prefers, and leave the cumulative fields on the object untouched so
 * `providerMetadata` and the `turnStats` footer keep the real turn totals. When
 * no assistant frame carried usage (a fake CLI that reports usage only on the
 * `result` frame, or a CLI that omits it) the cumulative usage is returned
 * unchanged. Mirrors what the interactive transport builds by hand in
 * `claude-session-bun.ts`.
 */
export function withLastIterationUsage(
  cumulative: ClaudeStreamMessage["usage"],
  lastFrame: ClaudeStreamMessage["usage"] | undefined,
  summedOutput: number,
): ClaudeStreamMessage["usage"] {
  if (!lastFrame) return cumulative
  return {
    ...cumulative,
    iterations: [
      {
        input_tokens: lastFrame.input_tokens,
        output_tokens: summedOutput || lastFrame.output_tokens,
        cache_read_input_tokens: lastFrame.cache_read_input_tokens,
        cache_creation_input_tokens: lastFrame.cache_creation_input_tokens,
      },
    ],
  }
}

export function toFinishReason(
  reason: "stop" | "tool-calls" | "error" = "stop",
): LanguageModelV3FinishReason {
  return {
    unified: reason,
    raw: reason,
  }
}
