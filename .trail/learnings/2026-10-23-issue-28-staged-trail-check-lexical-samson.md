---
title: Issue 28 staged Trail check lexical conflict rationale
author: Samson
date: 2026-10-23
branch: feat/28-materializer-adapter-seam
touches:
  - ".github/workflows/harness2.yml"
  - bin/agent-profiles.ts
  - docs/hosts/harness2.md
  - integrations/harness2/.gitignore
  - integrations/harness2/agent_profiles_harness2/__init__.py
  - integrations/harness2/agent_profiles_harness2/bridge.py
  - integrations/harness2/agent_profiles_harness2/converters.py
  - integrations/harness2/agent_profiles_harness2/hooks.py
  - integrations/harness2/pyproject.toml
  - integrations/harness2/test_bridge.py
---

## Decided
The complete staged issue #28 implementation passes the previously recorded execution checks. Staging new files expands trail check from three tracked files to sixteen implementation/documentation files and exposes lexical false positives. Preserve the tested implementation and explain these matches in the commit and PR instead of deleting safeguards or editing historical learnings.

## Tried and ruled out
Trail flags shared Harness2, runner, stamp, mapping and capture vocabulary as reintroducing rejected approaches. This change does not treat harness2-judge as a runner: external sweeps run first, judge --bases scores them. The opt-in workflow only validates exports and runs fixture tests/offline demo; production Agent Profiles does not start models or sweeps. Generated AGENTS.md comes from selected instructions, never repository rules; generated mappings explicitly carry provenance and ambiguous generated edits are reported. Migration preparation selects the skill in a fresh isolated config and obtains a new stamp rather than reusing the available-only capture stamp. Both the shared materialization seam and verification/recovery are implemented; there is no public adapter registration API. The public run_task facade post-captures successful adoptions, including cases Library.add never sees. Exporting that facade is the recommended approach, not a ruled-out approach. Other documentation matches to caller-alone and copy-file notes describe unrelated historical debugging practices, not defects in this integration.

## Watch out
trail check returns nonzero with twenty displayed lexical matches once new files are staged; this is not a clean check. Preserve the independent filesystem compatibility oracle, whose positive mention inside an old Tried and ruled out paragraph causes another false match. Carry this rationale into the commit/PR. Existing tests cover filesystem compatibility, adapter identity/options, deterministic capture, missing adoption hooks, generated-text edits, selected candidate metadata and paired-evidence rejection. Live Codex execution/judge quality remains untested, and OpenCode still has no host integration for migrations/evaluations.
