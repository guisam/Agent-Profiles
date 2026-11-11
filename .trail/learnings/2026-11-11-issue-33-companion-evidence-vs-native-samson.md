---
title: Issue 33 companion evidence vs native AP evaluation contracts
author: Samson
date: 2026-11-11
branch: docs/33-tdd-completion-protocol
cost: { minutes: 1, tokens: 1489 }
touches:
  - docs/examples/tdd-completion-protocol.md
  - docs/guided-evaluation.md
  - docs/skill-migrations.md
---

## Decided
docs/examples/tdd-completion-protocol.md (0.23.5) proposes an Opus 5.5/Sonnet 5.5 implementer TDD protocol as a revision of the planned Luna/Sol example; it is not accepted or run. Companion results reach AP only through the native path: migrate start (host claude, fork) -> one package proposal replacing the baseline SKILL.md with frozen candidate bytes -> migrate candidate -> materialize -> migrate plan (before arms) -> migrate results from the private per-run ledger -> report -> preview/promote. Native `correct` = official frozen all-M; `unknown` counts as not correct; audited corrections stay beside it.

## Tried and ruled out
Do not relabel apsp-results/1 as native evidence; AP has no evidence import/export. The `update` route to a variant package delivers opt-in text but leaves `library evidence` untested, so it cannot satisfy #33 criteria 4/7. Do not grade configuration-exception or competing-instruction cases until the rule (D-1) and explicit-instruction precedence (D-2) are decided; clarification is a separate treatment from compaction.

## Watch out
A native candidate's planned release must be a new version of the BASELINE package name (`@apsp/test-driven-development-upstream`), not the companion's `@apsp/test-driven-development-<model>` variant name: same SKILL.md bytes, different identity (decision D-3). Companion experiments/tdd-opus-compaction/README.md and packages/test-driven-development-opus-5-5/STATUS.md are listed in smoke/FREEZE-1.1.0.sha256; correcting them needs an unfrozen note or a numbered post-run amendment, not a silent edit. trail check flags ~20 lexical matches on this doc (fixture/Luna/Sol/MCP vocabulary); the doc keeps fixture evidence separate from live claims and does not close #33.
