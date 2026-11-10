---
title: "Issue 98 adapter stamps: composed configuration capture, privacy, layered diff"
author: Samson
date: 2026-11-10
branch: feat/98-adapter-evidence
cost: { minutes: 1, tokens: 1755 }
touches:
  - src/stamps.ts
  - src/adapter.ts
  - src/sessions.ts
  - src/inspect.ts
  - src/outdated.ts
  - src/package-lock.ts
  - test/adapter-stamps.test.js
---

## Decided
Composed stamps add one optional top-level snapshot field, `configurationSources`, only when an adapter composes; validateSnapshot1/2 accept it via optionalSources(s), so committed-only bytes/digests stay those of 0.20.0 (golden digests in test/adapter-stamps.test.js were recorded on unmodified 0.21.0 code before any change). computeStamp passes the captured adapter agents.yaml as `adapterConfiguration` with the explicit project config, so resolution composes exactly the captured bytes; the composed configuration digest is configRecord() from package-lock.ts, equal to the adapter lock's configSha256 (verify checks lockCoversConfiguration). Inputs are ordered project, local, adapter...; diff's changeLayer relies on rows 0/1 being project/local. The local reference is digest-only (referenceDigest = sha256 of "agent-profiles/adapter-reference/v1\0" + reference text); optional `label` in agents.local.yaml is regex-limited so it cannot be a path. update stamps after adapter-owned edits; project-owned edits leave the adapter lock stale, so stampDigest stays null with an install-then-stamp message.
## Tried and ruled out
Recording adapter approvals as path inputs: store paths must match [A-Za-z0-9._/-] (validateMembers/readStoreFile) and approval paths always contain "@" (namespace, principal email). Approvals are rows by package/version/principal with blobs labeled approval.json(.sig), read through package-store safePath (link checks, no alphabet rule). Comparing the selector model only to identity.canonical: adapter exact-model rules select by the stated ID when canonical is null (resolve.ts selectPackages); statedModel()/selectorValue() mirror that for adapter-owned bindings in composed snapshots.
## Watch out
Writing TS through bash heredocs/node -e turned "\\0" into a literal NUL byte twice (file reports "data"); use the Edit tool or a script file. materialize, revision and migrate evaluation still refuse in adapter mode. Earlier versions reject the new `label` key in agents.local.yaml.
