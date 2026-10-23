---
title: Native Harness2 seed routing and immutable run inputs
author: Samson
date: 2026-10-23
branch: feat/28-materializer-adapter-seam
touches:
  - CHANGELOG.md
  - docs/hosts/harness2.md
  - integrations/harness2/agent_profiles_harness2/bridge.py
  - integrations/harness2/agent_profiles_harness2/converters.py
  - integrations/harness2/agent_profiles_harness2/hooks.py
  - integrations/harness2/test_bridge.py
  - integrations/harness2/test_converters.py
  - docs/issue-20-package-contract-proposal.md
  - docs/issue-20-test-contract.md
  - integrations/harness2/test_native_adapters.py
---

## Decided
Issue #28 native seeding is fixed by translating logical base harness_dir=None to the materialized seed path before both native execute and execute_many. This uses the real upstream staging/launch and content-based cache paths for WorkBuddy, LAB and JobBench on Codex/OpenCode without modifying upstream. Recognize the unchanged seed by resolved path plus captured tree digest so nested execute calls inside native batches retain identical attribution. Sidecars now record the actual 16-hex upstream content fingerprint; paired conversion refuses the old constant-base identity and requires consistent tree/fingerprint per arm.

## Tried and ruled out
A red regression against actual WbAdapter.execute showed UPSTREAM_DEFAULT reaching the launcher despite a seed stamp in the sidecar. Overriding base_harness alone is insufficient. A second red regression showed that rejecting changed run input only when recording completion happens too late: native output was already rerun. Reserve input identity in rollout-inputs before launching, separately from completed rollouts. Exact-input retries remain allowed after failures, but a run ID cannot be rebound to a different harness, task or stamp. Native batch implementations remain in use; do not replace them with serial loops or patch upstream base semantics.

## Watch out
Run IDs from the earlier literal-base scheme need fresh namespaces/evidence; do not rewrite old immutable sidecars. Failed launches retain only input reservations; partial native batches attribute only returned rollouts. Modified seeds and explicit throwaway candidates get no seed stamp. Six native regression methods cover the actual WB/LAB/JobBench staging/launcher matrix with external processes, credential checks and dataset locations replaced. The paired test materializes real base/candidate stamps, observes distinct instructions through native WB batching, then ingests its sidecars with fixture judgments through the real Node migration CLI. All 27 Python tests passed on WSL Ubuntu against the user's clean checkout at C:/workspace/harness2, pinned 1cfe254e8d25b15f37048c3730134686abe60335; Windows native tests and converters also passed. Live models/judge quality remain untested. Changelog and docs cover scope, limitations and reservations. Trail's historical vocabulary matches are documented false positives; retain compatibility oracles and explain the nonzero check in the commit/PR.
