---
title: "Issue 89 update to variant package: target parsing, v3-only, sweep failures"
author: Samson
date: 2026-11-10
branch: feat/89-variant-package-update
cost: { minutes: 1, tokens: 1411 }
touches:
  - src/outdated.ts
  - src/package-store.ts
  - src/mcp.ts
  - bin/agent-profiles.ts
  - test/update-variant.test.js
  - docs/versioned-packages.md
---

## Decided
Issue #89/#91: update's second argument is parsed by parseUpdateTarget (src/outdated.ts) before any config or library read: bare exact version, or @namespace/name@version (name split at the first "@" after the scope, so a doubled identity reports its tail as a bad version). PACKAGE_NAME and isExactVersion are exported from package-store.ts and reused by identityPath. A bare version means the package the tuple selects NOW (possibly a variant), not the binding default. Cross-package moves are v3-only: v3 assignment bindings carry package/version/revision; v2 rules carry only `versions.<binding>: x.y.z`, so v1/v2 refuse with a pointer to docs/migrations/config-v2-to-v3.md. The digest adds the target name only when it differs, so same-package digests are unchanged. JSON adds before.package/after.package.
## Tried and ruled out
Relying on validateConfiguration to catch a wrong-type target: package type/delivery/entrypoint checks (validatePackageBindings) run inside resolveConfigured, i.e. in the sweep, and sweep swallowed per-tuple failures, so the edit surfaced as "does not change the target selection". planUpdate now refuses when a tuple that resolved before fails after, with the resolver's message.
## Watch out
libraryInfo for a wholly absent package says "<name>: not in the library at <store>" (no version). test/outdated.test.js "outdated lists each pin..." fails on this machine with the ambient trust policy (Approval lines) on unmodified 0.22.0 too; run with AGENT_PROFILES_TRUST pointing to an absent file. A minimal v3 release label for fixtures: retainRevisionManifest with dependencies [] and workflow null (test/update-variant.test.js).
