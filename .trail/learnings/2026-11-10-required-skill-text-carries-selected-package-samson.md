---
title: Required skill text carries selected package identity
author: Samson
date: 2026-11-10
branch: fix/90-required-skill-identity
touches:
  - CHANGELOG.md
  - docs/versioned-packages.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/diagnostics.ts
  - test/package-cli.test.js
---

## Decided
Issue #90 adds selected package name, version and full tree SHA-256 above required and explicitly requested skill bodies in formatContext. The same formatter serves CLI and MCP. Available rendering reuses the identity helper. JSON, body bytes and selection rules do not change.
## Tried and ruled out
Do not infer a version from skill frontmatter or expose store paths. Use the selected loaded entry, including model-specific assignment results. No new blindness flag is added to this small defect fix; blinded evaluation runners must account for newly visible metadata.
## Watch out
The full four-file regression run initially had three withheld-array mismatches between parent and isolated child processes under machine trust. With an explicit isolated trust policy, all 83 tests pass. This does not change the user's live trust policy. Preserve raw skill content and the last completion marker.
