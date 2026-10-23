---
title: OpenCode v2 native loading smoke and version boundary
author: Gfw
date: 2026-10-23
touches:
  - scripts/opencode-smoke.ts
  - AGENTS.md
  - docs/hosts/opencode-observations.md
---

## Decided
Issue #30 now has native Windows observations for installed OpenCode v2.1.3, pinned upstream bb25a2f4a3f3f04d7c344bec0c0574ea3510b3b1. scripts/opencode-smoke.ts is opt-in; default mode checks native project skill inventory, --live tests fresh-session native AGENTS.md plus configured instruction consumption and an actual skill tool invocation using random codes absent from the user prompt. Retained assistant context identifies opencode/big-pickle with build agent. See docs/hosts/opencode-observations.md.

## Tried and ruled out
The initial v1.19.4 source investigation is historical, not the installed v2 contract: v2 uses directory-derived skill IDs and sequential source loading. Fresh private-server skill.list can return empty before plugin activation; a successful config listing alone proves neither discovery completion nor model consumption. Session metadata alone omitted model/agent; retrieve retained assistant context instead. Do not alias native OpenCode execution to Codex.

## Watch out
The smoke uses a temporary fixture, preserves user/global/repository config, and leaves normal OpenCode service logs and sessions. Live mode uses the configured default and can incur usage. It does not implement --host opencode or validate profile routing, bootstrap execution, switching, subagents, duplicate precedence, stamp/migration/promotion or Harness2 assignment conversion. New versions need requalification; native skill inventory must wait for the fixture skill, not any globally installed skill.
