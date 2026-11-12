---
title: "Issue 119 first slice: skill catalog and compare API"
author: Samson
date: 2026-11-12
branch: feat/119-skill-library-catalog
touches:
  - CHANGELOG.md
  - docs/visualize.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/content-diff.ts
  - src/outdated.ts
  - src/visualize.ts
  - src/skill-catalog.ts
  - test/skill-catalog.test.js
---

## Decided
- #119 first milestone is split. PR 1 is API only: `src/skill-catalog.ts` (skillCatalog, compareSkills, parseSkillSelector) plus visualizer GET routes `api/skills` and `api/compare?left=&right=`. The UI comes in a later PR. Version 0.25.0.
- It reuses the existing pieces. listLibrary + libraryInfo(root) give versions and project pins. discoverSkills gives local skills. validateConfiguration().roleSkills gives required/available usage. versionFiles (now exported from outdated.ts) + packageDiff give verified file diffs. libraryEvidence gives rows, and no rows means "untested".
- Selectors are `package:<name>@<version>` (split on the last @) and `local:<repo path>`. A local path must match a discovered skill, so the API cannot read arbitrary repository files.
- Local skills: `version: null`, `sha256: null`, files = SKILL.md + declared resources, with paths relative to the skill directory.

## Tried and ruled out
- Returning the store path in the catalog: an earlier learning rules out exposing store paths, so it was removed (and the test asserts it's absent).
- Inferring a local version from frontmatter: not done. It stays null.

## Watch out
- Not yet covered: external user/plugin skill roots in the catalog, previewing the resolved context with an alternative skill swapped in (needs composition preview), and the UI.
- CHANGELOG.md on main has invalid UTF-8 bytes in the 0.24.1 heading, and the Edit tool refuses the file. Insert entries at the byte level.
- 4 tests (outdated "lists each pin", package-cli P9-05 x2, P9-12) also fail on unchanged main on this Windows machine: an extra "Approval: not approved" line. This is environmental and was not caused by #119.
- `npm run test:affected` takes over 10 minutes here. Run it in the background.
