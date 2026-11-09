---
title: Vendor prompt audits nominate model-specific skill candidates
author: Samson
date: 2026-11-09
branch: docs/model-prompt-audit
touches:
  - CHANGELOG.md
  - docs/model-role-skill-tuning.md
  - docs/wiki/Tuning-skills-by-model-and-role.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
---

## Decided
Add a dated vendor-guidance audit before skill compaction. Anthropic prompt-audit and OpenAI's Astra skills guidance nominate candidates; exact-target behavioral evaluation governs adoption. Record source applicability and separate editorial, capability, selection, policy and runtime changes. Retro stays after code review and feeds the next cycle.

## Tried and ruled out
No global ban on think-first language: Sonnet 5.5 guidance has a task/settings-specific exception. Do not transfer Astra guidance to Sol or Luna without evidence. No equivalent built-in Codex prompt-audit command was verified. Do not remove approval or verification requirements as a wording cleanup.

## Watch out
Keep live skill pins and private configuration unchanged. Vendor web guidance changes: record access date, exact model and settings. trail check still returns not a git repository in the clean clone despite working Git; this is an unresolved tooling limitation, not a passing check.
