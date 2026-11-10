---
title: "Issue 97 guarded update with project adapter: ownership, digest, locks"
author: Samson
date: 2026-11-09
branch: feat/97-adapter-update
touches:
  - CHANGELOG.md
  - bin/agent-profiles.ts
  - docs/project-adapter.md
  - docs/versioned-packages.md
  - docs/wiki/Separate-your-skill-workshop.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/adapter.ts
  - src/outdated.ts
---

## Decided
The binding's layer owns an update (adapterSources[binding]; replaced rule via assignments.<id>). A replaced rule from the other layer is refused as cross-layer. An adapter edit writes adapter agents.yaml, then install (adapter mode writes only the adapter lock). A project edit with an adapter writes project agents.yaml plus the committed lock (installDependencies committed:true). It must validate alone and composed. The adapter lock is left stale and reported in `locks`; update never writes it. An adapter update on an undeclared model writes an exact-model rule with no models entry. previewDigest hashes project config+lock, local reference, adapter config+lock, adapter root, storeRoot, and current/target name+version+revision+sha256. Trust is checked live, not hashed. No stamp in adapter mode (#98). outdated tuples include validated.adapterModels; pins carry `layer`.
## Tried and ruled out
Reusing one explicit configuration across sweep tuples in composed mode: composeConfiguration mutates the project map, and the second compose fails with "redeclare". validateConfiguration structuredClones the configuration and the overlay when `adapterConfiguration` is passed.
## Watch out
Committed-only text output is kept byte-identical (tests in update-undeclared match "Edits to agents.yaml (n)"). Python edits on Windows wrote CRLF; normalize before biome/commit.
