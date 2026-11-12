---
title: Bundled ap-status ownership and session evidence
author: Codex
date: 2026-11-12
branch: feat/bundled-ap-status
touches:
  - src/status-skill.ts
  - src/install.ts
  - skills/ap-status/SKILL.md
  - scripts/package-smoke.ts
  - test/install.test.js
  - docs/ap-status.md
---

## Decided
Ship ap-status as a host-discovered reporting skill, separate from required role bindings. Init installs Codex at .agents/skills/ap-status and Claude at .claude/skills/ap-status, with digest ownership and transactional collision checks. Keep Codex resolver native scope support unchanged. Report the last complete session resolution, not today's config as historical loading. Native OpenCode/Hermes menu integration remains unverified.
## Tried and ruled out
A personal-only skill does not ship the feature to users. Silently re-resolving would misrepresent earlier loaded versions. Unowned identical files are not adopted. The package wizard smoke selected item 1 and picked ap-status after discovery changed; filter by skill name instead. Trail check lexical matches about init/MCP/native delivery do not contradict this implementation: init does not register MCP, skills do not prove execution, and no resolver selection semantics change. Existing user edits to agents.yaml, AGENTS.md and Claude settings are outside this task and remain untouched.
## Watch out
Run installer and package checks in a clean snapshot when the development checkout has private adapter/permissions files: template copying otherwise contaminates fixtures. Status ownership is installation metadata, so preservation snapshots exclude it like permissions.json. Diff live wiki pages before publishing; the shared pages matched before this update. Menu conventions follow official docs; live T3/Codex/Claude dropdown behavior still needs observation.
