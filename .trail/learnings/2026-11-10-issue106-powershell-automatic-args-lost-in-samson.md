---
title: Issue106 PowerShell automatic args lost in npx shim before AP
author: Samson
date: 2026-11-10
branch: docs/106-powershell-forwarding
touches:
  - CHANGELOG.md
  - docs/case-studies/mixed-model-reviewers.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - docs/powershell-selector-forwarding.md
---

## Decided
Issue106 reproduces selector loss before npm JavaScript/AP with PowerShell7.6.9 Node24.20 npm11.19: wrapper npx @args drops forwarded flags; npx.cmd @args and npx with named-array splatting preserve them. Document environment-specific cause, not AP parsing defect. Completion marker does not prove selection identity.
## Tried and ruled out
Capture argv through a Node preload at npx-cli.js and exit before npm parsing/package execution. Three exact assertions pass. Isolated AP fixture confirms baseline for lost selectors and expected Sonnet/Opus variants with cmd. WindowsPowerShell5.1 script policy blocked execution; did not bypass it. No paid model calls or global shim changes.
## Watch out
The installed npx.ps1 reconstructs caller source with Invoke-Expression, evaluating automatic args in shim scope. Historical failed draft is unavailable; new minimal reproduction matches symptom. A named array also works here; do not generalize to all shim versions. Trail lexical matches about baseline selection and version changes concern unrelated claims; this task only documents launcher behavior and increments application patch version.
