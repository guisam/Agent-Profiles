---
title: "Issue 80 live results: protocol 3 bootstrap needed for T3 MCP race"
author: Samson
date: 2026-11-06
branch: fix/80-compact-mcp-bootstrap
cost: { minutes: 25, tokens: 88406 }
touches:
  - docs/host-observations.md
  - ".agent-profiles/BOOTSTRAP.md"
  - CHANGELOG.md
  - README.md
  - docs/bootstrap.md
  - docs/mcp.md
  - docs/sessions.md
  - docs/wiki/MCP-service.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
---

## Decided
- PR #81 (0.19.3) passed live neutral-task runs (fresh, /clear, /compact) in T3 and Claude Code CLI with Opus 5.5: resolve ran before review each time, with the final End-of-context marker. That supports the bootstrap-only approach; lifecycle hooks stay deferred.
- The protocol 3 CLAUDE.md block is required, not optional: without it, T3 started reviewing before the MCP server finished connecting.
- #80 stays open (PR says Refs, not Closes) until shell fallback, subagents, oversized resolve output and a portable live fixture are done or explicitly deferred.

## Tried and ruled out
- Bound MCP server alone, without the project bootstrap: it lost the T3 startup race.
- Treating CONNECTION_CLOSED as a bootstrap result: it was a missing-dependency setup failure (ERR_MODULE_NOT_FOUND yaml), fixed by npm ci.

## Watch out
- Evidence is one sequence per host, operator-observed, with agent-reported tool histories. Don't describe it as guaranteed or universal reinjection.
- Loading the skills doesn't make reviews good: Claude still claimed missing tests without evidence.
- On this machine, unmodified HEAD fails 200 tests (environmental). Compare failure sets against a HEAD worktree baseline, not raw counts, and never baseline with git stash while a test run is in progress.
