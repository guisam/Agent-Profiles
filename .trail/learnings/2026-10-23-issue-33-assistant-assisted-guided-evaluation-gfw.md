---
title: Issue 33 assistant-assisted guided evaluation scope and qualification
author: Gfw
date: 2026-10-23
touches:
  - docs/guided-evaluation.md
  - package.json
  - package-lock.json
---

## Decided
For issue #33 the maintainer chose an assistant-assisted flow rather than a terminal wizard. docs/guided-evaluation.md is the single entry point and copyable operator prompt over existing bridge/CLI APIs. No new runner, command, config schema, or parallel artifact format. Use one role/host and independently evaluated exact model IDs. Current working application metadata advances from 0.1.0 to 0.2.0, synchronized in package.json and package-lock.json; beta naming remains undecided. Current tarball/setup/release references follow 0.2.0 without changing config/lock/evidence formats. The maintainer clarified that project.json was simply a typo; do not make that distinction a product feature or repeat it in user-facing guides.

## Tried and ruled out
Do not turn fixture integration checks into real two-model code-review results or silently close #33 without that evidence. Do not grant paid execution based on preparation, approve proposals/promotions automatically, copy isolated capture configs over active projects, or overwrite intervening changes during restoration. No compatible external driver means preparation only, not a successful search.

## Watch out
Keep held-out task inputs/answers out of the optimizer session/workspace/memory/library, and grading answers out of executor context. Outcome-informed edits need fresh held-out cases. Seed search from start_migration's returned selected base; preserve before_tree and report generated/companion edits as unsupported. Retain plans before fixed-arm execution; require real pre-execution sidecars and disjoint roots/IDs. Current converter metrics other than individual recorded rollout USD remain unknown. The first two model IDs and an actual authorized live run/budget are pending. trail check's 11 displayed lexical matches concern config version versus app version, source composition, and old-seed vocabulary: this documentation preserves those distinctions and safeguards, introduces no second version source, and starts with the existing successful starter. Preserve the checks and old learnings rather than changing their meaning to get a green lexical check.
