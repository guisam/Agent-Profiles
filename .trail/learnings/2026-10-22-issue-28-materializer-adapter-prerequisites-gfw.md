---
title: Issue 28 materializer adapter prerequisites
author: Gfw
date: 2026-10-22
cost: { minutes: 1, tokens: 2325 }
touches:
  - src/materialize.ts
---

## Decided
Issue #28 planning found the first implementation dependency is an adapter-aware materialization path. src/materialize.ts hard-codes filesystem-v1 in contract validation and build; planMaterialization, materialize, and verifyMaterialization rebuild through build, while recovery delegates final verification to verifyMaterialization. Keep the existing staging, boundary, ownership, and recovery machinery shared. Preserve filesystem-v1 plan and receipt bytes when adding adapter selection.

## Tried and ruled out
Adding only a Harness2 layout writer is incomplete: verification would rebuild filesystem-v1 output and receiptSchema validates global capabilities. Current source mappings describe captured backing, so composed always-on output also needs explicit provenance semantics rather than a false claim that it copies one source file.

## Watch out
This is planning guidance, not an approved new adapter contract. The issue requires both surfaces in phase 1; OpenCode layout does not establish an OpenCode host assignment for later migration/evaluation phases. Decide memory, subagent mapping, and generated-file provenance before promising the full layout. Unrelated uncommitted work was present during planning.
