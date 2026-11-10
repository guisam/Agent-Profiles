---
title: "Issue 82 subagent-delivery fixture, trace reader and run gate"
author: Samson
date: 2026-11-10
branch: test/82-subagent-delivery
cost: { minutes: 8, tokens: 140318 }
touches:
  - test/fixtures/issue-82/prepare.mjs
  - test/fixtures/issue-82/trace.mjs
  - test/issue-82-fixture.test.js
  - test/fixtures/issue-82/README.md
---

## Decided
- #82 matrix reuses test/fixtures/issue-80 unchanged; test/fixtures/issue-82/prepare.mjs adds a parent-only `coordinator` role (final line `base, coordinator.`), custom agents fixture-reviewer (definition assigns reviewer) and fixture-unassigned (no role, neutral description), and a host-only `.mcp.json`. default_role stays reviewer, so the default role and an inherited parent role are told apart by `coordinator`/`FIXTURE-ROLE` in the child's own resolve, not by the child resolving reviewer.
- Tool traces are readable: Claude Code (CLI and T3 Claude sessions) writes ~/.claude/projects/<proj>/<session>.jsonl plus <session>/subagents/agent-*.jsonl and .meta.json (agentType, isBuiltIn, toolUseId). Assistant records carry requestedModel and message.model; entrypoint is cli, sdk-cli or t3-code. test/fixtures/issue-82/trace.mjs summarizes these.
- Live runs need the user's explicit authorization in the thread; preparation and deterministic tests do not.

## Tried and ruled out
- Binding the MCP server to a role: it imposes that role on every caller and refuses a child's own assignment. Bind host only.
- Agent descriptions that mention "role" or Agent Profiles: they hint the child. Keep descriptions neutral.
- On Windows, spawnSync with shell:true and an argument array triggers DEP0190; quoting the command name breaks npm.cmd. Quote only the arguments.

## Watch out
- The MCP server re-reads configuration per call, so renaming a skill in the fixture copy mid-session is a clean disposable child failure; renaming it back recovers.
- T3 delegate_task `role` (review, implementation…) is T3 metadata, not an Agent Profiles role. Native Agent children and delegate_task children are different surfaces.
- Headless `claude -p` is a different entry point from interactive CLI; record which was used. User-scope plugins/hooks load into fixture sessions unless excluded with --setting-sources.
- message.model can be "<synthetic>"; it is filtered out of the summary.
