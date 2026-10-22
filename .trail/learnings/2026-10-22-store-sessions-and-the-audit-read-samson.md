---
title: Store sessions and the audit-read exemption
author: Samson
date: 2026-10-22
branch: chore/typescript-7
cost: { minutes: 34, tokens: 114868 }
touches:
  - src/package-store.js
  - src/revisions.js
  - docs/versioned-packages.md
  - test/stamp-diff.test.js
---

## Decided
- Public store entry points (resolve*, migrations, createStamp, revisionClosure/retainRevisionManifest, readLockState/installDependencies) run inside `storeSession` (src/package-store.js), exported as `export const X = inStoreSession(XOperation)`. Within a session, store directories already checked for links are trusted, storeRoot() resolves once, and verified objects and revision records (content-addressed) are reused.
- verifyStamp, diffStamps and reconstructStamp are wrapped in `withFreshReads`: no session, no caches. docs/versioned-packages.md requires "both inputs and all backing verify even at equal digests", and C17-53 in test/stamp-diff.test.js asserts each object file and blob is read at least twice by diffStamps(a, a).
- Outside sessions, verifyObject reuses a verified object only if the object dir and every tree member still match the stat snapshot the bytes were hashed under.

## Tried and ruled out
- Plain caching without the audit exemption: it broke both C17-53 tests.
- Clearing a cache on the next microtask as the "operation" boundary: test bodies are synchronous, so it would span several operations and hide tampering between them.

## Watch out
- Internal callers inside stamps.js that are not audits call `reconstructStampOperation`, not the public `reconstructStamp`, so they keep the session.
- Never trust `.staging/` paths in a session; they are created and renamed away mid-operation. Files are always re-checked.
- Full-suite wall time on Windows is noisy (one test stalled 6s→178s under load). Compare a single file run alone, or a CPU profile, rather than two suite runs.
