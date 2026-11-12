---
title: Package smoke trust isolation and status protocol fixture
author: Codex
date: 2026-11-12
branch: feat/bundled-ap-status
cost: { minutes: 1, tokens: 8813 }
touches:
  - scripts/package-smoke.ts
  - test/protocol.test.js
---

## Decided
PR #120 CI needs the protocol fixture's exact modified-file list to include the two host skills and status ownership record. Package smoke must isolate AGENT_PROFILES_TRUST in both the parent process (direct imports) and child environment, restoring the parent value in finally. Keep the exact visualizer-versus-proof equality assertion.
## Tried and ruled out
Adding withheld: [] to the expected result only made the test match a developer machine with a trust policy. It fails on CI without one. The earlier clean source snapshot still leaked the parent process's machine policy. Do not loosen comparison or modify runtime output to accommodate this environmental mismatch.
## Watch out
Use a deliberately invalid external trust policy when running package smoke to prove no operator policy leaks into either execution path. Cache-off CI failed the same protocol file-list assertion, not a cache implementation defect. Runtime behavior is unchanged in 0.25.2.
