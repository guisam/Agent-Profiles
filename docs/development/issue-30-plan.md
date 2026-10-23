# Issue 30: native OpenCode host integration

Status: implemented and under regression validation. `--host opencode` is now a
distinct native bootstrap adapter. Harness² captures retain that real assignment
through conversion; its intermediate surface is still distinct from standalone
OpenCode's native instruction/configuration layout. The findings below describe
the pre-change seams; the implementation is documented in the
[host guide](../hosts/opencode.md).

Native validation update: installed OpenCode v2.1.3 passed the isolated
instruction and skill-loading smoke checks, including a live default-model
request. See [observations and reproduction](../hosts/opencode-observations.md).
The earlier v1.19.4 research must be requalified against this installed version
before implementing host discovery and skill identity.

Source: [issue #30](https://github.com/guisam/Agent-Profiles/issues/30), inspected
with no comments. Repository baseline: `95e746795e0e85b4b518f87d5cd804cc49d3e9e4`.
See the [version-pinned host investigation](issue-30-opencode-contract.md) for
upstream behavior and the distinction between source checks and live evidence.

## Findings that constrain the implementation

1. **Registering an adapter is necessary but insufficient.** Configuration,
   package host declarations, migration assignments and stamp validation already
   derive allowed hosts from `integrations` (`src/resolve.ts:743,1009,1191`,
   `src/packages.ts:160`, `src/migrations.ts:90-95`, `src/stamps.ts:73,112-115`).
   Reuse this registry; never translate OpenCode assignments to Codex.
2. **Shared instruction files currently have one owner.** Codex selects
   `AGENTS.override.md` or `AGENTS.md` (`src/integrations.ts:125-137`).
   `managedSpan` accepts one generic marker pair and rejects duplicates
   (`src/integrations.ts:186-201`). Installation, doctor and inspection recognize
   a span without checking its host (`src/install.ts:67-97,367-403`,
   `src/inspect.ts:633-679`). Adding another adapter with `AGENTS.md` would make
   a Codex block look like an installed OpenCode block. Solve ownership before
   registering the host. Keep all unrelated bytes, BOM and line endings.
3. **Inspection and discovery have additional host lists.** Executable inspection
   has a separate host tool group (`src/inspect.ts:474-475`). External discovery
   currently accepts Claude/Codex roots (`src/external-skills.ts:21-26,44-75`)
   and builds only their default roots (`src/external-skills.ts:174-222`).
   Project discovery has its own collectors (`src/skills.ts:57-87,163-390`).
   OpenCode compatibility roots must retain their real OpenCode addressability;
   a shared file location is not proof that two hosts resolve it identically.
4. **A rerun is not a context reset.** The generic bootstrap requests resolution
   on new/compacted contexts and model changes (`src/integrations.ts:203-232`).
   Rendered context says it supersedes older text (`src/diagnostics.ts:374-378`),
   but this does not remove conversation history. OpenCode guidance must require
   a fresh session for clean model/agent/role separation and must not claim that
   ordinary switching clears previous profiles.
5. **Harness² still loses OpenCode assignment identity intentionally.** Capture
   sets its host to null and omits the host selector when stamping
   (`integrations/harness2/agent_profiles_harness2/bridge.py:189,294-298`).
   Converters explicitly require Codex at migration start, proposal, plan and
   results boundaries (`converters.py:24-52,60,129-168,181-185`). Change these
   together only after native host selection works. Preserve old captures as
   historical evidence; require fresh captures rather than relabeling them.

## Implementation sequence and checks

Each slice must leave existing hosts usable. The table records the scope and
acceptance checks used for the implementation.

| Slice | Change reaches | Evidence required before claiming completion |
| --- | --- | --- |
| Safe native installation | `src/integrations.ts`, `src/install.ts`, managed surface accounting in `src/diagnostics.ts`, metadata in `src/inspect.ts` | Coexisting Codex/OpenCode blocks or a separately owned native instruction mechanism; install in both orders; repeated setup; no replacement of user JSON/JSONC; malformed markers, symlinks and changed files refuse before writes; uninstall preserves user instructions and settings. |
| Explicit selection and skills | `src/resolve.ts`, `src/skills.ts`, `src/external-skills.ts`, `src/configure.ts`, `src/presets.ts`, CLI help and executable inspection | Exact `provider/model` retained with honest identity provenance; unknown model follows configured fallback; explicit role mapping for each agent/subagent; duplicate/ancestor/global skill cases match pinned native behavior; visibility and permissions remain host-controlled. |
| Retained workflow | Registry-derived validators in `src/packages.ts`, `src/stamps.ts`, `src/migrations.ts`, resolver/configuration callers and existing fixtures | OpenCode stamp capture, verify and reconstruction; skill-only fork, proposal, candidate, paired plan/results, preview and explicit promotion; Codex/OpenCode identity mismatches rejected; historical stamps unchanged; include config3/lock2 coverage. |
| Harness² conversion | `integrations/harness2/agent_profiles_harness2/bridge.py`, `converters.py`, `test_bridge.py`, `test_converters.py`, `test_native_adapters.py` | Real OpenCode assignment carried into captures and stamps; surface/host equality checked; exact paired coverage and distinct fixed arms; changed input/run ID refuses before launch; native execute and batch/cache paths actually consume selected bytes. |
| User path and observation | `docs/hosts/opencode.md`, setup assistant prompt, `README.md`, `docs/hosts/harness2.md`, `CHANGELOG.md`, opt-in observation record | Credential-free setup walkthrough; exact executable/model versions and launch command for live checks; observed instructions and native skill load; session boundary check; explicitly list anything not observed. |

The implementation uses an independently owned OpenCode marker pair in shared
`AGENTS.md`; installation folds both hosts' edits into one checked write. It
preserves JSON/JSONC by leaving configuration untouched. Native loading and an
actual bootstrap invocation have been observed in v2.1.3. Harness²'s
`systemprompt.md` remains an intermediate surface, not a standalone discovery path.

Start focused coverage in `test/opencode.test.js`, following
`test/hermes.test.js`. Extend the existing install, protocol, inspect, external
skill, stamp and migration suites where their shared behavior changes; reuse
fixtures instead of introducing a second workflow implementation. Native-loading
fixtures must observe bytes at the upstream loading/launch boundary, not merely
assert the generated directory tree. A fabricated model response is not live
evidence that bootstrap resolution ran.

## Baseline checks and remaining risks

- Windows PowerShell, Node `v24.20.0`; `npm run typecheck` passed.
- Initial investigation found no OpenCode executable. After the user installed
  it, v2.1.3 was found and native/live loading checks passed; see the linked
  observations for the exact boundary and reproduction commands.
- Focused existing host/stamp baseline: `node --test test/install.test.js
  test/hermes.test.js test/protocol.test.js test/stamps.test.js`. Initial sandbox
  execution could not spawn test workers (`EPERM`); rerun outside the sandbox.
  Rerun passed: 172 tests, 172 passed, zero failures or skips.
- The workspace already contained a change to `.trail/hook.cjs`; leave it alone.
- Preserve #28's native seed routing and pre-launch immutable input reservation
  safeguards. Samson's native-seeding learning explains why `base_harness` alone
  and post-execution conflict checks are insufficient. No old run IDs or sidecars
  should be rewritten to manufacture OpenCode evidence.

No new model runner, judge, orchestration layer, permission sandbox, broader
candidate format or automatic promotion is part of this issue. Keep Node at 24;
any CI additions use modern actions and macOS 14 or newer.
