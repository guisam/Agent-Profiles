---
title: Issue 33 PR scope and retained evidence limits
author: Samson
date: 2026-10-28
branch: feat/33-guided-evaluation
touches:
  - docs/guided-evaluation.md
  - docs/release.md
  - integrations/harness2/archive_profile_evidence.py
---

## Decided
Package the completed issue-33 work on feat/33-guided-evaluation based on current main; the older OpenCode PR #32 is already merged. Include guided evaluation/qualification, retained experiment reports, source-only pilot and archive tools, explicit Luna/Sol role-skill presets, routing regression, version policy, and upgrade docs. Keep the prepared 0.4.0 feature version and align current install examples with it; historical experiment versions stay historical.

## Tried and ruled out
Do not include the pre-existing unrelated .trail/hook.cjs modification, upload local raw model bundles implicitly, rerun stopped experiments, or auto-close issue #33. A novice end-to-end adoption/restoration demonstration and model-quality qualification remain unproven. Opening the PR publishes code and reports, not a package or production profile adoption.

## Watch out
Trail check reports 20 lexical overlaps in AGENTS.md and CHANGELOG.md. These describe version policy and retained evidence, not schema-version conflation, a second version source, fabricated historic skills, upstream-default seeding, permission bypass, automatic model execution, inferred quality, or authorized adoption. Preserve existing safeguards and learnings; record this rationale in the commit and PR. Raw run bundles remain outside Git; source reports clearly distinguish actual runs from offline configuration examples.
