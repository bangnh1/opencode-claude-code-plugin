---
title: 'Billing'
description: 'What a turn draws from, which field says so, and the dated source for the policy.'
sidebar:
  order: 5
---

By default this plugin drives Claude Code headlessly (the Agent SDK path, `claude --print`). On a Claude subscription plan that usage draws from your plan's ordinary usage limits, the same pool as interactive Claude Code. Authenticating the CLI with an API key instead bills as ordinary pay-as-you-go API usage.

Anthropic's own page is the authoritative source and it changes: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>

> **Monthly API credits, since October 7, 2026.** Max and Team plans now include monthly credits for the Claude Platform (Max 5x $100, Max 20x $200, Team $20 per Standard seat and $100 per Premium seat, pooled and capped at $500; Pro and Enterprise are not eligible), claimed by linking one Console organization to the plan at claude.ai Settings > Billing. They are spendable on any Claude model through the Claude API, the Agent SDK and `claude -p`. For this plugin that means two routes, and `apiKeySource` on the doctor tells you which one a turn took: your subscription's usage limits (`oauth`, the default), or the API credits of the linked organization, reached by giving the `claude` CLI an API key from it (then `apiKeySource` is not `oauth`, and `ignoreAnthropicApiKey` must stay off). Anthropic's pages: [the Agent SDK with your plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) and [Monthly API credits for Max and Team plans](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans), both read on 2026-10-16.
>
> **The history, so older text does not mislead you.** Anthropic announced a separate monthly Agent SDK credit to start on June 15, 2026, and paused it the same day; from then until October 7 nothing had changed and `claude -p` drew only from subscription limits. Text from that window, here and elsewhere, is out of date. Re-read Anthropic's pages rather than this section when it matters.

One thing in this plugin interacts with the above: [`ignoreAnthropicApiKey`](./configuration/options.md) stops a stray `ANTHROPIC_API_KEY` in your environment from silently redirecting the CLI onto pay-as-you-go API billing. The experimental [interactive transport](./guides/interactive-transport.md) drives the real `claude` TUI instead of `--print`; it does not change what a turn draws from.
