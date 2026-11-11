---
title: "Wiki reconciliation: docs/wiki vs live wiki"
author: Samson
date: 2026-11-11
branch: docs/wiki-reconcile
cost: { minutes: 3, tokens: 52798 }
touches:
  - CHANGELOG.md
  - README.md
  - docs/setup.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/mcp.ts
---

## Decided
On 2026-11-11 (0.23.10) docs/wiki/ was reconciled with the live GitHub wiki (Agent-Profiles.wiki.git), which had diverged both ways. docs/wiki/ now holds all 19 live pages; nine wiki-only pages were imported verbatim (qualification, guided evaluation, saved evidence, JobBench, Luna/Sol, PowerShell forwarding, T3 guide). Per hunk: wiki-only accuracy edits kept (ToolSearch may precede resolution), repo-only newer content kept (0.23.0 variant notes; "bound selection and stamp" matches src/mcp.ts). After merge, publish by copying docs/wiki/*.md over a wiki clone so the two stay identical.
## Tried and ruled out
Copying docs/wiki over the wiki without a diff would have dropped wiki-only edits. Keeping the wiki's dated publication snapshots and the "unpublished working source" 0.19.6–0.19.11 compaction notes: their labels collide with real CHANGELOG versions and the wiki itself marks them superseded by 0.19.7.
## Watch out
Compare with git diff --no-index --ignore-cr-at-eol: Windows checkouts of docs/wiki are CRLF and the wiki repo is LF, so plain diffs show every line changed. The imported wiki-only pages were not content-reviewed beyond branch links and npm versions; some (qualification pilots, Luna/Sol) describe October work.
