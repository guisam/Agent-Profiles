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
runtime state. If rebuilding, deliberately choose `agent-profiles-0.4.0.tgz` and
verify its metadata; the source-only archive helper requires this trusted checkout.

## Source patch: 0.4.1 — npm publication preparation

The `0.4.1` release preparation adds an ordered npm publication
checklist and a manually triggered GitHub Actions OIDC workflow. It also corrects
the root lockfile's executable path to `dist/bin/agent-profiles.js`. Publication
defaults to off and the workflow creates neither tags nor GitHub releases.

No configuration YAML, managed lock, stamp, package or evaluation schema changes
are introduced. Keep existing configuration, pins and evidence. If rebuilding
from source, use Node 24 and explicitly select `agent-profiles-0.4.1.tgz`; updating
the checkout does not upgrade an installed copy. No migration is required.

The maintainer chose personal ownership and GitHub Actions trusted publishing
for `guisam/Agent-Profiles` using the personal npm account `guisam`. The maintainer
confirmed verified email, 2FA and saved recovery codes. GitHub environment `npm`
has been created with deployment restricted to the `main` branch. npm requires an
existing package before trust can be configured. The maintainer authorized direct
first publication after CI passes. After the workflow is committed to `main`,
configure npm trust for `publish.yml` and environment `npm`, then run a rehearsal
with publication off. Configure
trust near release time because unused new configurations expire after two days.

See the [repository release checklist](https://github.com/guisam/Agent-Profiles/blob/main/docs/release.md)
for current gates and [PR #35](https://github.com/guisam/Agent-Profiles/pull/35)
for release preparation. A local rehearsal does not prove OIDC authentication.

## Beta releases

The maintainer has not yet selected the beta numbering convention. No beta version is assigned by this policy. The application manifest is `0.4.1`; package publication does not introduce a configuration migration.

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).
