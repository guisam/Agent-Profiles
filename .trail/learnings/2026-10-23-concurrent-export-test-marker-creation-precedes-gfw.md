---
title: Concurrent export test marker creation precedes payload
author: Gfw
date: 2026-10-23
---

## Decided
The macOS CI failure in P9-12 concurrent CLI exports was a test readiness race: the parent waited for marker-file existence, then immediately required before-final-rename text. writeFileSync creates/truncates the file before completing its write, so another process can observe an empty marker. atBarrier now requires the exact completed phase text while preserving its original worker-error/exit checks and bounded timeout.

## Tried and ruled out
A deterministic regression opens an empty real marker file, calls the actual shared atBarrier helper, and asserts it has not completed before writing the signal. It failed before the fix with true !== false, matching CI's empty-string versus before-final-rename assertion. Increasing sleeps/timeouts or weakening the downstream phase assertion would not fix readiness. No production export or OpenCode code needed changing.

## Watch out
The helper is shared by the P9-09 two-target export and P9-12 complete offline workflow. Both original scenarios and the new regression passed after the predicate fix. File existence alone is not a complete cross-process message; wait for the payload or publish it atomically. Keep the downstream destination-absence, exact marker, child result and rename-count checks intact. The macOS push job had passed at the same commit while the PR job failed, so a single green retry would not establish a fix.
