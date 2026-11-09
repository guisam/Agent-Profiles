---
title: "Issue 85 project adapter: precedence, signing, migration"
author: Samson
date: 2026-11-09
branch: feat/85-project-adapter
---

## Decided
Adapter = ignored .agent-profiles/agents.local.yaml -> one external dir mirroring .agent-profiles/. Composition happens in validateConfiguration only when no explicit configuration is passed. Adapter role files are injected through the existing `preview` map at their project path, so no second base path is needed. Precedence is ownership: the adapter adds only, so no cross-layer selector comparison exists. In adapter mode the lock lives in the adapter and covers the composed config (readLockState uses validated.adapter). Approvals = union of project and adapter; approve writes to the adapter; install/update never sign. Unsupported commands are gated in the CLI (ADAPTER_COMMANDS) and in planUpdate (covers MCP update_preview).
## Tried and ruled out
A full two-base file overlay across all readers: about 10 modules read .agent-profiles directly. Gating plus preview injection was far smaller.
## Watch out
Callers that pass `configuration` explicitly (configure, presets, outdated apply, migrations) see project-only config; that is why they are gated. The live dogfood MCP runs AP 0.19.4 from workflow-skills/node_modules, which ignores agents.local.yaml: do not migrate live until it runs an adapter-aware build. The machine trust has require_approval false, so check approvals explicitly.
