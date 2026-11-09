---
title: Role and model tuning separates retro evidence compaction and adoption
author: Samson
date: 2026-11-09
branch: docs/model-role-skill-tuning
touches:
  - CHANGELOG.md
  - docs/presets.md
  - docs/wiki/Versioning-and-upgrades.md
  - docs/wiki/_Sidebar.md
  - package-lock.json
  - package.json
  - ".trail-tuning-note.tmp"
  - docs/model-role-skill-tuning.md
  - docs/wiki/Tuning-skills-by-model-and-role.md
---

## Decided
Document a complete role inventory, one-skill-at-a-time candidate preparation, combined-role evaluation and exact model/role/host adoption. Retro belongs after code review and feeds the next tuning cycle. Mechanical errors belong in deterministic checks; policy changes are separate from equivalent compaction.

## Tried and ruled out
Do not adopt a shorter candidate from knowledge probes or screening ties alone. The companion TDD screening remains not adopted without held-out confirmation. Do not edit private dogfood configuration or increment stale working-source versions; use clean main for the documentation patch.

## Watch out
The root checkout retained unpublished version labels through 0.19.11 while main had consolidated the compaction preset as 0.19.7. This guide is 0.19.8 from main. trail check in the clean clone returned 'not a git repository' although git status and diff work; this is a tooling failure, not a passed conflict check. Preset import is not a full resource-tree distribution mechanism.
