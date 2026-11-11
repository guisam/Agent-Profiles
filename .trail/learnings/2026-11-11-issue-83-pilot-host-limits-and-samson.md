---
title: "Issue 83 pilot: host limits and fixture order"
author: Samson
date: 2026-11-11
branch: test/83-pilot-results
cost: { minutes: 14, tokens: 129105 }
touches:
  - test/fixtures/issue-83/prepare.mjs
  - test/fixtures/issue-83/shim.mjs
  - test/fixtures/issue-83/README.md
  - docs/host-observations.md
  - CLAUDE.md
  - test/issue-83-fixture.test.js
---

## Decided
#83 pilot (2026-11-11, 0.23.6, Opus 5.5, one run per cell): 7 pass, 2 not exercised, 0 fail; recorded in docs/host-observations.md. prepare.mjs now never runs init and never breaks the skill first; `--finish <dir> --case <case>` applies the fault after init. Shim flag --cut-output became --run because an agent named the old flag as the cause of the cut. The README matrix defers headless-CLI `delayed` and T3 `mcp-cut`.

## Tried and ruled out
Removing the skill before init: init refuses the configuration and writes no CLAUDE.md. Running init inside prepare.mjs: it sidesteps the maintainer's deny rule on `npx --no agent-profiles init` (rules only match commands the agent types). Testing `delayed` with `claude -p`: headless Claude Code waits for MCP servers before the first turn.

## Watch out
In new folders, `claude -p` did not apply the allow rules init writes to .claude/settings.json (Bash and PowerShell both denied; same rules via --allowedTools worked; cause unverified). On Windows the agent often uses the PowerShell tool, so allow the PowerShell(...) forms too. T3 starts the first turn while project MCP servers connect; judge by the first deferred_tools_delta listing mcp__agent-profiles__resolve versus the first tool call. The maintainer's checkout denies `init` for the agent; ask them to run it (in PowerShell use npx.cmd).
