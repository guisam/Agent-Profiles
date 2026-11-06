---
title: Onboarding checks need isolated machine trust policy
author: Samson
date: 2026-11-06
branch: docs/npm-mcp-onboarding
cost: { minutes: 3, tokens: 2528 }
touches:
  - CHANGELOG.md
  - README.md
  - docs/setup.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - bin/agent-profiles.ts
  - docs/sessions.md
  - docs/trust.md
  - docs/versioned-packages.md
---

## Decided
For local onboarding documentation validation on a machine with an active trust policy, set AGENT_PROFILES_TRUST to a fresh absent scratch path only in the test process. The package smoke's source visualizer otherwise reads the real policy while its packaged CLI uses an isolated home, causing deep equality to differ by withheld: [].

## Tried and ruled out
Do not change the user's trust policy or application behavior for this docs task. The initial package check reproduced the mismatch at scripts/package-smoke.ts:786; rerun in an isolated test environment. Trail check's lexical overlaps on npm/MCP/approval vocabulary do not contradict retained rules: the new docs explicitly separate registration, approvals, and live host evidence.

## Watch out
Fixture checks establish mechanics, not actual onboarding or T3 behavior. Keep unrelated .trail/hook.cjs changes and user artifacts out of the PR. Wiki source goes in the PR; publish the live wiki after the maintainer merges.
