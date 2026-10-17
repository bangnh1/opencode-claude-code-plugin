---
title: 'Subagents in the sidebar'
description: 'A progress line for the session, and a live list of its subagents: what each really runs as, what it has spent, and one click to open it.'
sidebar:
  order: 9
---

The session sidebar gets a **Subagents** section at the bottom while the session you are looking at has subagents, and a [**Progress** line](#progress) above it while that session's turn runs. One row per subagent, running ones first:

```
Progress
⠋ ▰▰▰▰▰▱▱▱▱▱  2/4 · 1m03s · bash
Subagents
⠋ explore Survey docs for stale…  bg
 haiku-4.5 · alpha · $0.07
 ▰▰▰▱▱▱▱▱▱▱  45s · 12 calls · read
⠋ implementor Fix the dispatch form…
 sonnet-5.5 · high · default · $0.42
 ▰▰▰▰▰▰▰▰▱▱  3/4 · 2m10s · edit
✓ explore Summarise README        bg
 haiku-4.5 · alpha · $0.03
```

- **The glyph** is a spinner in the theme's accent colour while the subagent runs, a ✓ when it finished and a ✗ when it failed or was cancelled. A finished row is greyed out.
- **Then the agent type and the task description**, cut with an ellipsis to fit the sidebar. A dim `bg` marks a [background](./background-subagents.md) dispatch, which is the one you would otherwise lose track of.
- **The muted second line is what the subagent really runs as**: model, reasoning effort, and on a multi-account install the account. It is read from what the plugin actually spawned, not from what opencode asked for, so an agent's `forceModel` or `reasoningEffort`, a [dispatch form](../configuration/subagents.md#choosing-per-dispatch-not-per-file) answer, the fallback chain and an account switch all show up here. opencode's own footer in the child session shows the model it asked for, which can differ. The effort is in colour, the theme's warning (yellow) colour, faded once the row is finished, because it is what most often differs from one subagent to the next. Effort appears once the subagent's first turn has started; a piece that is not known is left out. The line ends with **the subagent's spend so far**, `· $0.42`, in the theme's secondary colour: opencode's own cost figure for that child session, to the cent under ten dollars and five characters at most above (`$12.4`, `$123`), kept after the row finishes. When the line has no room for the dot a space stands in for it, and when it has no room for the number the number is left off: the model is never cut to make space for it.
- **A running row gets a third line**, the same [progress line](#progress) the session itself gets, measured from the subagent's own session.
- **Click a row** to open that subagent's session. opencode's own keys take you back: `up` returns to the parent, `left` and `right` step through the siblings. opencode routes to a session, never to a message, so the click opens the child session itself rather than scrolling the parent to the task.
- **Order and fading**: running rows oldest first, then the last three finished rows newest first; a finished row drops off after ten minutes. With more than two rows the heading gets a `▼` you can click to fold the list into `▶ Subagents (2 running)`, the same way opencode's own MCP and Todo sections fold. With no subagents the section is not there at all.

There is no option for any of it: it is always on, and it costs nothing while nothing runs. The spinner and the one-second tick behind the progress lines run only while a turn or a subagent is running; with only finished rows listed the sidebar rechecks them every 1.5 seconds.

## Progress

Above the subagents, under a **Progress** heading, one line for the session you are looking at, while its turn runs and for fifteen seconds after it ends:

```
Progress
⠋ ▰▰▰▰▰▱▱▱▱▱  2/4 · 1m03s · bash
```

There is no percentage, by design. Nothing in a model's task predicts how much of it is left, and a bar fed by the prompt, the model, the effort or the token count would be a guess drawn as a measurement. Everything on the line is measured:

- **The bar.** When the session has a todo list (Claude Code's `TaskCreate` family reaches opencode as `todowrite`; a subagent needs `permission: { todowrite: "allow" }` to keep one), the bar is the share of items completed, in the theme's success colour, and the line says which in bold: `2/4`. It never fills before the last item is done and never empties once the first is. Without a list the bar is a pulse, three cells sweeping the track in the accent colour, which says only that the session is working. opencode 2 hands a TUI plugin no todo list, so there every bar is the pulse.
- **Elapsed** since your last message (for a subagent, since its dispatch), the **tool calls** made since it (left out when a fraction is shown), and the **tool running now** in the theme's info colour. When the line is too wide the call count goes first, then the tool's name is cut.
- **When the turn ends** the bar fills in the success colour behind a ✓, or in the error colour behind a ✗ when the last reply failed, stays fifteen seconds, and goes. A subagent's line goes with its spinner. With nothing running there is no Progress section at all.

The colours are the theme's own, so every theme supplies them. On opencode 1: done cells `success`, the pulse `accent`, the track `textMuted` pulled halfway toward `backgroundPanel`, the fraction `text` in bold, the running tool `info`, a subagent's spend `secondary`. On opencode 2: `text.feedback.success`, `hue.accent`, `text.muted` toward `background`, `text.base`, `text.feedback.info`, `hue.interactive`.

## Account usage

Under the subagents, an **Accounts** section shows one line per account with a current [usage reading](../configuration/accounts.md#usage-before-the-limit):

```
Accounts
default · 5h ok · resets 18:00
work · 5h 76% · resets 18:00
```

- **The window** is the one that matters most for that account: a window that ran out first, otherwise the fullest one. `5h` and `7d` are the 5-hour and 7-day windows.
- **The level** is the percent used, in the theme's warning colour from 75%. `ok` means Claude Code reported the window without a number, which is how it reports an account with headroom. `limited` means the account is out, in the theme's error colour; on the [interactive transport](./interactive-transport.md) this is the only state there is, because it gets no readings.
- **The reset** is local time: `resets 18:00` today, and on another day the date in the notation the usage-limit note uses, `2026-10-18 01:20`. That date is too wide for the word `resets` beside a window and a level, so the word goes first and then the year (`10-18 01:20`), the same way on every line so the column reads alike. A line disappears once its window has reset.

With no reading at all, a single-account install included, there is no Accounts section. The readings come from `$XDG_STATE_HOME/opencode-claude-code-plugin/account-usage.json`, which the provider half writes and every opencode process shares. While a sidebar is on screen the TUI checks that file's size and time every 1.5 seconds and re-reads it only when it changed.

## Enabling it

**opencode 2.x**: nothing to do. opencode 2 loads the sidebar from the same `plugins` entry that loads the provider (the `<checkout>/dist` path or the package name).

**opencode 1.x**: opencode 1 loads TUI plugins from a different list than server plugins, `tui.json`'s `plugin` array, so the package needs one more line there. Next to `~/.config/opencode/opencode.json`, in `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

Use the same spec you have in `opencode.json`, a `file://` checkout path included. If you already have a `tui.json` (a theme, keybinds), add the line to its `plugin` array. Restart opencode fully afterwards; TUI plugins load once, at start. The provider keeps working without this line: only the sidebar section is missing.

## What it reads

The list is built from opencode's own state in the TUI: the current session's child sessions, its `task` (1.x) or `subagent` (2.x) tool calls, and the message opencode adds to the parent when a background subagent ends. The model, effort and account line comes from a small file the provider half writes, `$XDG_STATE_HOME/opencode-claude-code-plugin/session-spawns.json` (`~/.local/state/...` by default): one entry per session holding a model id, an effort level, an account name and a time, and nothing else. It is rewritten only when what a session spawns as changes, and bounded to the newest 256 sessions of the last seven days.

The progress lines read the session's messages from your last one on, their tool parts, the todo list opencode 1's TUI keeps per session, and opencode's own busy state; a subagent's spend is the `cost` on opencode's session record. They write nothing.
