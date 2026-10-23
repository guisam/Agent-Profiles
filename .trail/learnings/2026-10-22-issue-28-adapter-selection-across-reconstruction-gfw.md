---
title: Issue 28 adapter selection across reconstruction
author: Gfw
date: 2026-10-22
cost: { minutes: 1, tokens: 2325 }
---

## Decided
Issue #28 implementation starts on feat/28-materializer-adapter-seam. The private materializers registry selects identity, option validation, mapping validation, capabilities, and rendering. Shared build reconstructs immutable stamp backing and validates output member paths; renderFilesystem retains the existing filesystem-v1 layout. Planning selects explicitly, writing reconstructs with the supplied plan selection, and verification reconstructs with the receipt selection. Recovery inherits selection through verification.

## Tried and ruled out
No public adapter registration API or Harness2 mapping decisions are needed for this prerequisite. Existing independent filesystem plan and receipt oracles cover byte compatibility; added tests reject unsupported identities, versions and options across planning, writing and verification.

## Watch out
Only filesystem-v1 is implemented. Next work must define generated-file provenance and both Harness2 surfaces, including caps, skill triggers, inert package scripts and explicit unmapped bindings. The shared content/ envelope remains; do not claim that this seam alone implements a Harness2 tree. Preserve unrelated local changes.
