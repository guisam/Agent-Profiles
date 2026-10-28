---
title: "Per-run YAML evidence, skill associations and portable restoration"
author: Gfw
date: 2026-10-24
touches:
  - integrations/harness2/archive_profile_evidence.py
---

## Decided
The user stopped model experiments and requested per-run profile YAML as visible evidence, with associated skills and a chance of reverting versions. Added integrations/harness2/archive_profile_evidence.py and backfilled 25 task rollouts: portable selected YAML, referenced profile/role/skill bytes, native stamp, retained source YAML, runtime settings, hashes and restore cards. A local index classifies 23 grader/readiness sessions as having no Agent Profiles configuration. Two new saved configuration examples show distinct role skill sets: Luna uses api-documentation plus source-evidence-audit; Sol uses api-documentation plus api-contract-review. All 27 YAMLs resolve offline; the newest assignments were not model-tested after the stop. Source feature version 0.4.0 adds the preset, guide and archive tool without schema changes.

## Tried and ruled out
Do not invent different historical skills or reconstruct configuration from remembered prose when immutable stamp bytes remain. A shared baseline skill stays shared; version/content hashes distinguish revisions of the same skill ID. Retained project YAML can differ from candidate preview bindings, so archive it separately from the reconstructed effective selection. Higher reasoning and fresh self-review did not establish Luna parity on the complex documentation cases; do not transfer prior model scores to the final reorganized skill assignments. No live restore or further model calls occurred after the user stopped experiments.

## Watch out
Portable schema-1 YAML uses implicit profiles/<id>.md paths and requires a families map. Role file paths are relative to .agent-profiles, but top-level local skill file references are project-relative and need the .agent-profiles prefix. The real resolver round trip caught these archive-generation errors; it now lives in the exporter's self-check. Package backing SHA identifies a whole native package tree, unlike blob/file SHA. YAML alone cannot restore referenced instructions, original package lock/history, host permissions or runtime settings. Preserve native provenance and exact retained workspace files, verify content hashes, and restore into a new project before reviewing a merge into an existing one. Existing evidence must not be silently overwritten; generated export corrections were labeled before validation while original native evidence remained unchanged.
