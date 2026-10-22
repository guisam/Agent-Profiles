---
title: Running only affected tests
author: Samson
date: 2026-10-22
branch: chore/typescript-7
cost: { minutes: 127, tokens: 244216 }
touches:
  - CONTRIBUTING.md
  - bin/agent-profiles.js
  - docs/development/issue-20-contract.md
  - docs/visualize.md
  - src/visualize.ts
  - test/local-resources.test.js
  - test/package-callers.test.js
  - test/package-lock-resolution.test.js
  - test/review-regressions.test.js
  - test/visualize.test.js
---

## Decided
- `npm run test:affected` (scripts/affected-tests.js) picks test files by following static imports from each test. Any test whose source mentions `bin/agent-profiles` also counts as importing everything the CLI imports.
- Changes it cannot map (package.json, tsconfig, scripts/, fixtures) run the full suite. `.md` changes and renames/deletions add test/package-delivery.test.js, whose P9b-10 checks doc links.
- CI still runs the full `npm test`; affected runs are for local iteration, with full runs at checkpoints.

## Tried and ruled out
- `trail callers` alone: its call graph stops at process boundaries, so it misses the 21 of 44 test files that spawn the CLI with spawnSync or `npm exec`.

## Watch out
- The CLI imports 19 of 21 src modules, so most src changes still select about half the suite. src/files.ts is imported almost everywhere and selects all 44 files.
- When converting a module to .ts, don't sed scripts/package-smoke.js: its file lists and dist/ imports use the published .js names.
- Tests that copy src/ into a fake node_modules break on .ts (Node won't strip types there); install dist/ instead, as test/review-regressions.test.js does.
