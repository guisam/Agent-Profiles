---
title: "Issue 105 Codex row: gpt-6.1-sol T3 child selection and identity evidence"
author: Samson
date: 2026-11-11
branch: main
cost: { minutes: 5, tokens: 77093 }
touches:
  - AGENTS.md
---

## Decided
2026-11-11: #105 Codex row passed (n=1). A Claude Opus coordinator in the fixture T3 project ran delegate_task with target {providerInstanceId: "codex", model: "gpt-6.1-sol"}; the child loaded the fixture AGENTS.md codex block and project .codex/config.toml MCP server, called mcp resolve (host codex, host-stated gpt-6.1-sol, role reviewer) first and got variant 4.0.0 with the full end line. Fixture changes live in C:/workspace/ap-issue105-runs (sources/reviewer-variant/4.0.0, setup-codex.ps1, .codex/config.toml, AGENTS.md wrapper).
## Tried and ruled out
Relying on T3 for Codex child identity: thread read shows executedModel null. Use the Codex rollout log (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): turn_context model, effort, the T3 runtime_info line stating the model, and the AGENTS.md instructions path.
## Watch out
Writing Windows paths into files through bash+node -e eats backslashes (\f became a form feed); use String.raw or the Edit tool. T3 sends no options to a cross-provider Codex child, so effort is Codex's default (low). User-scope graft also loads into Codex sessions.
