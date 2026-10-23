---
title: Harness2 proposal and paired evaluation conversion prerequisites
author: Samson
date: 2026-10-23
branch: feat/28-materializer-adapter-seam
touches:
  - bin/agent-profiles.ts
  - src/materialize.ts
  - test/materialize.test.js
  - ".github/workflows/harness2.yml"
  - docs/hosts/harness2.md
  - docs/issue-20-package-contract-proposal.md
  - docs/issue-20-test-contract.md
  - integrations/harness2/.gitignore
  - integrations/harness2/agent_profiles_harness2/__init__.py
  - integrations/harness2/agent_profiles_harness2/bridge.py
---

## Decided
Issue #28 phases 3–4 live in integrations/harness2/agent_profiles_harness2/converters.py. start_migration copies captured config into a fresh isolated project, selects the named skill as required, installs/stamps, then starts a fork. Capture makes skills available; available roots are absent from the selected candidate-parent metadata. Seed search with the returned base stamp, not the original capture stamp. proposal_batch checks exact migration inventory/source bytes, emits package entrypoint proposals and explicit unsupported edits. Profile-derived text is model-specific and acceptance-only. evaluation_plan and evaluation_results emit existing strict native artifacts; retain the plan before external sweeps, ingest results through native CLI. Evidence remains external-claim and promotion explicit.

## Tried and ruled out
Using the original capture stamp unchanged for a skill candidate failed with candidate parent: explicit adopted selected metadata required. Modifying the immutable captured project would invalidate adoption provenance, so prepare a new project. Generated AGENTS.md is a composition, not a single profile source: pass the saved materialized before_tree to diff against seeded search and report generated text edits as unsupported. Raw captured-tree comparisons can map the original instruction file to PROMPT.md. Task-total costs and selected-harness judgments cannot substitute for per-base-rollout evidence.

## Watch out
Codex only for migration/evaluation; OpenCode layout is not a host integration. Arm roots and run IDs must differ, conditions must match the retained plan, and every judged base needs the matching pre-execution seeded_adapter sidecar. Export individual ledger costs before upstream to_dict drops entries; unknown costs/other metrics stay null. Workflow targets can be supplied explicitly, but native migrate plan must check all declared obligations. End-to-end tests exercise real Node proposal acceptance, candidate publication, plan/result retention and reporting with synthetic evidence, not live Codex executions. trail check still flags the existing filesystem compatibility oracle at test/materialize.test.js:764: the old learning positively preserves independent filesystem plan/receipt oracles, so retaining that test is correct. Explain this false positive in any future commit/PR; do not remove coverage or edit old learnings.
