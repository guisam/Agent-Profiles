---
title: "Issue 85 first slice: npm template allowlist and workshop guide"
author: Samson
date: 2026-11-09
branch: fix/85-package-artifact-allowlist
touches:
  - CHANGELOG.md
  - CONTRIBUTING.md
  - docs/wiki/Home.md
  - docs/wiki/Versioning-and-upgrades.md
  - docs/wiki/_Sidebar.md
  - package-lock.json
  - package.json
  - docs/wiki/Separate-your-skill-workshop.md
  - test/package-files.test.js
  - src/install.ts
---

## Decided
- package.json `files` names each shipped `.agent-profiles/` template (10 files) instead of the whole folder. Reason: `init` (src/install.ts, templateFiles over packageRoot/.agent-profiles) copies EVERY packaged template into consumer repos, so a dogfood lock/approvals/maintainer role would leak to consumers, not just into the tarball.
- test/package-files.test.js packs a temp copy with sentinel local files beside the templates (`npm pack --dry-run`), so it never mutates the repo.
- Wiki guide docs/wiki/Separate-your-skill-workshop.md describes only supported mechanics (library publish, pins+lock, frozen install, approvals); the workshop→adapter→project layer from the #85 comment is labeled a proposal.
## Tried and ruled out
- A git-clean guard in prepack: it would block the maintainer's local tgz builds; left as a maintainer decision.
## Watch out
- The allowlist does not protect the CONTENTS of shipped templates: a modified agents.yaml in a dogfood checkout still ships. Publish from CI/clean worktree until the local overlay exists.
- Adding a new template requires adding it to package.json `files` by name, or init silently stops providing it.
