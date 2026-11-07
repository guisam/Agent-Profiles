---
title: Complete setup prompt and release documentation together
author: Samson
date: 2026-11-07
branch: docs/0194-setup-mcp-security
cost: { minutes: 33, tokens: 109753 }
touches:
  - README.md
  - docs/setup.md
  - docs/mcp.md
  - docs/wiki/Versioning-and-upgrades.md
  - package.json
---

## Decided
The 0.19.4 documentation patch makes the README setup prompt and docs/setup.md explicitly cover project MCP registration, the protocol-3 bootstrap, an installed shell fallback, security decisions, and live retrieval-before-work checks. The npm quick start and setup examples target 0.19.4; confirm publication before executing them. Source examples and wiki upgrade notes match. Preserve existing instructions and policies; signed approval adoption is a separate reviewed choice.

## Tried and ruled out
Keeping setup examples at 0.19.1 after publishing 0.19.3 steered new users to the pre-fix behavior. Startup MCP instructions do not carry skill bodies; bound selectors cannot be overridden. Configuration health, explain metadata, stamps and a final marker do not prove model adherence. Withheld packages are not the same as a failed resolve: report withholding without bypassing policy.

## Watch out
A docs patch still needs a package-version bump under repository rules. Publish from merged main through the existing OIDC workflow and verify the registry copy, including its README and setup guide. Registry metadata and tarball availability can propagate separately. Refresh the wiki only after merge. No new runtime security guarantee or lifecycle-hook support is introduced.
