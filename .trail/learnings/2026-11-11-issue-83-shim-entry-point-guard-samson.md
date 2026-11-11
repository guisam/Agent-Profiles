---
title: Issue 83 shim entry-point guard fails through macOS temp symlinks
author: Samson
date: 2026-11-11
branch: test/83-failure-fixtures
cost: { minutes: 6, tokens: 25110 }
touches:
  - CHANGELOG.md
  - package-lock.json
  - package.json
  - test/fixtures/issue-82/prepare.mjs
  - test/fixtures/issue-83/README.md
  - test/fixtures/issue-83/prepare.mjs
  - test/fixtures/issue-83/shim.mjs
  - test/issue-83-fixture.test.js
---

## Decided
The #83 shim and prepare scripts compare realpathSync(process.argv[1]) with realpathSync(fileURLToPath(import.meta.url)) to decide whether they were run directly.

## Tried and ruled out
path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) passed on Windows and Linux CI but failed on macOS: the tests copy the shim into os.tmpdir(), which is /var/folders -> /private/var. Node reports the main module by its real path while argv[1] keeps the symlinked spelling, so the guard skipped the CLI and the shim exited with no output ("Connection closed", empty stdout).

## Watch out
A Windows directory junction reproduces it locally (old guard: empty output through the junction; fixed: correct output). test/fixtures/issue-82/prepare.mjs still uses the path.resolve guard; it is only run from the repository checkout, so it was left unchanged.
