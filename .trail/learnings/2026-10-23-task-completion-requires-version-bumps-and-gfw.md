---
title: Task completion requires version bumps and wiki upgrade guidance
author: Gfw
date: 2026-10-23
touches:
  - package.json
  - package-lock.json
  - AGENTS.md
---

## Decided
The maintainer requires a version bump for each completed repository task and a GitHub wiki update as the final completion step, including necessary version-upgrade instructions. Patch for minor revisions/bug fixes, minor for new features, major for a backward-incompatible configuration YAML rewrite. Reset lower fields on minor/major bumps. The actual version manifest is package.json, not project.json; keep root package-lock.json versions synchronized and check version-dependent fixtures/docs. Updating version metadata does not authorize npm publication, release creation or Git tags. These rules are recorded in AGENTS.md.

## Tried and ruled out
Do not create project.json as a second version source. Do not silently treat a configuration format revision as the same identifier as the application release version.

## Watch out
Current application version is 0.1.0. Beta numbering is not yet selected by the maintainer. Recommend target-version-beta.N, but do not silently adopt the proposal. Wiki Home.md and _Sidebar.md have local source copies under docs/wiki/ and were published through connected Chrome; repo documentation remains authoritative.
