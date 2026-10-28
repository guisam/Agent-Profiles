---
title: JobBench Windows pilot and owner-terminal execution boundary
author: Gfw
date: 2026-10-23
---

## Decided
Issue #33's first concrete scenario is JobBench technical_writers/task1 (DataSync documentation), dataset revision d43a66575635da0d3f6cb9a20976dc1a60f3ffc9. A bounded Windows deployment uses Harness2's public CodexSubstrate and the existing seeded_adapter with recorded Codex 0.163.0, rather than the stock Linux runner and its 0.144.6 pin. The external Markdown style reference is pinned and pre-provisioned equally. jobbench_pilot.py prepares verified identical managed harness bytes for two distinct model selections, refuses changed inputs, checks actual file-read events before task runs, retains sidecars/logs/output hashes, bounds each owned process tree, and explicitly reports ungraded status. It is an external integration companion, not a runner in core resolution. Input-tamper self-check and preparation/replay passed.

## Tried and ruled out
Both nested native Codex tool-read probes exited zero yet failed to read a file because their shell commands were blocked by execution policy; plain model readiness and exit code are not successful task-execution evidence. Do not weaken the policy, switch to unrestricted sandbox flags, or relabel these failures as model-quality scores. The maintainer approved an ordinary-owner-PowerShell handoff. No benchmark task rollout or grading has completed at handoff, and no candidate or promotion is authorized.

## Watch out
Keep model readiness, actual tool access, structural output completion and grading separate. Unknown-model fallback metadata was observed for the custom local model and must remain visible in logs. This Windows deployment differs from the stock benchmark and cannot be called an unmodified official result. Inputs/rubrics must remain separate and the four outputs must be ordinary files. The launcher must finish before a model winner, quality improvement or issue completion is claimed. The ongoing feature source version remains 0.2.0 while live qualification is pending; no new schema migration is needed.
