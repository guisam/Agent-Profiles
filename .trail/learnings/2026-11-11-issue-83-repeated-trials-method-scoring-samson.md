---
title: "Issue 83 repeated trials: method, scoring trap, trust cause"
author: Samson
date: 2026-11-11
branch: docs/83-trial-results
cost: { minutes: 8, tokens: 82932 }
touches:
  - test/fixtures/issue-83/README.md
  - CHANGELOG.md
  - docs/host-observations.md
  - package-lock.json
  - package.json
  - test/fixtures/issue-83/prepare.mjs
  - test/fixtures/issue-83/shim.mjs
  - test/issue-83-fixture.test.js
  - AGENTS.md
  - docs/wiki/Versioning-and-upgrades.md
---

## Decided
#83 item 5 ran 2026-11-11 on 0.23.7 with Opus 5.5: five runs per cell, 40 sessions, 40 pass (CLI headless: tool-error, mcp-cut, shell-cut, cli-enoent; T3: tool-error, shell-cut, delayed, cli-enoent). The maintainer runs `init` once per template project (it is denied for the agent); the agent copies each template per host and applies `prepare.mjs --finish`, re-checks the fault and deletes graft/ before every run, and appends each run to a JSONL ledger so a usage cutoff loses nothing. T3 runs went four at a time, one project per case.

## Tried and ruled out
Scoring "reviewed anyway" by keywords (verdict, blocking, findings) gave false fails on shell-cut: the stopping agents quote the cut skill text ("Rank findings: blocking def"). Decide from the tool trace first (no tools after the failed or cut resolve), and treat finals that open with "I haven't/didn't/can't review" as declined.

## Watch out
Claude Code's stderr names the headless permission cause: "Ignoring N permissions.allow entries from .claude/settings.json: this workspace has not been trusted". New fixture folders need --allowedTools (Bash and PowerShell forms). Earlier #83 PRs (0.23.6, 0.23.7) missed the wiki-copy entry required by AGENTS.md; check docs/wiki/Versioning-and-upgrades.md on every version bump.
