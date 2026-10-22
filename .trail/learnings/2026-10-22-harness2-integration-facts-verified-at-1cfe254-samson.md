---
title: Harness² integration facts verified at 1cfe254
author: Samson
date: 2026-10-22
branch: feat/28-harness2
cost: { minutes: 9, tokens: 108142 }
touches:
  - issue-harness2.md
  - AGENTS.md
---

## Decided
- Issue #28 scope follows the source: phases 1-2 (materializer, adoption capture) target both OPENCODE_SURFACE and CODEX_SURFACE, since a surface is only a tree layout; phases 3-4 (proposals, paired evaluation) need an Agent Profiles host (claude/codex/hermes), so OpenCode arms wait for an OpenCode host integration.
- Only package-classified edits to one skill package entrypoint can become candidates; profile/role edits stop at workspace acceptance.

## Tried and ruled out
- Codex-only scope: harness2-demo (the offline end-to-end path) is OpenCode-only (DemoAdapter uses OpencodeSubstrate) and requires and executes scripts/summarize.py.
- `harness2-judge --bases` as a runner: it only scores base1..base{k} rollouts that a normal sweep already produced; there is no base-only sweep.

## Watch out
- CODEX_SURFACE always-on is AGENTS.md only (<= 8,000 chars, non-empty); guardrails.md, LongTermMEMORY.md, tool_guidance and plugin/*.ts are OpenCode-only. validate() requires every skill to have description: and be named in always-on text.
- Base rollouts fingerprint as the constant "base" (runmark), so reuse is by run ID; give each arm its own HARNESS2_RUNS_DIR or a base rollout leaks across arms.
- base_harness() is a hard-coded per-substrate constant and the demo rewrites root/base in __init__; seed by subclassing the adapter in our Python code.
- Library.add returns without writing when experience is empty; summary.json has per-task rollout_usd/session_usd, not per-rollout cost.
- The upstream name `harness2-bridge` is taken (Vertex AI Responses proxy).
