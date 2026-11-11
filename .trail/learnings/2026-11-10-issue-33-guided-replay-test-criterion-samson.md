---
title: Issue 33 guided replay test (criterion 9 mechanics)
author: Samson
date: 2026-11-10
branch: feat/33-guided-replay
cost: { minutes: 8, tokens: 93499 }
touches:
  - test/guided-replay.test.js
  - docs/guided-evaluation.md
  - CHANGELOG.md
  - test/helpers/promotion-fixture.js
---

## Decided
test/guided-replay.test.js reuses test/helpers/promotion-fixture.js (real store, candidate, plan, results, report) and chains selection -> unknown-host resolve refusal -> report readback -> refused decision for unevaluated models[1] -> preview (no writes) -> apply -> other models' pins unchanged -> guarded restore. There is no restore command: guarded restoration is the manual procedure in docs/guided-evaluation.md section 5, done in-test (compare saved after-bytes, refuse on difference, write before-bytes). Baseline readback is createStamp(f.input).digest === f.base.digest.

## Tried and ruled out
migrationPromotion readback has no status field; compare releaseDigest. doctor() reports a missing BOOTSTRAP.md for this fixture, so compare doctor errors before/after restore instead of asserting valid.

## Watch out
The fixture takes ~100 s per test on Windows (same as the promotion contract tests). Fixture evidence is caller claims (opaque:caller-claim refs); this covers criterion 9 mechanics only. Criteria 1, 4, 7 still need the live novice walkthrough and a separately approved budget. trail check flags the version bump and the "not model quality" doc line lexically.
