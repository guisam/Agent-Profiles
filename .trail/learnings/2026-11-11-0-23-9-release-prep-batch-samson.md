---
title: "0.23.9 release prep: batch release of unreleased versions"
author: Samson
date: 2026-11-11
branch: release/0.23.9
cost: { minutes: 23, tokens: 139859 }
touches:
  - CHANGELOG.md
  - docs/host-observations.md
  - docs/setup.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - test/fixtures/issue-83/README.md
---

## Decided
0.23.9 (2026-11-11) publishes the unreleased 0.22.1–0.23.8 work; npm latest was 0.22.0. CHANGELOG headings for 0.22.1–0.23.8 now say "included in 0.23.9" instead of "unreleased"; 0.22.0 gained its npm date (2026-11-10). README and docs/setup.md examples moved from 0.19.4 to 0.23.9 in the same PR, before publication, as in the 0.19.4 patch: the docs already say to confirm the version is published.
## Tried and ruled out
Claiming in the upgrade note that re-running init only refreshes wording: not verified, dropped. Upgrade claim kept to what each wiki entry states (no YAML, lock, store or bootstrap migration since 0.19.4; protocol 3).
## Watch out
trail check flags the pin change against the Nov 6/7 "keep examples at the published version" learnings; that is expected for a release-prep PR. Publish 0.23.9 through the publish.yml workflow_dispatch from main (rehearsal, then publish) right after merge so the pins are not ahead of npm for long, then verify the registry copy and refresh the wiki.
