---
title: Harness2 documentation starts with a successful setup
author: Samson
date: 2026-10-23
branch: feat/28-materializer-adapter-seam
touches:
  - README.md
  - docs/hosts/harness2.md
  - docs/harness2.md
  - docs/issue-20-package-contract-proposal.md
  - docs/issue-20-test-contract.md
  - issue-harness2.md
---

## Decided
The user asked for a dedicated end-user Harness2 setup guide and clarified that docs/hosts/harness2.md is too technical for onboarding. Keep that file as the adapter reference. docs/harness2.md now leads with Windows/PowerShell prerequisites, source import setup and a complete credential-free starter that creates its own tiny Codex harness, captures/verifies its stamp, exports it and prints inspectable output paths. README links both the guide and its copy/paste coding-assistant prompt. The prompt inventories versions/paths, runs the starter, then helps wire an existing driver while keeping real model execution a separate step.

## Tried and ruled out
Starting the guide with an existing adoption, config3/lock2 or candidate terminology requires users to already have the thing they are trying to set up. A test-suite command or a code fragment with an undefined proposer is not the first successful end-user example. The standalone starter needs no preexisting adoption, credentials, WSL or model runner. Keep detailed proposal/evaluation schemas in linked references rather than front-loading them into setup.

## Watch out
Run the exact documented starter when changing it: it passed capture, verify and materialization against the clean pinned checkout, and all 50 local links/anchors plus three PowerShell blocks were validated. The temporary output is for trying setup; real experiment artifacts belong in durable storage. Use fresh output per starter invocation and fresh run namespaces when inputs change. The full upstream offline search scheduler still needs POSIX fcntl; this limitation does not apply to the Windows capture/seed starter. Existing Trail lexical warnings should be reported honestly, not removed by deleting safeguards or rewriting old learnings.
