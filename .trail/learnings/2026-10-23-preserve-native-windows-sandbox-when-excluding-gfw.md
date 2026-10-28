---
title: Preserve native Windows sandbox when excluding Codex user settings
author: Gfw
date: 2026-10-23
---

## Decided
The Windows JobBench launcher excluded user config with --ignore-user-config and accidentally omitted the owner's configured Windows sandbox implementation. The owner reported the same file read succeeding in a normal interactive Codex session. Carry forward only windows.sandbox from the active CODEX_HOME/config.toml (or ~/.codex/config.toml), while retaining workspace-write, managed controls and the explicit provider/auth settings. Record the native sandbox argument with each run. Valid implementations are elevated, unelevated and mxc; refuse missing or unsupported values before calls.

## Tried and ruled out
The owner-terminal handoff alone did not solve the failure. In run 20261023T181934Z-5edcde, preserving the existing unelevated implementation made both Luna and Strata preflight shell reads return READY with exit zero. No blanket allow rule, saved config change or sandbox bypass was needed. The offline self-check covers all valid modes, invalid/missing selections and task-input tampering.

## Watch out
A passing file-read preflight proves neither task completion nor writing permission for every command. Keep task completion, integrity checks and content grading separate. Preserve the failed attempt as executor evidence, and retain Strata's unknown-model metadata/catalog warnings when describing compatibility.
