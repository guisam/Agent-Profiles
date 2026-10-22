---
title: Why the migration contract tests are slow
author: Samson
date: 2026-10-22
branch: chore/typescript-7
cost: { minutes: 2, tokens: 12566 }
touches:
  - CONTRIBUTING.md
  - bin/agent-profiles.js
  - docs/configure.md
  - docs/development/issue-20-contract.md
  - docs/setup.md
  - src/configure.ts
  - src/inspect.js
  - src/install.js
  - src/presets.ts
  - src/visualize.ts
---

## Decided
- Suite wall time is set by the slowest file: test/migration-promotion-contract.test.js (~696s summed, 51 tests). Measure per-file time with `node --test --test-reporter=junit --test-reporter-destination=<file>` and sum `time` by `file`.
- The cause is software, not hardware: one test made 183,698 lstat calls on 259 unique paths and 1,966 verifyObject calls for 6 store objects.

## Tried and ruled out
- Treating it as disk-bound or blaming parallelism alone: run alone, the test still takes ~12.6s, 57% of it in lstat.

## Watch out
- verifyObject (src/package-store.js) re-walks every path component via safePath, re-reads and re-hashes the tree on every call; revisionClosure, reconstructStamp, evaluationPlanBacking and lookupPackage call it repeatedly within one operation.
- The strictness is deliberate (link/junction and tamper detection, tested by "observer control" tests). Any cache must stay per operation and keyed on a stat snapshot; don't verify once per process.
- Profile one test with `node --cpu-prof --test --test-isolation=none --test-name-pattern=...`.
