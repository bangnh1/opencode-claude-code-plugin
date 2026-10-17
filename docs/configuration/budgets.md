---
title: 'Budgets and caps'
description: 'A dollar cap on a conversation, per-agent turn and spend caps, and a ceiling on background subagents.'
sidebar:
  order: 9
---

Nothing else bounds what an opencode conversation spends through this plugin. Claude Code's own `--max-turns` and `--max-budget-usd` are per `claude` invocation, opencode's per-agent `steps` counts opencode steps (and the tools Claude runs itself never end a step, so a CLI-native tool loop is invisible to it), and background subagents fan out with no ceiling. The plugin is the one layer that sees every `result` the CLI reports, across respawns, accounts and the subagents a conversation starts, so the caps live here. All of them are **off unless set**.

```json
{
  "provider": {
    "claude-code": {
      "options": {
        "maxBudgetUsd": 5,
        "budgetWarnAt": [50, 80],
        "maxBackgroundSubagents": 3,
        "defaultSubagentMaxTurns": 40,
        "defaultSubagentMaxBudgetUsd": 1
      }
    }
  }
}
```

## A dollar cap per conversation: `maxBudgetUsd`

`maxBudgetUsd` caps one opencode conversation: its own turns plus every subagent it started, and every subagent those started. The amount is what Claude Code itself reports as `total_cost_usd` on each turn, which is list price: on a subscription it is a measure of how much of your usage the conversation took, not money charged.

- **Warnings.** At each percentage in `budgetWarnAt` (default `[50, 80]`) the turn that crossed it ends with one `▌ **budget:**` note naming what was spent and the cap. Each threshold is written once per conversation; a turn that jumps past two writes only the higher. `[]` turns the warnings off and keeps the stop. The turn that reaches the cap says the next message will not start.
- **The stop.** Once the conversation has spent the cap, the next message ends **before anything is spawned or sent to Claude**, with one `▌ **budget:**` note naming the amount, the cap and what to do, and finishes as an error (`budget_exceeded`). A turn that answers a tool call Claude is still waiting on (a foreground subagent's result, say) is never stopped, because ending it there would strand the call; the stop lands on the next new message.
- **The way out.** Raise `maxBudgetUsd` and **relaunch opencode** (plugin options are read once, at startup), or start a new session.
- **Subagents.** A child session's spend counts toward the conversation that started it. A child never writes a budget note, because its text can become the parent's `task` result; a child stopped at the cap ends with an error instead, so the parent's `task` result says why.
- **Compaction is exempt.** A `/compact` turn always runs, so a summary is always possible, and its spend still counts.
- `doGenerate` turns (opencode does not use them today) get the error finish and no note, since their text is a return value.

**What is not kept.** The ledger is in memory: an opencode restart starts every conversation again from zero. A conversation whose Claude session is resumed after a restart picks its earlier spend back up on its first turn, because Claude Code restores that session's running total; one that is replayed as text does not. `/claude-code-doctor` lists every conversation with recorded spend.

## Per-agent caps: `maxTurns` and `maxBudgetUsd` on an agent

An agent can carry Claude Code's own two caps, passed to its `claude` process as `--max-turns` and `--max-budget-usd`:

```yaml
---
description: Reads the codebase and reports back
mode: subagent
maxTurns: 30
maxBudgetUsd: 0.5
---
```

`defaultSubagentMaxTurns` and `defaultSubagentMaxBudgetUsd` in the provider options give every discovered `mode: subagent` agent that declares none a value, the way `defaultSubagentCacheTtl` does. The agent's own value wins. Both are part of the session key, so an agent with different caps gets its own process.

What the two count was measured on Claude Code 2.1.293, and they differ in the way that decides who may have them:

- **`--max-turns` counts API round trips per user message**, not over the process's life. A process capped at 3 answered three two-call messages in a row, and a message that hit a cap of 1 ended with `error_max_turns` while the same process answered the next message normally. So it is safe on any agent, a long-lived main conversation included. A turn that hits it ends as an error naming the cap.
- **`--max-budget-usd` counts over the whole process's life, and starts again on every `--resume`.** At $0.02 the second message ended `error_max_budget_usd` (that call still ran and billed) and every later message was refused at once with no API call. On a reused main conversation that would end every message once spent, and reset whenever the process did. So it is honoured **for discovered `mode: subagent` agents only**, whose dispatch gets a process of its own; a main agent declaring it is refused with one warning. Use `maxBudgetUsd` in the provider options for the conversation-wide cap.

Both are `--print` flags, so the [interactive transport](../guides/interactive-transport.md) cannot carry them and says so once. `--max-turns` needs Claude Code 2.1.280 or newer; `--max-budget-usd` is checked against `claude --help`. A CLI that cannot take one gets a warning and spawns without it. A value that is not a positive number (a whole one for `maxTurns`) is refused with a warning.

## A ceiling on background subagents: `maxBackgroundSubagents`

`maxBackgroundSubagents` caps how many [background subagents](../guides/background-subagents.md) run at once. A `background: true` `task`, or a `task_batch` with background tasks, that would put more to work than the cap allows is refused before it reaches opencode, with a tool result naming the cap and how many are running, and telling Claude to run the work in the foreground or later. A `task_batch` is refused whole, foreground tasks included, so a batch is never half-started. **Foreground dispatch is never capped.**

The running count is the one the doctor and the `Background subagents running now` line use: background dispatches Claude made through this opencode process, asked about with the same test `task_status` uses. When opencode cannot say whether one of them is still running within 2 seconds, the dispatch is refused rather than guessed, because a count that is too low is the harmful direction.

## Not in this release

A gate on the account's remaining usage (stop starting turns below N% of the 5-hour window) needs the account-usage readings another change is adding, and is a follow-up.
