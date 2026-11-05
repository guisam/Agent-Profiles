# Versioning and upgrades

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
new version would inject. The MCP server is read-only by design. Tracking: #55.

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
