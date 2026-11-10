---
title: Issue 82 interactive C1 replication result
author: Samson
date: 2026-11-10
branch: test/82-subagent-delivery
cost: { minutes: 24, tokens: 207846 }
touches:
  - CHANGELOG.md
  - docs/host-observations.md
  - docs/mcp.md
  - docs/wiki/MCP-service.md
  - docs/wiki/Ponytail-role-preset.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - test/fixtures/issue-82/README.md
  - test/fixtures/issue-82/prepare.mjs
---

## Decided
- Interactive CLI C1 (operator-run, entrypoint cli, session ac46dcf3) passed: fixture-reviewer child ran ToolSearch, resolve(mcp, role=reviewer), then work; both FIXTURE-FINAL lines and the 4-section end line; no 'coordinator' anywhere in the child transcript. Docs now say interactive matched C1 only; other interactive rows stay open in #82.
## Watch out
- Whether the operator passed --setting-sources is not visible in the transcript; record it as not recorded. Check for user-scope leakage by grepping tool names (graft/trail) and the fixture for a graft/ dir.
- Interactive child meta.json showed requestShape background; children still return via SubagentHandback.
- A foreground npm test that exceeds the Bash timeout gets moved to background and its redirected log can stop with no summary; run the full suite with run_in_background from the start.
