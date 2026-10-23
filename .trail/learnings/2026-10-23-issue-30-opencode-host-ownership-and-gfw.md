---
title: Issue 30 OpenCode host ownership and retained native evidence
author: Gfw
date: 2026-10-23
touches:
  - AGENTS.md
---

## Decided
Issue #30 adds the real opencode bootstrap host for OpenCode v2.1.3. Preserve Codex's legacy managed markers and give OpenCode a distinct marker pair in AGENTS.md. Fold shared-file installation edits into one transactional change; inspection and uninstall identify each host's span. Reject overlaps and retain bytes outside owned spans. Leave native JSON/JSONC and permissions untouched. Registry-based configuration, stamps and migrations retain host opencode directly.

## Tried and ruled out
A generic span detector mistakes a Codex block for OpenCode setup. Both native hosts read the shared file, so host-conditional blocks provide installer ownership rather than native isolation. Native testing also found that relying on default_role can conceal an omitted explicit assignment: the smoke now uses a different default role and requires the reviewer flag plus privately generated profile/role markers. Keep v1.19.4 research historical; v2 uses directory IDs and different loaders.

## Watch out
Canonical project bindings cover .opencode/skills/<id>/SKILL.md; global metadata covers native skill/skills roots and approved sources. Compatibility roots, flat files and arbitrary native overrides are outside this bounded inventory, and invocation stays host-controlled. Unknown model fallback and explicit provider/model provenance use existing selection semantics. New-session guidance cannot erase earlier native history or enforce a skill sandbox. Python fixtures cover real host capture through fork/proposal/candidate/paired results/preview/promotion and native batch seed consumption; judgments remain external claims. Live bootstrap/profile/role/skill consumption was observed using opencode/big-pickle, build. Preserve immutable null-host captures and require fresh run namespaces.

Trail's lexical conflicts around source investigation, native implementation, capture, routing and rejected approaches do not mean these safeguards were removed: v1 research is explicitly historical, native batching remains unchanged, pre-launch input reservations and exact paired coverage remain, and no Codex alias is used. Carry this rationale into the PR rather than deleting tests or rewriting prior learnings.
