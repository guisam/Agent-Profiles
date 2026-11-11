---
title: "Issue 83 failure-case fixtures: shim, prepare cases, test traps"
author: Samson
date: 2026-11-11
branch: test/83-failure-fixtures
cost: { minutes: 5, tokens: 76445 }
touches:
  - CHANGELOG.md
  - docs/examples/tdd-completion-protocol.md
  - docs/guided-evaluation.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - test/guided-replay.test.js
  - test/fixtures/issue-83/shim.mjs
  - test/fixtures/issue-83/prepare.mjs
  - test/issue-83-fixture.test.js
---

## Decided
test/fixtures/issue-83/prepare.mjs builds one disposable project per case (tool-error, mcp-cut, shell-cut, delayed, cli-enoent) from the #80 fixture, reusing insideGit/run/SOURCE exported from test/fixtures/issue-82/prepare.mjs. shim.mjs (copied in as ap-shim.mjs) relays MCP stdio and halves tool-result text (--cut), delays server start (--delay), or halves a shell command's stdout (--cut-output). shell-cut needs --package because the block exists only after init; prepare then patches the block's resolve command to run through the shim (doctor reports the block modified, expected). Delay is 15 s to stay under Claude Code's MCP startup timeout. Nothing was run live; the 50-session matrix in the README waits for an approved budget.

## Tried and ruled out
Asserting /End of Agent Profiles context/ is absent fails on complete AND cut output: the resolve header quotes that phrase. Check for the complete final line instead. Asserting init exits 0 in a copied fixture fails: init writes the block, then exits 1 because the package is not installed there.

## Watch out
Children spawned from node --test inherit NODE_TEST_CONTEXT, so a script guarded by `!process.env.NODE_TEST_CONTEXT` skips its CLI entry point and exits at once (MCP "Connection closed"). Delete it from the child env. On Windows, use shell:true only for bare names like npx; an absolute node path with spaces breaks under the shell.
