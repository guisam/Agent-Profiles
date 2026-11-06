---
title: Published npm onboarding and separate MCP registration
author: Samson
date: 2026-11-06
branch: docs/npm-mcp-onboarding
cost: { minutes: 3, tokens: 2528 }
touches:
  - CHANGELOG.md
  - README.md
  - docs/setup.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - bin/agent-profiles.ts
  - docs/sessions.md
  - docs/trust.md
  - docs/versioned-packages.md
---

## Decided
Onboarding distinguishes approval to download/execute a pinned npm tool from approval to install in the target project. Keep published npm examples at 0.19.1 while the documentation-only source patch is 0.19.2. MCP handoff and host registration are separate steps, followed by an actual resolve call.

## Tried and ruled out
Do not describe npx as installing nothing, init --mcp as registering the server, or Claude/Opus bound-instruction retention as universal T3 behavior. Do not bypass existing host deny rules using another CLI invocation.

## Watch out
A source version bump does not publish that version. Preserve checkout/artifact alternatives and optional shared-library reuse. Host connection, lifecycle behavior and model effectiveness require separate evidence.
