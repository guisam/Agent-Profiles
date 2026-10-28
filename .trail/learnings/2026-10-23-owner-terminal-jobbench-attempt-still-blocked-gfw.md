---
title: Owner-terminal JobBench attempt still blocked before task execution
author: Gfw
date: 2026-10-23
---

## Decided
The owner-terminal JobBench attempt 20261023T181113Z-640e19 is preflight-blocked. Both providers responded, but exec_command rejected Get-Content readiness.txt with blocked by policy. No task rollout or grading ran. Preserve these records as executor failure evidence, not model-quality evidence.

## Tried and ruled out
Moving the identical launcher to ordinary PowerShell did not resolve the refusal. Offline codex execpolicy check against the saved default.rules returned matchedRules: []; this does not rule out managed policy or other execution controls. Neither model gets a failed task score from this run.

## Watch out
The launcher ignores user config, including the normal machine's Windows sandbox selection. Missing sandbox configuration is only a hypothesis. Next compare normal interactive Codex behavior under existing approvals before altering launcher configuration; never bypass policy to force an eval. Strata also logged fallback model metadata and model-catalog decoding warnings, a separate compatibility concern.
