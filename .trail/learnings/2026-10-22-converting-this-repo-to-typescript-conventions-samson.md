---
title: "Converting this repo to TypeScript: conventions and traps"
author: Samson
date: 2026-10-22
branch: chore/typescript-7
cost: { minutes: 124, tokens: 1331983 }
touches:
  - CONTRIBUTING.md
  - README.md
  - package.json
  - src/visualizer/app.js
  - tsconfig.json
  - tsconfig.strict.json
  - scripts/package-smoke.ts
  - scripts/affected-tests.ts
  - scripts/build.ts
  - test/review-regressions.test.js
---

## Decided
- Every source, the CLI (bin/agent-profiles.ts) and scripts are .ts and run directly on Node 24; only src/visualizer/app.js stays JS because the server sends it to the browser as-is. It is strict-checked through JSDoc.
- One strict tsconfig.json (checkJs on); tsconfig.strict.json was removed once the last file converted. npm run typecheck is a single tsc.
- The published package ships dist/ (Node refuses to strip types under node_modules). Tests that simulate an npm install keep the published layout: node_modules/agent-profiles/bin/agent-profiles.js and dist/ files, never src/.
- Parsed records validated at runtime (YAML maps, revision/stamp/lock JSON) use the `Untyped` alias from src/packages.ts and resolve.ts's `YamlMap`, not scattered `any`. Validators are typed as assertion functions (fields/identity/digest/validate) and take `unknown`.
- Converted files in import-count order (source importers first) so types reach the most callers soonest.

## Tried and ruled out
- Bulk sed over import paths that also hits scripts/package-smoke.ts: its expected-file lists and dist imports must keep published .js names.
- `git stash` on a file whose rename is staged: popping it conflicts (rename/delete). Copy the file aside for mutation checks instead.
- Name-based guesses when auto-annotating parameters: `root`/`id` are not always strings (closure(root) took a package pin; id validators must take unknown). Review every guess.

## Watch out
- JSDoc types are ignored in .ts files; a JSDoc cast or @param left in a converted file silently does nothing.
- `fail()`-style helpers must be function declarations returning `never`, or TypeScript will not narrow after them.
- Typing exposed two real latent bugs (resolveCandidateCapture skipped storeRoot() canonicalization; inspect read env[undefined] on Windows); see commits 7ea5eda and efdd180.
