# Versioning and upgrades

## 0.30.0 — bind library versions and replace variants (unreleased)

With `visualize --edit`, a library version the project does not bind yet can be
bound and added to a role. Skills that share a SKILL.md `name` are treated as
variants: for a package skill the role already lists, the page previews replacing
it for the selected host × model × role (the same change as `agent-profiles update`)
and applies it after you confirm. The trust policy is checked before anything is
written; configuration v3 bindings pin the release revision.

No YAML, lock-format, store or bootstrap migration is needed. Restart the visualizer
from the upgraded runtime with `--edit`. Review the written `agents.yaml`, any new
`assignments` rule and the refreshed locks like any other configuration change.

## 0.29.0 — configuration edits from the visualizer (unreleased)

Start the visualizer with `--edit` to add or remove role skills and add models,
families and roles from the page. Without `--edit` it stays read-only, as before.
Edits are written to the layer that owns them: the project `agents.yaml`, or the
adapter `agents.yaml` for adapter roles and adapter skills. Locks are refreshed
from the local store after each edit. Nothing is signed or downloaded.

No YAML, lock-format, store or bootstrap migration is needed. Upgrade the runtime
that launches the visualizer and restart it with `--edit` when you want to edit.
Commit or review the written `agents.yaml` and lock files as you would any other
configuration change.

## 0.28.0 — side-by-side skill comparison (unreleased)

Each skill library row has **Set as left** and **Set as right** buttons for the
comparison. **View → Side by side, full files** shows every file of both skills,
unchanged files and lines included, aligned line by line. `api/compare` adds an
`aligned` field. Existing fields are unchanged.

No YAML, lock-format, store or bootstrap migration is needed. Restart the
visualizer from the upgraded runtime and reload the page.

## 0.27.0 — skill library panel (unreleased)

The visualizer page adds a **Skill library** panel. It loads on request, lists
library and project-local skills with search and filters, compares any two of
them file by file, and previews a role that uses a skill. Missing versions,
digests and evidence are shown as unknown or untested. Nothing is written.

No YAML, lock-format, store or bootstrap migration is needed. Upgrade the runtime
that launches the visualizer, restart it and reload the page. See
[Live visualizer](Live-visualizer).

## 0.26.0 — skill catalog and comparison API (unreleased)

The visualizer serves two new read-only endpoints under its session URL:
`api/skills` lists library skill packages and project-local skills with their
role usage, and `api/compare?left=…&right=…` compares any two of them file by
file. Missing versions, digests and evaluation evidence are shown as unknown or
untested. The browser page is unchanged in this version.

No YAML, lock-format, store or bootstrap migration is needed. Upgrade the runtime
that launches the visualizer and restart it to get the new endpoints. See
[Live visualizer](Live-visualizer) and `docs/visualize.md` for selectors.

## 0.25.2 - status-skill CI fixes (unreleased)

Update the protocol installation fixture for the bundled skill files and isolate
machine trust consistently in the package smoke test's CLI and in-process paths.
This fixes test expectations and test isolation; runtime behavior is unchanged.
No additional migration is needed. Use the newest runtime when published and
follow the 0.25.0 status-skill installation instructions below.

## 0.25.1 - prominent status instructions (unreleased)

The README now introduces `ap-status` immediately after the project summary,
with host-specific invocation and guidance to run it in the agent session being
inspected. This documentation patch does not change runtime behavior or require
a migration. Follow the 0.25.0 installation steps below using the newer runtime
when published; neither version is implied to be available on npm yet.

## 0.25.0 - bundled ap-status (unreleased)

The implementation on `feat/bundled-ap-status` adds a native status skill for
Codex and Claude Code. It reports the session's last successful resolution,
required package versions and optional skills on the bench. It is not a live
execution monitor and does not silently refresh the role.

After upgrading the runtime to 0.25.0, rerun `init --agent codex` or
`init --agent claude`. Preserve your MCP configuration. No YAML migration is
needed. Before publication, use a built checkout or packed artifact rather than
assuming 0.25.0 exists on npm. Unchanged managed skill files are upgraded;
pre-existing or edited targets must be moved aside first. Uninstall retains edits.
See [Session skill status](Session-skill-status) for paths and invocation.

## 0.24.0 — live adapter visualizer (unreleased)

The visualizer opens the real project through `agents.local.yaml`, with composed
roles, skills, exact adapter model choices and a host selector. Host-qualified
assignments retain their predicates and profile routing provenance. **Refresh files**
rereads live files and keeps valid selections at the same URL; errors hide old
results and clear after repair and another refresh. Version 0.24.1 removes the
background polling introduced in the unreleased 0.24.0 implementation.
The visualizer never installs, signs or refreshes locks itself.

Upgrade the runtime that actually launches the visualizer. Building a checkout
does not update an older package installed in a workbench. Before npm publication,
use the built checkout or a local packed artifact:

```powershell
npm run build
node C:\workspace\Agent-Profiles\dist\bin\agent-profiles.js visualize --root C:\workspace\Agent-Profiles --host codex --model gpt-6.1-sol --role sp-implementer
```

Preserve the CLI/MCP process's `AGENT_PROFILES_TRUST` policy and signing settings.
Stop the old snapshot server once and open the new live project's URL. Subsequent
file changes require only **Refresh files**, not a restart. No YAML, lock-format, store or bootstrap migration
is needed. Already-running agents must resolve again to receive new instructions.
See [Live visualizer](Live-visualizer) for refresh and error behavior.

## 0.23.10 — wiki source reconciled

The repository copy under `docs/wiki/` and this wiki now match. Documentation
only: no runtime, YAML, lock, store or bootstrap migration, and no npm release.
Older "unpublished working source" compaction notes were removed; the 0.19.7
entry below covers the merged Skill Compaction preset.

## 0.23.9 — npm release of 0.22.1–0.23.8

0.23.9 publishes the changes from 0.22.1 to 0.23.8 to npm; the previous
published version was 0.22.0. Two of them change what users of the package see:
`resolve` text names the package identity of each packaged skill (0.22.1), and
`update` can move a tuple to a variant package (0.23.0). The rest add
documentation and tests. Upgrading from 0.19.4 or later needs no YAML, lock,
store or bootstrap migration; the bootstrap stays at protocol 3. In
PowerShell, run `npx.cmd` instead of `npx` (#106).

## 0.23.6–0.23.8 — failure-case fixtures and live results (#83)

Test fixtures and documentation only; no npm publication implied, and no
runtime, YAML, lock, store or bootstrap migration. `test/fixtures/issue-83/`
prepares disposable projects that force each #80 failure path: an MCP tool error,
cut MCP or shell output, a slow MCP server, and a failing shell command. In 0.23.7,
`prepare.mjs` stopped running `init` and gained `--finish`, which applies the
fault after `init`. Live results on Claude Code 2.1.322 (headless) and T3 Code
with Opus 5.5: a one-run pilot, then five runs per cell, 40 of 40 passing. Two
cells are deferred for host reasons: headless Claude Code waits for MCP servers
before the first turn, and T3 starts it before a slow project server connects.
See [host observations](https://github.com/guisam/Agent-Profiles/blob/main/docs/host-observations.md).
In a new folder, headless Claude Code ignores project allow rules until the
folder is trusted.

## 0.23.5 — proposed TDD completion protocol (#33)

Documentation only; no npm publication implied. The
[proposed completion protocol](https://github.com/guisam/Agent-Profiles/blob/main/docs/examples/tdd-completion-protocol.md)
prepares the remaining live #33 demonstration with Opus 5.5 and Sonnet 5.5 as
implementers on Claude Code. It is a proposed revision of the planned Luna/Sol
example, not an accepted or executed experiment, and it authorizes no model
runs, spending or adoption. No runtime, YAML, lock, store or bootstrap
migration is needed; no pins change.

## 0.23.4 — guided journey replay test (#33)

Test and documentation only. `test/guided-replay.test.js` replays the
[guided workflow](Guided-skill-evaluation) with fixture evidence: selection, a
compatibility refusal, a refused untested model, report, preview, explicit
adoption, unchanged pins for other models, a refused stale restore and a
guarded restore to the baseline. It checks mechanics, not model quality.
Restoration remains the guide's manual procedure; there is no restore command.
No configuration, lock, store or bootstrap migration is needed.

## 0.23.3 — PowerShell wrapper investigation (#106)

Documentation only; no npm publication implied. The
[selector-forwarding investigation](https://github.com/guisam/Agent-Profiles/blob/main/docs/powershell-selector-forwarding.md)
reproduces selector loss before AP on the tested npm PowerShell shim.
`npx.cmd` preserved forwarding. No runtime, YAML, lock, store or bootstrap
migration is needed; no global shim, execution policy or live pins change.

## 0.23.2 — mixed-model reviewer case study (#105)

Documentation only, not an npm release announcement. The
[mixed-model case study](Mixed-model-reviewer-case-study) records source 0.23.1
trials. No configuration, lock, store or bootstrap migration is needed; no pins
change. Selection and delivery were observed, not quality or token savings.

## 0.23.1 — subagent delivery observations (#82)

Unreleased. Documentation, fixture and test changes only; the resolver, MCP
server and configuration format are unchanged. No configuration, lock or store
migration is needed and `init` does not need to be re-run.

What changed for users:

- **Subagents have been observed** in headless Claude Code CLI and in T3 Code, with
  Opus 5.5 and one trial each. Custom agents, the built-in `general-purpose`
  agent and T3 `delegate_task` children received the `CLAUDE.md` bootstrap and
  resolved before role work (ToolSearch may precede resolution). They got their
  own role: the role their definition or brief assigns, or `default_role` when
  none is assigned.
- **No child took the parent's role.** A child whose `resolve` failed reported
  incomplete setup and did no role work.
- **The built-in `Explore` agent gets no bootstrap**, and it worked before it
  resolved. Use a custom agent (`.claude/agents/*.md`) that states its role for
  role work.

Action, if you share one Agent Profiles MCP server between a parent and its
subagents: bind it to the host only (`agent-profiles mcp --host claude`). A server
bound with `--role` imposes that role on every caller and refuses a child's own
assignment. Interactive CLI matched for the custom agent with an assigned role; its other
rows, other models and repeated trials are tracked in
[#105](https://github.com/guisam/Agent-Profiles/issues/105).

To repeat the observation, see `test/fixtures/issue-82/README.md`.

## 0.23.0 — update to a variant package (#89, #91)

Unreleased. These notes describe the source on the feature branch. Use them once
0.23.0 is merged; it was first published to npm in 0.23.9.

New feature: in configuration v3, `update` and MCP `update_preview` can move one
exact role × model × host tuple to a differently named package, such as a
model-specific variant:

```sh
agent-profiles update skills.brainstorming @apsp/brainstorming-sonnet-5-5@0.1.0 --model claude-sonnet-5-5 --role brainstormer --host claude
```

The move uses the same guards as a version move:

- a preview with a content diff and evidence;
- a check that no other tuple's selection changes;
- `previewDigest` and `--expect`;
- a release label on the target;
- trust checks and layer ownership with a project adapter.

The preview names both package identities. `--json` adds `before.package` and
`after.package`. Nothing is promoted or selected automatically.

Fix (#91): the target is checked before lookup. A malformed or unsupported target
is reported as written. Before, `@demo/tool@@demo/variant@1.0.0` was reported as
"not in the library". Now the error says that `@demo/variant@1.0.0` is not an
exact version.

Fix: an edit that would stop any tuple from resolving is refused with the
resolver's error. One case is a target whose package type doesn't match the
binding. Before, such an edit was reported as "does not change the target
selection".

Meaning of a bare version: `update <binding> 0.2.0` targets a version of the
package that the tuple selects now. If the tuple already selects a variant, that
is the variant's package, not the binding's default. To return a tuple to the
default package, use the package-qualified form.

Upgrade: no YAML, lock, store or stamp migration. Existing commands and
same-package previews keep their digests and text. Configuration v2 projects
can't move to another package. `update` refuses with a pointer to the
[v2 → v3 conversion guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/migrations/config-v2-to-v3.md)
and never converts the schema. See
[variant packages](https://github.com/guisam/Agent-Profiles/blob/main/docs/versioned-packages.md#move-one-tuple-to-a-variant-package).

## 0.22.1 — required skill package identity (#90)

CLI and MCP text resolution now shows `Package <name>@<version> (sha256 <digest>)`
above required and explicitly requested packaged skill bodies. This identifies
the package whose supporting files can be read through the library. No store
path is exposed. Local skills, JSON output and selection rules are unchanged.
No YAML, lock, store or bootstrap migration is needed. Blinded evaluations must
account for the newly visible identity; no identity-hiding option is added.

## 0.22.0 — stamps, verify/diff, evidence and inspect with a project adapter (#98)

Published to npm on 2026-11-10. The downloaded archive matches the CI and
registry checksum.

New feature: `stamp`, `inspect` and `sessions` now work while
`.agent-profiles/agents.local.yaml` references an adapter. 0.21.0 refused them.

- A composed stamp records the composed configuration digest, each contributing
  input by layer, adapter approvals, and the entries the adapter added, in a new
  `configurationSources` field. It names the adapter by an optional `label` and a
  reference digest, never by machine path.
- `verify` reports which configuration inputs reproduce and whether the adapter
  lock covers the composed configuration. `diff` labels each change's layer and
  flags a committed-only versus composed comparison (`sameMode: false`).
- Session records and the MCP stamp line state the configuration mode and, for a
  composed run, its digest and adapter.
- `inspect` lists the adapter and its files, reading only inside the adapter root.
- After an adapter-owned `update`, apply records a stamp. After a project-owned
  update the adapter lock is stale: run `agent-profiles install`, then
  `agent-profiles stamp`.

Upgrade: no YAML, lock, store or bootstrap migration. Committed-only stamps keep
the same bytes and digests. Optional: add `label: <name>` to
`agents.local.yaml` to choose how stamps and evidence name the adapter. A label
is 1–64 letters, digits, spaces, dots, hyphens or underscores. Earlier versions
reject the `label` key, so add it only after every tool that reads this project
runs 0.22.0. Earlier versions cannot read composed stamps. Session records
written before 0.22.0 have no `configuration` field. See
[project adapter](https://github.com/guisam/Agent-Profiles/blob/main/docs/project-adapter.md#stamps-verify-diff-and-evidence).

## 0.21.0 — guarded updates with a project adapter (#97)

New feature: `update` and MCP `update_preview` now work while
`.agent-profiles/agents.local.yaml` references an adapter. 0.20.0 refused them.

- An update of a binding the adapter declares edits only the adapter's
  `agents.yaml` and lock. An update of a project binding edits only the project's
  `agents.yaml` and lock. The adapter's lock then becomes stale. `update` never
  writes another layer's lock; run `agent-profiles install` as a separate step.
- An adapter rule can pin an exact model ID that the project does not declare. No
  project `models` entry is added, and routing stays the project's.
- Previews name each edit's layer and file. `previewDigest` also covers the local
  reference, the adapter's configuration and lock, and the selected store
  versions, so `--apply --expect` refuses if any of them changed.
- Apply never signs. Unapproved targets are refused under `require_approval`.
  Approve with `agent-profiles library approve` first.
- In adapter mode, apply records no stamp; stamps are #98.

Upgrade: no YAML, lock, store or bootstrap migration. Projects without an adapter
behave as before. Their `update` JSON gains `layer`, `adapter: null` and `locks`, and
each edit gains `layer` and `file`. `outdated` pins gain `layer`. Text output is
unchanged. A preview made with an older version does not apply with 0.21.0: preview
again. See [project adapter](https://github.com/guisam/Agent-Profiles/blob/main/docs/project-adapter.md#updates).

## 0.20.0 — project adapter (#85)

New feature: an ignored `.agent-profiles/agents.local.yaml` can name one external
adapter whose additions compose over the committed configuration. The additions
are package skills, roles, extra role skills, and assignments over the adapter's
own bindings, including exact-model selection. The adapter keeps its own lock and
approvals. Projects without the local file are unaffected: there is no YAML, lock,
store or bootstrap migration. Commands that do not compose an adapter yet (`update`,
`configure`, `preset`, `migrate`, `stamp`, `inspect` and others) refuse while one
is configured. See [project adapter](https://github.com/guisam/Agent-Profiles/blob/main/docs/project-adapter.md).

## 0.19.10 — npm package ships only named templates

The package now lists each shipped `.agent-profiles/` template by name instead
of the whole folder (#85). If you build packages from a checkout that holds
local locks, approvals or extra roles, they no longer enter the tarball, or
new projects through `init`. Edits to the shipped templates themselves still
ship, so publish from CI or a clean checkout. No YAML, lock, store or bootstrap
migration; existing projects are unaffected. New guide:
[separate your skill workshop](Separate-your-skill-workshop).

## 0.19.9 — model-specific prompt audits

The [skill-tuning guide](Tuning-skills-by-model-and-role) now includes Anthropic
and OpenAI guidance, a scoped audit prompt and model-specific evidence limits.
No runtime, YAML, lock, store or bootstrap migration is required. No active
skill selections change, and this source version does not imply npm publication.

## 0.19.8 — model-and-role skill tuning guide

Adds [tuning guidance and copyable prompts](Tuning-skills-by-model-and-role),
including retrospective evidence, evaluation, scoped adoption and rollback.
Documentation only: no YAML, lock, store or bootstrap migration is needed.
No existing pins change. The guide does not authorize model runs or adopt a
candidate. This source version does not imply npm publication.

## 0.19.7 — Skill Compaction preset

Adds the [Skill Compaction preset](https://github.com/guisam/Agent-Profiles/tree/main/examples/presets/skill-compaction)
(preset 1.0.5): a `skill-compactor` role that prepares model-specific skill
candidates by removing familiar execution explanation while preserving the
behavioral contract. Importing it selects or adopts nothing; candidates need
behavioral evaluation. Its draft development cases are unexecuted. A worked
application, with findings and evaluation method, is the
[agent-profiles-superpowers](https://github.com/guisam/agent-profiles-superpowers)
companion. No runtime, YAML schema, lock or bootstrap migration is required.

## 0.19.5 — portable Ponytail role preset

Adds the [Ponytail role preset](Ponytail-role-preset) with four MIT-licensed
instruction skills, standalone agents.yaml and model-specific pinning guidance.
No runtime, YAML schema, lock or bootstrap migration is required. Existing
projects can keep their configuration and optionally inspect/import the preset.
This source version does not itself imply an npm release.

## 0.19.4 — complete npm, MCP and security onboarding

The README setup prompt and [setup guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/setup.md)
now include MCP registration, the protocol-3 project bootstrap, security decisions
and live verification. The npm examples use 0.19.4 instead of 0.19.1.

The setup proposal covers existing host permissions, exact shared-package pins,
whether signed approvals are required, allowed namespaces/effects and approvers.
Machine signing keys and credentials stay outside the repository and chat;
project policy can only narrow machine policy. Package integrity and approval do
not establish safe instructions or model effectiveness.

After publication, upgrade from the target project:

```sh
npm install --save-dev --save-exact @guisam/agent-profiles@0.19.4
npx --no agent-profiles init --agent claude --mcp
npx --no agent-profiles doctor
```

Use the intended host, preserve other installed integrations, and run host-denied
setup commands yourself. Version 0.19.4 is documentation-only and retains protocol
3. Re-running init is particularly important when upgrading from before 0.19.3;
a current 0.19.3 bootstrap has no new protocol migration. No YAML, lock or store
migration is needed.

Register MCP separately if it is not already configured; preserve existing server
entries. Keep the local resolver and project bootstrap even with MCP, because the
server can connect after the first task begins. Start a fresh session and verify
resolution before work, every required skill body, and the final context marker.
On failure, stop role work until resolution succeeds. CLI checks alone do not
verify host behavior. Subagent delivery was observed in 0.23.1
([#82](https://github.com/guisam/Agent-Profiles/issues/82)); failure scenarios
were live-tested in 0.23.8 ([#83](https://github.com/guisam/Agent-Profiles/issues/83)).

## 0.19.3 — truncation-safe MCP startup instructions (#80)

Bound MCP servers (`agent-profiles mcp --model … --role …`) used to put the whole
resolved profile into their startup instructions and tell the agent not to call
`resolve` again. Claude Code (CLI and T3 Code) truncated that payload inside the
first required skill, and the agent then worked from the partial copy, including
after `/clear`.

From 0.19.3:

- Server instructions, bound or not, are a short bootstrap that never contains
  profile, role or skill text. The agent must call `resolve` before role work and
  again after `/clear`, compaction or a model or role change.
- Every `resolve` output ends with `End of Agent Profiles context: <n> section(s): <ids>.`
  If the agent cannot see that line, it reports incomplete setup instead of
  working from partial instructions.
- Any resolver failure (an error such as a missing skill file, no output, or no
  final line) means setup is incomplete: the agent reports it and stops, with no
  role work until a later `resolve` succeeds. The CLI's stderr and the MCP tool
  error repeat this after the error.
- A bound server refuses selector arguments that conflict with its binding. Start
  a server bound to the new model or role to change them.
- The managed block moves to protocol 3. Its MCP variant always calls `resolve`,
  and runs the shell command at once when the tool is not available yet.

### Upgrade instructions

1. Update the installed package to 0.19.3 or newer from npm, or rebuild and
   install a reviewed tarball from a checkout. A source bump alone does not publish it.
2. Run `agent-profiles doctor`. Protocol 2 blocks and an old
   `.agent-profiles/BOOTSTRAP.md` are reported stale.
3. Run `agent-profiles init` (add `--mcp` only if you use the handoff; `init`
   keeps the installed variant otherwise). Review and commit the refreshed
   `CLAUDE.md`/`AGENTS.md` block and `BOOTSTRAP.md`.
4. Bound servers need no configuration change. Remove any custom prompt or
   automation that relied on the profile appearing in server instructions or on
   passing a different `role` or `model` to a bound server.
5. Start a fresh session and check that the agent calls `resolve` before its
   first task and that the output ends with the final line.

No YAML, lock or store migration is needed. Lifecycle hooks for `/clear` and
compaction are not installed; delivery after those events still depends on the
agent following the bootstrap. A subagent must call `resolve` itself, passing a
role only when one is assigned to it; see the 0.23.1 notes
([#82](https://github.com/guisam/Agent-Profiles/issues/82)).

## Source patch: 0.19.2 — published-package and MCP onboarding

The README's setup prompt and [setup guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/setup.md)
now lead with version-pinned npm inspection after approval of tool preparation.
The same reviewed version is installed into the project. Inspection itself is
read-only; npm can download and install the tool in its cache.

Claude Code setup recommends the optional MCP handoff, followed by separate
approved server registration and a live `resolve` connection check. Existing deny
rules remain in force. Compaction/clear observations are host-specific, and CLI
checks do not establish T3 integration. Existing shared libraries should be
considered before duplicating skills.

### Upgrade instructions

This documentation patch was included in the published 0.19.3 release; 0.19.2
was not published separately. At the time its walkthrough used 0.19.1; current
examples above use 0.19.4. This patch itself required no YAML, lock, store,
managed-block or bootstrap migration.
To opt into MCP, review `init --agent <host> --mcp` and the separate host setup
it prints; preserve existing MCP entries and verify the connection in a fresh
session. Prepare any host-denied command for the user to run in a terminal.

Use the application version to identify a completed task's changes. The version is stored in `package.json`; keep the root package versions in `package-lock.json` synchronized.

## Choose the task's version bump

Apply the highest applicable bump once per completed repository task:

| Change | Bump | Example |
| --- | --- | --- |
| Minor revision, bug fix, or documentation change | Patch | `1.2.3` → `1.2.4` |
| New feature | Minor; reset patch | `1.2.3` → `1.3.0` |
| Backward-incompatible rewrite of the configuration YAML | Major; reset minor and patch | `1.2.3` → `2.0.0` |

Check version-dependent fixtures, packaging checks, and documentation when updating the version. Changing version metadata does not publish a package, create a release, or authorize a Git tag.

## Complete the task

After implementation, appropriate verification, and the version update, update the wiki as the final completion step. Describe the relevant behavior changes and any necessary upgrade instructions. If publication is blocked, report that limitation explicitly.

For an incompatible configuration change, include the affected old and new formats, before/after examples, migration steps, required user actions, and verification of the upgraded configuration. Keep the application version distinct from the YAML format's schema version.

## Source update: 0.1.0 to 0.2.0

The working 0.2.0 source adds the [assistant-assisted guided evaluation workflow](https://github.com/guisam/Agent-Profiles/wiki/Guided-skill-evaluation) and a bounded external [Windows JobBench pilot launcher](https://github.com/guisam/Agent-Profiles/wiki/Windows-JobBench-pilot). This is a feature version bump; the package remains unpublished. The workflow uses the existing CLI and bridge without altering configuration YAML, managed locks, packages, stamps, plans, results, or promotion formats. No schema migration is required for this update.

Keep project configuration, pins and retained evidence. When using a packed source build, rebuild and deliberately install the new `agent-profiles-0.2.0.tgz` artifact after its package checks; changing a source checkout does not upgrade an installed copy. Start the guided flow with read-only inspection. Paid runs and adoption still require their own explicit decisions. The two-model baseline pilot completed; candidate improvement and held-out qualification remain pending.

For the Windows pilot, first confirm a working native sandbox in your normal Codex session. The launcher retains the existing `windows.sandbox` selection from the active user configuration while excluding unrelated settings. It refuses missing or unsupported selections before model calls. Keep old failed attempts and create a new run after updating the launcher; do not disable sandboxing or add blanket allow rules. Follow the pilot guide for its exact runtime pins and artifact checks.

## Source patch: 0.2.1

The unpublished `0.2.1` source patch records
the Strata verification-skill experiment and its negative completion result; it
does not install the candidate or change application behavior or configuration
schemas. Existing project configuration, package pins and retained experiments
remain valid. No migration or skill adoption is required. If rebuilding the
unpublished package, deliberately select `agent-profiles-0.2.1.tgz` and run its
package checks; the experiment is not a reason to replace a working installation.

## Source patch: 0.2.2

The unpublished `0.2.2` source patch records
the explicitly authorized twenty-minute Strata follow-up. The candidate finished
all four documents but retained content defects; it was not adopted. The longer
limit applies only to that retained experiment driver. Normal pilot defaults,
installed skills and configuration schemas are unchanged, so no migration is
required. Keep earlier experiment evidence. If deliberately rebuilding the
unpublished package, select `agent-profiles-0.2.2.tgz` and verify its metadata;
recording this experiment does not require replacing a working installation.

## Source feature: 0.3.0

The working package version is `0.3.0`, still unpublished. The new
[agent qualification workflow](https://github.com/guisam/Agent-Profiles/wiki/Agent-qualification)
adds a starting prompt, requirements intake, report template and worked pilot
report around the existing evaluation and adoption tools. It introduces no new
CLI command, configuration schema, native plan/results format or automatic
qualification engine. No configuration migration or skill adoption is required.

Keep existing project configuration, package pins, evidence and installed skills.
Use the new guide directly from a trusted source checkout. If deliberately
rebuilding the package, select `agent-profiles-0.3.0.tgz` and check its metadata;
changing this checkout does not update an installed copy. Start a new report
beside retained evidence rather than rewriting old results or assuming an old
pilot now meets a service tier. Basic/premium labels remain report/client labels,
not new YAML selectors. Live novice-path and full service qualification are still
pending; published examples do not qualify either pilot model.

## Source patch: 0.3.1

The unpublished `0.3.1` documentation patch records the
[Luna/Sol comparison](https://github.com/guisam/Agent-Profiles/wiki/Luna-Sol-qualification),
including completed execution, retained native evidence, negative candidate
findings and rubric calibration limits. It changes no application behavior,
configuration schema, installed skill or profile assignment. No migration or
adoption is required. Keep existing configuration, pins and experiment evidence.
If deliberately rebuilding this source, select `agent-profiles-0.3.1.tgz` and
verify its metadata; updating the checkout does not upgrade an installed copy.

## Source feature: 0.4.0

The unpublished `0.4.0` source adds
[saved profile examples and offline run-evidence export](https://github.com/guisam/Agent-Profiles/wiki/Saved-profile-evidence).
Luna and Sol examples have explicit roles with a shared API-documentation skill
and different additional review skills. They were configuration-validated after
model experiments stopped; no new quality claim is attached. Historical YAML,
instruction and version evidence is retained separately from these new examples.

No application configuration schema, live profile assignment or host setting is
changed. No migration is required. Review preset imports and model-mapping
conflicts explicitly; the preset sets no defaults. Restore historical snapshots
into a new project first, compare their hashes, then review any merge into a live
project. A portable YAML snapshot does not restore package-lock history or host
runtime state. If rebuilding, deliberately choose `guisam-agent-profiles-0.4.1.tgz` and
verify its metadata; the source-only archive helper requires this trusted checkout.

## npm release: 0.4.1

The first npm release, [`@guisam/agent-profiles@0.4.1`](https://www.npmjs.com/package/@guisam/agent-profiles/v/0.4.1), was published on 2026-10-28 by `guisam` with browser 2FA. npm rejected the unscoped name as too similar to `agentprofiles`; no unscoped version was published. The terminal command remains `agent-profiles`.

```sh
npm install --save-dev @guisam/agent-profiles@0.4.1
npx --no agent-profiles init --agent codex
npx --no agent-profiles doctor
```

Choose the agents appropriate to your project; the example selects Codex.

### Completed release checklist

- [x] Personal npm account `guisam` confirmed, with verified email, 2FA and recovery codes.
- [x] [PR #35](https://github.com/guisam/Agent-Profiles/pull/35) merged release preparation and the manually dispatched Node 24 publishing workflow.
- [x] [PR #36](https://github.com/guisam/Agent-Profiles/pull/36) merged the scoped package identity, bootstrap verification, fixtures, tarball paths and installation guidance.
- [x] [Full scoped-release CI](https://github.com/guisam/Agent-Profiles/actions/runs/40771102673) passed Windows, macOS, Linux and cache-disabled tests. Local type checking, Biome, 97 affected tests, packed-package smoke and the runtime dependency audit also passed.
- [x] Published the reviewed 94-file tarball. The live registry's integrity exactly matched the approved artifact. npm's publish-time scanning delayed initial availability; the version subsequently became installable.
- [x] Installed the actual registry version in an isolated project and exercised inspect, init, interactive role creation, doctor, resolve, proof and uninstall. Assertions confirmed that uninstall preserved the original instructions and retained the configuration and created role.
- [x] Created GitHub environment `npm`, restricted to the `main` branch, and the npm trusted publisher for repository `guisam/Agent-Profiles`, workflow `publish.yml`, environment `npm`, with publication permission.
- [x] [Publishing workflow rehearsal](https://github.com/guisam/Agent-Profiles/actions/runs/40773083025) passed on `main` with publication disabled.

The reviewed tarball's SHA-256 is `448396a5cf0454a326db98def743cd5ff515cacec21570a9450c2cf259805228`.

### Upgrade instructions

For a previous unscoped source-tarball installation, run `npm uninstall --save-dev agent-profiles`, then install `@guisam/agent-profiles@0.4.1` as a dev dependency. Re-run init for the previously selected agents and run doctor. Keep `.agent-profiles/`, existing configuration, pins, stores and retained evidence. No configuration YAML, managed-lock, stamp or evaluation-schema migration is introduced by this publication. Updating a source checkout does not update an installed copy.

### Future releases and verification limits

The first release used manual authentication; an actual OIDC publication has not yet been exercised. Dispatch `publish.yml` on `main` with the exact next manifest version, rehearse with publication off, then enable publication only for an authorized release. npm versions cannot be overwritten; do not try to republish 0.4.1.

A newly created trusted-publisher configuration must complete its first successful publication within two days or be recreated before use. The non-publishing rehearsal does not validate that first-publication requirement. See [npm trusted-publisher expiry](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).

npm publication and offline packaging tests do not establish live model/host qualification or close existing qualification gates. Git tags and GitHub releases were not created.

## npm release: 0.19.1

The second npm release, `@guisam/agent-profiles@0.19.1`, brings everything since
0.4.1 to `npm install`. Node 24 or newer is still required.

```sh
npm install --save-dev @guisam/agent-profiles@0.19.1
npx --no agent-profiles init --agent claude    # the agents you use
npx --no agent-profiles doctor
```

### What's new since 0.4.1

- **MCP service (0.5.0–0.7.x):** `agent-profiles mcp` serves `resolve` and other
  read-only tools. `init --mcp` hands the managed block off to it. It uses
  workspace roots and binds instructions at startup. See
  [MCP service](https://github.com/guisam/Agent-Profiles/wiki/MCP-service).
- **Skill library (0.8.0–0.10.0):**
  - `library publish`, `list`, `search` and `info`;
  - evaluation evidence per version;
  - `outdated`;
  - `update`, which previews before `--apply --expect`.

  See [Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library).
- **Update notice (0.11.0):** a startup-only Claude Code hook tells you when the
  library has newer versions for your pins.
- **Librarian tools over MCP (0.13.0–0.14.x):**
  - library tools and `update_preview`, with every `agents.yaml` edit and the
    exact apply command;
  - verified `library_read`, plus package files as resources;
  - `--version`.
- **Trust and safety (0.12.0, 0.15.0–0.17.0, 0.19.0):**
  - deny rules for library-changing commands;
  - content diffs in previews;
  - a trust policy with SSH-signed approvals (`library approve`) and enforcement;
  - instruction lint.

  See [docs/trust.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/trust.md).
- **Session records (0.18.0):** opt-in records of which stamp, model and package
  versions each session resolved.
- **Faster CLI start** and store caching (0.11.2).

### Upgrade instructions from 0.4.1

1. Install `@guisam/agent-profiles@0.19.1` as a dev dependency.
2. Run `init` again for the agents you selected before. For Claude Code, this adds
   the update-notice hook and the deny rules for library-changing commands.
   Existing instructions, roles and configuration are kept.
3. Run `doctor`.

No configuration YAML, lock, stamp or store-format migration is needed.
Optional:
- the MCP server (`init --mcp`, then the host setup `init` prints);
- a trust policy (`~/.agent-profiles/trust.yaml`);
- session records (`--record-sessions`).

Updating a source checkout does not update an installed copy.

### Release checklist

- [ ] Release preparation merged; CI passed on Windows, macOS, Linux and with the
      cache disabled.
- [ ] `publish.yml` rehearsal on `main` for `0.19.1`, with publishing off.
- [ ] Published, either through `publish.yml` with OIDC or manually with 2FA.
- [ ] Installed the registry version in an isolated project and exercised
      `init`, `doctor`, `resolve`, `library list` and `uninstall`.

## Source feature: 0.19.0 — instruction lint

The working package version is `0.19.0`, not yet published to npm. `library
publish`, `update` previews (and the MCP `update_preview`), and the new `library
lint <@namespace/name>@<version>` flag text that looks like prompt injection:
hidden characters, "ignore previous instructions", "don't tell the user", sending
secrets somewhere, piping a download to a shell, and similar. These are
heuristics: they never block. Tracking: #55 (step 3).

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; no migration.
`library publish --json` gains a `lint` field, and update previews gain `lint`.

## Source feature: 0.18.0 — session records

The working package version is `0.18.0`, not yet published to npm. Start the MCP
server with `--record-sessions` (or run `resolve --record-session`), and each
resolution is recorded under `~/.agent-profiles/sessions/`:
- the stamp digest;
- model, role, host and project;
- the client;
- package versions;
- withheld skills.

`agent-profiles sessions` lists the records. Tracking: #38 (phase 7).

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; off by default. To turn
it on for Claude Code, add `"--record-sessions"` to the `agent-profiles` server's
`args` in `.mcp.json`. See
[docs/sessions.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/sessions.md).

## Source feature: 0.17.0 — trust policy enforcement

The working package version is `0.17.0`, not yet published to npm. Under a trust
policy:
- `resolve` withholds packaged skills the policy blocks, and lists them as
  withheld. Sessions still get their profile and role.
- `install` and `update --apply` refuse blocked versions.
- Without a `signing_key`, `update --apply` and `library publish` ask for a short
  code on a terminal.

Blocked versions are those whose namespace or effects aren't allowed and, with
`require_approval`, those without a signed approval. Without a policy, nothing
changes. Tracking: #55 and #71.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change. Before turning on
`require_approval`:
1. Approve every pinned version with
   `agent-profiles library approve <@namespace/name>@<version>`. With
   `require_approval` on, `doctor` lists the commands to run.
2. Commit `.agent-profiles/approvals/`.

Otherwise sessions start without those skills, and `install` refuses. See
[docs/trust.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/trust.md).

## Source feature: 0.16.0 — signed approvals

The working package version is `0.16.0`, not yet published to npm.
`agent-profiles library approve <@namespace/name>@<version>` signs an approval of
that version's exact bytes with your SSH key (`ssh-keygen -Y sign`). The approval
is written under `.agent-profiles/approvals/` for you to commit. `library info`,
`outdated`, `update` previews and the MCP `update_preview` show approval status
under the trust policy. Nothing is enforced yet. Tracking: #55 and #71.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change. For Claude Code, run
`init` again to add the new deny rule for `library approve`; `doctor` notes it
until then. To try approvals:
1. Write `~/.agent-profiles/trust.yaml` with `allowed_signers` and `signing_key`.
2. Run `library approve` for a pinned version.
3. Commit the new files under `.agent-profiles/approvals/`.

## Source feature: 0.15.0 — trust policy (part 1 of signed approvals)

The working package version is `0.15.0`, not yet published to npm. This version
adds a trust policy (`~/.agent-profiles/trust.yaml`, optionally narrowed by a
project's `.agent-profiles/trust.yaml`) and native verification of SSH signatures
(Ed25519 and hardware Ed25519 keys) against an OpenSSH `allowed_signers` file.
`doctor` reports the policy. Nothing is enforced yet; signed approvals and
enforcement follow. See
[Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library).
Tracking: #55 and #71.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; no migration. Without
a `trust.yaml`, nothing changes.

## Source patch: 0.14.1 — `--version` from the installed package

The working package version is `0.14.1`, not yet published to npm.
`npx --no -- agent-profiles --version` failed in 0.13.3 through 0.14.0 from an
installed package (`ENOENT … dist/package.json`); it now prints the version. In a
live check on 0.14.0, an agent read a package file with `library_read` instead of
the store folder.

### Upgrade instructions

No migration.

## Source feature: 0.14.0 — verified package reads

The working package version is `0.14.0`, not yet published to npm.
`agent-profiles library read <@namespace/name>@<version> <path>` prints one
package file after verifying the version, and the MCP server adds the same as the
`library_read` tool. The server instructions tell agents to read package files
this way (or through the `agent-profiles://library` resources), not by opening
files in the store folder, where nothing verifies them. Tracking: #55 and #67.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; no migration. An
existing MCP server configuration gains the tool when it runs the new version.

## Source patch: 0.13.4 — librarian tools live recheck

The working package version is `0.13.4`, not yet published to npm. Docs only: on
Claude Code with Opus 5.5, an agent's `update_preview` summary now lists every
`agents.yaml` edit, including the model declaration, and gives the apply command
exactly as returned. No upgrade steps.

## Source patch: 0.13.3 — preview edits for agents, `--version`

The working package version is `0.13.3`, not yet published to npm. Previews
carry every `agents.yaml` edit as `edits` in `--json` and in the MCP
`update_preview` result, so an agent summarizing the structured result reports
the model declaration too. The apply command is printed as
`npx --no agent-profiles update …`. `agent-profiles --version` (or `-v`) prints
the installed version.

### Upgrade instructions

No migration. To check what a project has installed, run
`npx --no -- agent-profiles --version` (without the `--`, npx prints npm's own
version instead).

## Source patch: 0.13.2 — complete apply command in previews

The working package version is `0.13.2`, not yet published to npm. `update`
previews (and the MCP `update_preview` tool) now end with the complete apply
command, every argument filled in, including `--root`, and list every
`agents.yaml` edit together (the rule, and the model declaration when there is
one). In a live check on 0.13.1, an agent left the model declaration out of its
summary and had to rebuild the apply command itself.

### Upgrade instructions

No migration. Scripts that parsed the old `Rule:` or `Model:` preview lines
should read `--json` instead (`rule`, `declaredModel`, `applyCommand`).

## Source patch: 0.13.1 — update for undeclared models

The working package version is `0.13.1`, not yet published to npm. In a live
check on Claude Code, an agent used `update_preview` as intended, but the preview
failed: its model (`claude-opus-5-5`) reached a profile through `default_profile`
and wasn't declared in `models`. `update` (and `update_preview`) now declares such
a model with the profile it resolves to now, so routing doesn't change, and the
preview shows it on a `Model:` line. An alias targets its canonical model, and a
bare skill ID such as `security-review` gets a suggestion of
`skills.security-review`. See
[Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library).

### Upgrade instructions

No migration. An `update --apply` for an undeclared model now adds a
`models.<id>: {profile: <current profile>}` entry to `agents.yaml` alongside the
new rule; review it in the preview.

## Source feature: 0.13.0 — librarian tools in the MCP service

The working package version is `0.13.0`, not yet published to npm. The MCP server
adds six read-only library tools (`library_list`, `library_search`,
`library_info`, `library_evidence`, `outdated`, `update_preview`) and serves
package files as resources. See the
[MCP service](https://github.com/guisam/Agent-Profiles/wiki/MCP-service). Tracking: #38 and #58.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; no migration. An
existing MCP server configuration gains the tools when it runs the new version.
`update_preview` never applies; apply with
`agent-profiles update ... --apply --expect <previewDigest>` in a terminal.

## Source patch: 0.12.1 — deny rules live check

The working package version is `0.12.1`, not yet published to npm. Documentation
only: it records a live check of the deny rules on Claude Code 2.1.318 (see the
[Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library)).
No behavior, configuration or format change; no upgrade action is required.

## Source feature: 0.12.0 — library guardrails

The working package version is `0.12.0`, not yet published to npm. For Claude
Code, `init` adds deny rules so agents can't run the commands that change the
library, pins or the installation. `update` previews show a content diff of what a
new version would inject. The MCP server is read-only by design. Tracking: #55 and #67.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; no migration. To add
the deny rules to an existing installation, run `agent-profiles init --agent claude`
again. After that, run `library publish`, `add`, `install`, `update`,
`migrate promote`, `revision record`, `init` and `uninstall` in your own terminal;
an agent session is refused. `uninstall` removes the rules.

## Source patch: 0.11.2 — performance

The working package version is `0.11.2`, not yet published to npm. It contains
faster store reads and a lighter CLI start, with no behavior change. The compiled
`resolve` that runs at each agent session start takes about 113 ms instead of
185 ms. No configuration, lock, stamp or store-format change; no upgrade action
is required. Tracking: #53.

## Source patch: 0.11.1 — update notice live check

The working package version is `0.11.1`, not yet published to npm. Documentation
only: it records a live check of the update notice hook on Claude Code 2.1.318
(see the [Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library)).
No behavior, configuration or format change; no upgrade action is required.

## Source feature: 0.11.0 — update notice

The working package version is `0.11.0`, not yet published to npm. `notice`, a
Claude Code startup hook, `outdated --check` and a `doctor` "Updates" line tell
you when the library has newer versions for your pins. See the
[Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library). Tracking: #38 and #49.

### Upgrade instructions

No configuration YAML, lock or store-format change; no migration. To add the
Claude Code hook to an existing installation, run `agent-profiles init --agent claude`
again. It adds one `SessionStart` entry (matcher `startup`) to
`.claude/settings.json`, and `uninstall` removes it. Set
`AGENT_PROFILES_NOTICE=off` to disable the notice.

## Source feature: 0.10.0 — outdated and update

The working package version is `0.10.0`, not yet published to npm. `outdated`
lists pins with newer library versions and their evidence for the tuples each
pin serves. `update` previews, then with `--apply` writes, a move of one exact
role × model × host pin. See the
[Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library). Tracking: #38 and #48.

### Upgrade instructions

No configuration YAML, lock, stamp or store-format change; no migration.
`update --apply` writes to `agents.yaml` only when you run it: it replaces a rule
that already pins the exact tuple, or adds one `update-<hash>` rule, and then
refreshes the lock. Review the preview first. Promotion behaves as before, and
its rule ids are unchanged.

## Source feature: 0.9.0 — library evidence

The working package version is `0.9.0`, not yet published to npm. `library info`
and the new `library evidence` show, per version, the paired evaluations and
promotion decisions retained in the store for each exact role × model × host,
and where they came from. The library also lists promoted releases now. See the
[Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library). Tracking: #38 and #46.

### Upgrade instructions

No configuration YAML, lock, stamp, evaluation, promotion or store-format change;
no migration. Evidence you already retained with `migrate results` and
`migrate promote` appears without any action. In `--json` output, library
versions gain `source` (`package`, `adopted` or `promoted`) and `revisionDigest`.

## Source feature: 0.8.0 — local skill library

The working package version is `0.8.0`, not yet published to npm. It adds
`agent-profiles library list | search | info | publish` over the existing store.
See the [Skill library](https://github.com/guisam/Agent-Profiles/wiki/Skill-library). Tracking: #38 and #44.

### Upgrade instructions

No configuration YAML, lock, stamp, store-format or managed-block change; no
migration. Packages already in your store appear in `library list` as they are.
`library publish <directory>` is an alternative to `add` that reads the identity
from `package.yaml`; `add` keeps working unchanged.

## Source patch: 0.7.1 — MCP live check

The working package version is `0.7.1`, not yet published to npm. Documentation
only: it records a live check of the MCP service on Claude Code 2.1.317 with
Opus 5.5 (see the [MCP service](https://github.com/guisam/Agent-Profiles/wiki/MCP-service)).
No behavior, configuration or format change; no upgrade action is required.

## Source feature: 0.7.0 — MCP workspace roots and stamp digest

The working package version is `0.7.0`, not yet published to npm. Without a
`root` argument or `--root`, the MCP `resolve` and `explain` tools use the host's
workspace root that contains `.agent-profiles/agents.yaml`. Bound MCP
instructions start with the session's stamp digest, computed without writing to
the store; it matches what `agent-profiles stamp` records for the same selectors.
See the [MCP service](https://github.com/guisam/Agent-Profiles/wiki/MCP-service). Tracking: #38 and #39.

### Upgrade instructions

No configuration YAML, managed-lock, stamp format, evidence, package-format,
managed-block or `BOOTSTRAP.md` change; no migration. A server configured with
`--root` behaves as before. If a host offers several workspace roots that each
contain Agent Profiles configuration, pass `root` in the call or start the server
with `--root`. To make the bound digest readable by `verify`, record it with
`agent-profiles stamp` using the same selectors.

## Source feature: 0.6.0 — MCP handoff in the managed block

The working package version is `0.6.0`, not yet published to npm. `init --mcp`
writes a managed-block variant that tells agents to call a connected
`agent-profiles` MCP server's `resolve` tool, keeping the shell command as the
fallback, and prints the host's server setup. `doctor` reports which blocks have
the handoff and whether the project's host file names the server. See the
[MCP service](https://github.com/guisam/Agent-Profiles/wiki/MCP-service). Tracking: #38 and #39.

### Upgrade instructions

No configuration YAML, managed-lock, stamp, evidence, package-format or
`BOOTSTRAP.md` change; the block protocol stays 2. Existing shell-only blocks stay
current, so nothing has to be re-run after upgrading. To opt in, run
`agent-profiles init --agent <id> --mcp` and add the server with the snippet it
prints; `init --agent <id> --no-mcp` reverts. Plain `init` keeps each block's
variant. Keep the Claude Code shell permission rules: the fallback uses them.

## Source feature: 0.5.0 — MCP service

The working package version is `0.5.0`, not yet published to npm. It adds
`agent-profiles mcp`, an optional stdio [MCP service](https://github.com/guisam/Agent-Profiles/wiki/MCP-service)
with five read-only tools (`resolve`, `explain`, `verify`, `diff`, `report`) that
match their CLI equivalents. Started with `--model` or `--role`, the server's
instructions carry that session's resolved profile. Tracking: #38 and #39.

### Upgrade instructions

No configuration YAML, managed-lock, stamp, evidence or package-format change is
introduced; no migration is required. Existing bootstrap integrations keep working.
To try the service, rebuild from source (`npm ci`, `npm pack`) and deliberately
install `guisam-agent-profiles-0.5.0.tgz`, then add the server to your host's MCP
configuration as shown in [docs/mcp.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/mcp.md).
The installer never writes host MCP configuration.

New runtime dependencies, loaded only by the `mcp` command: `@modelcontextprotocol/server`
2.4.0 and `zod` 4.6.7. Live behavior in Claude Code, Codex and OpenCode is not yet
verified; automated protocol, parity and no-write tests pass.

## Beta releases

The maintainer has not yet selected the beta numbering convention. No beta version is assigned by this policy. The application manifest is `0.13.0` (source; the latest npm release is `0.4.1`); package publication does not introduce a configuration migration.

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).

## 0.19.6: Superpowers volunteer example

Documentation/example patch only. No YAML, lock, store or bootstrap migration.
Existing users need no configuration change. The experimental example is in the
Git repository under examples/superpowers; it is not an installable Markdown preset.
Use a disposable consumer and preserve the complete upstream resource tree.
