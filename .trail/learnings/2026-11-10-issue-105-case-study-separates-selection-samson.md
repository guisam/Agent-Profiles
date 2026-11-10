---
title: Issue 105 case study separates selection delivery and context isolation
author: Samson
date: 2026-11-10
branch: docs/105-mixed-model-case-study
touches:
  - CHANGELOG.md
  - README.md
  - docs/host-observations.md
  - docs/mcp.md
  - docs/wiki/MCP-service.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - docs/case-studies/mixed-model-reviewers.md
  - docs/wiki/Mixed-model-reviewer-case-study.md
---

## Decided
Publish #105 as a bounded selection/delivery case study: native CLI and T3 are separate surfaces, one attempt per model. Sonnet received 2.0.0 and Opus 3.0.0 for reviewer. Keep #105's other coverage open. Track reported wrapper selector loss in #106 without attributing a root cause.
## Tried and ruled out
A complete context marker alone does not prove correct model selection. No quality, token savings, optimal variants, or clean-context guarantee follows from these fixture runs. Do not copy raw transcripts or machine-specific config into public documentation.
## Watch out
T3 effort differed by model. Sonnet encountered coordinator text through Graft cache after resolve; AP did not deliver coordinator role. Fixture fallback was customized and only coordinator-tested. Trail lexical conflicts about fixture quality, native implementations, and version 1/2 do not contradict this docs-only patch: it explicitly excludes quality claims and changes application version only.
