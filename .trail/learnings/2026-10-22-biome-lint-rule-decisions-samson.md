---
title: Biome lint rule decisions
author: Samson
date: 2026-10-22
branch: chore-add-biome
cost: { minutes: 24, tokens: 59125 }
touches:
  - bin/agent-profiles.js
  - biome.json
  - biome.jsonc
  - scripts/package-smoke.js
  - src/configure.js
  - src/external-skills.js
  - src/files.js
  - src/inspect.js
  - src/install.js
  - src/materialize.js
---

## Decided
- Config is biome.jsonc (plain biome.json rejects comments); each disabled rule has a one-line reason beside it.
- noControlCharactersInRegex is off globally: every hit was an intentional control-character sanitizer/validator.
- noTemplateCurlyInString and noDynamicNamespaceImportAccess are off for test/** only.
- useIterableCallbackReturn stays on: forEach callbacks use block bodies; catch blocks inside map/flatMap write `return fail(...)` because Biome can't see that fail() always throws.
- bin/agent-profiles.js is the hand-written CLI entry point, not generated; keep it linted.

## Tried and ruled out
- Per-site biome-ignore comments for control-char regexes: noise with no benefit.

## Watch out
- trail check keyword-matches "style"/"lineWidth" against the wide-lineWidth learning; hits on style.css filenames and yaml's `lineWidth: 0` option are false positives.
- Full `npm test` takes ~12 minutes; `npm run test:package` runs separately.
