---
title: Harness2 adoption capture hooks identity and rollout provenance
author: Gfw
date: 2026-10-23
touches:
  - test/materialize.test.js
---

## Decided
Phase 2 of issue #28 lives in integrations/harness2/agent_profiles_harness2 (distribution agent-profiles-harness2). ProfilesBridge calls the Node CLI using argument arrays for add, revision record, offline install, stamp, materialize and diff. Capture creates isolated config3 projects and lock2 locks; it never updates the caller's active project. Codex captures use host codex; OpenCode captures leave host null with explicit model and role. Every editable source path maps to exact package bytes. Primary text becomes PROMPT.md, other always-on files become profile dependencies, skills retain their entrypoints/scripts, and an explicitly labelled empty structural role satisfies config selection. Versions encode 156 hash bits in three safe numeric fields and include dependency pins; content-store identity conflicts refuse collisions. Run IDs and evidence stay out of package/stamp identity.

## Tried and ruled out
A Library.add subclass alone cannot capture all adoptions: at pinned 1cfe254 the scheduler itself checks has_experience before calling add, including during resume. Use this package's run_task facade to perform post-task capture for every successful selection. CapturingLibrary remains available for direct add callers and preserves upstream validations and return values. Do not patch global upstream classes or edit Harness2 source. Do not stamp throwaway candidates. Do not attribute a changed mutable base tree to its old seed stamp: observe bytes before execution, compare against the materialized seed, and leave stampDigest null when changed.

## Watch out
The benchmark subclass must allow the original constructor to finish before redirecting base_harness; DemoAdapter overwrites its baseline in __init__. Keep native execute_many implementations. Read actual selected directories for capture fingerprints: upstream fingerprints include README stubs that read_tree intentionally excludes. Keep those short fingerprints as external claims alongside a full editable-tree SHA-256. Preserve adoption JSON, decision notes and EXPERIENCE.md as exact base64 evidence. Reject case-colliding paths and Windows device names before Python writes any staging files. A stale .capture-lock requires confirmation of no active writer before manual removal; do not auto-delete it. Captured bytes are exact, but re-materialization follows composition/trigger rules rather than reproducing the original layout byte-for-byte.

All 11 Python bridge tests passed on Ubuntu with Node 24 and the unchanged pinned upstream source, including the offline demo twice (two tasks, both modes, all four adoptions per sweep, identical package/stamp identities on repeat). Windows runs the 10 capture/hook tests and skips only the upstream fcntl-dependent demo. Python remains opt-in; the manual workflow uses Python 3.12 and Node 24. The existing trail check false positive on test/materialize.test.js remains explained in the earlier contract learning; carry that explanation into any future commit or PR.
