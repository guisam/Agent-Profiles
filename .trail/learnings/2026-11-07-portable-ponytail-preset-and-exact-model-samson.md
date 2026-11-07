---
title: Portable Ponytail preset and exact model version examples
author: Samson
date: 2026-11-07
branch: docs/ponytail-preset
cost: { minutes: 3, tokens: 2528 }
touches:
  - CHANGELOG.md
  - README.md
  - docs/mcp.md
  - docs/setup.md
  - docs/wiki/MCP-service.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - docs/host-observations.md
  - ".agent-profiles/BOOTSTRAP.md"
---

## Decided
The Ponytail example is a schema-1 Markdown preset with four MIT-licensed adaptations, per-skill provenance, one baseline profile and prefixed role IDs. A standalone version-1 agents.yaml uses implicit profile paths. Documentation distinguishes copied presets from version-2 package-backed model/role/host pins, including different exact generations within Opus. Model optimization is a future evaluation claim, not demonstrated quality.
## Tried and ruled out
Do not copy the live dogfood config, signed approvals, locks, private paths or the unlicensed shared-language extraction. Explicit profiles is invalid in configuration v1. Existing preset tests copy the repository scaffold, so run them in a clean checkout rather than the privately modified dogfood tree.
## Watch out
Preset import copies Markdown, not adjacent license/provenance files; preserve MIT notices when redistributing. Clean-checkout verification passed 11 preset tests and typecheck. This example does not include plugin hooks or universal clear/compact/subagent guarantees.
