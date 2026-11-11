---
title: "Issue 105 repeats: T3 children, graft cache block, shell fallback"
author: Samson
date: 2026-11-11
branch: main
cost: { minutes: 10, tokens: 60469 }
touches:
  - CLAUDE.md
---

## Decided
2026-11-11: #105 S and O rows repeated 5x each as T3 delegate_task children: 10/10 pass (own variant, full end line, resolve before work, no coordinator text). Graft's user-scope prompt hook writes each session prompt to <project>/graft/.cache/session/; replacing that folder with an empty file in the fixture blocks it without touching global settings, and it stayed empty.
## Tried and ruled out
Assuming children use MCP: in this batch every child's first turn had the MCP server "still connecting", so all ten used the shell fallback (T3 startup race, as in #83). Attempt 3's children happened to get MCP.
## Watch out
Running `init --agent <other host>` rewrites every managed block to stock, so it drops fixture wrapper adaptations in CLAUDE.md; re-check blocks after any init. An unquoted Windows path in a bootstrap command fails in Bash (backslashes stripped); agents retried in PowerShell. `trail note` run during this work also wrote a copy into the fixture's .trail/learnings; delete such copies before live runs.
