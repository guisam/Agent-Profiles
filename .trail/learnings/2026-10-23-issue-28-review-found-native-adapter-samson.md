---
title: Issue 28 review found native adapter seed bypass
author: Samson
date: 2026-10-23
branch: feat/28-materializer-adapter-seam
touches:
  - docs/issue-20-package-contract-proposal.md
  - docs/issue-20-test-contract.md
  - issue-harness2.md
  - CONTRIBUTING.md
---

## Decided
A read-only requirements review of issue #28 / PR #29 found a blocking native-adapter seeding defect despite passing demo and synthetic converter tests. At pinned upstream 1cfe254, WbAdapter.execute/execute_many(None) calls _install(None), which returns runs_root, fingerprint base, install_mode none without consulting base_harness. _launch then sets ws=None. Our seeded_adapter passes None unchanged but _profiles_identity attributes the materialized seed stamp. WorkBuddy base/candidate arms can therefore execute the default baseline under different stamp claims. LAB OpenCode similarly omits --harness-dir when the base marker is set; LAB Codex explicitly passes staging and is unaffected by that particular path.

## Tried and ruled out
Passing demo tests or asserting that base_harness points at a seed does not prove real adapters consume it. Confirmed with actual pinned WbAdapter.execute, minimal fixture initialization, a stub substrate launcher, temporary files and no models/credentials: the observed installation was install_mode none, staging differed from the seed, and the wrapper recorded the candidate stamp. This is a real execution-path bug, not a Trail lexical warning or an intentional external-claim limit.

## Watch out
Before merging, explicitly route seeded base executions into each supported adapter's real installation/launch path and test native WorkBuddy and LAB OpenCode paths without starting models. Both single and batched execution need coverage. Do not attribute a seed stamp solely from inspecting an unused seed directory. All six deliverable artifacts exist, but seeded-run acceptance is partial until fixed. CONTRIBUTING.md also requires an integration-behavior changelog entry, missing from PR29. User authorized recording findings on ticket #28; this review does not change implementation or merge the PR.
