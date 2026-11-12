---
title: Live adapter visualizer composition polling and trust withholding
author: Codex
date: 2026-11-12
branch: main
touches:
  - src/visualize.ts src/visualizer/app.js bin/agent-profiles.ts test/visualizer-live.test.js
---

## Decided
The visualizer enumerates validateConfiguration({root}) and preflights resolveInstructions({root,storeRoot}) from disk. Supplying an explicit composed configuration to the resolver would bypass adapter ownership, preview paths and locks. Exact adapterModels become picker choices only; supported hosts come from integrations.
Browser polling reuses the two read-only APIs. Changed successful payloads need two equal samples; failures hide old results immediately. Preserve valid selectors and optional skills, retain explicit undeclared launch fallbacks, and display removed-choice notices. Trust withholding is a successful resolver JSON response with withheld entries, so the browser must surface that field as an error. Stop timers on pagehide or connection loss; manual refresh reconnects.
## Tried and ruled out
Do not remove the CLI guard alone, mutate shared configure.readConfiguration, synthesize model declarations, strip host predicates, copy live configurations or repair locks/approvals automatically. Do not assume a source build upgrades a separately installed runtime. A reverted write during debounce must restore the visible result.
## Watch out
Existing unrelated tests and package smoke copy the working .agent-profiles configuration. Live schema-3/adapter edits can invalidate their assumed v1/v2 fixtures; verify this task in a disposable clean validation checkout and preserve the original failure log. Visualizer tests now author independent fixtures.
trail check reported lexical conflicts in this task's changelog and unrelated preexisting user edits. The changelog describes composed disk reads and unchanged trust, the opposite of the quoted prohibited explicit-config bypass. This task does not change bootstrap, trust, live project YAML or host settings. Retain those user edits outside the task commit.
