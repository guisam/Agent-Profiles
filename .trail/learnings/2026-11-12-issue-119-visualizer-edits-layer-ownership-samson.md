---
title: "Issue 119 visualizer edits: layer ownership, locks, guarded POST"
author: Samson
date: 2026-11-12
branch: feat/119-skill-library-ui
touches:
  - CHANGELOG.md
  - bin/agent-profiles.ts
  - docs/visualize.md
  - docs/wiki/Live-visualizer.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/configure.ts
  - src/content-diff.ts
  - src/skill-catalog.ts
---

## Decided
- The user folded configuration editing into #119 (PR #122 branch). `visualize --edit` enables `POST api/edit`; without it the server stays read-only, and the 405 text "Read-only: GET required" is pinned by package-lock-resolution P5B-D04.
- src/config-edit.ts: applyConfigEdit checks a revision digest (project agents.yaml, agents.local.yaml, adapter agents.yaml) taken before api/config reads, so a stale page gets 409.
- Layer ownership: models, families and new roles go to the project (adapter PROJECT_ONLY). Skill edits on an adapter role, or adding an adapter-owned skill to a project role, go to the adapter overlay as an append. Project role edits reuse planRoleChange, applied through applyChanges with the resolver check and lock refresh inside the rollback guard.
- Locks: unlike `update` (#97), a project edit with an adapter refreshes the committed project lock AND the adapter lock, because the visualizer shows the composed config and its preflight would otherwise fail with stale-lock.
- Skill identity for the coming replace prompt is the SKILL.md frontmatter `name`. All @apsp/test-driven-development-* variants share `test-driven-development`.

## Tried and ruled out
- Calling applyRoleChange, then refreshing locks afterwards: a failed install would leave the config written with a stale lock.
- Changing the read-only 405 message to mention --edit: it breaks a pinned contract test.

## Watch out
- Node's fetch sends no Origin header. The fake-DOM helper (test/helpers/skill-library-fixture.js) adds one to POSTs, as a browser would.
- Not yet done: binding a new library package version to a role (needs a skills.<id> binding plus trust checks), and the replace prompt.
- Moving a skill between lists across layers is refused; the user removes it in the owning layer first.
