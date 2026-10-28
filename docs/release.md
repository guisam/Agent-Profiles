# v0.4.1 release checklist

This checklist targets the first npm release, `@guisam/agent-profiles@0.4.1`. Publication and live-host
verification are explicit release steps; a passing local test does not publish
anything or prove a model followed the bootstrap.

## npm publication readiness (2026-10-28)

Work through these steps in order. Checked items record inspected configuration
or completed checks, not publication approval. Leave platform and live-host gates
below open until their evidence is reviewed.

1. [x] Inspect package metadata: Apache-2.0 license, repository links, Node 24
   requirement, compiled CLI entry, file allowlist, and prepack build are present.
2. [x] Synchronize the manifest and lockfile at `0.4.1`, including the CLI path
   `dist/bin/agent-profiles.js`. This is a source preparation patch, not a release.
3. [x] Check registry naming: the unscoped name returned E404, but npm rejected
   publication as too similar to `agentprofiles`. The maintainer chose the
   personal scope `@guisam/agent-profiles`; its registry lookup returned E404 on
   2026-10-28. A missing public package does not establish publishing rights.
4. [x] Confirm the personal npm account `guisam`. The maintainer confirmed email
   verification, enabled 2FA, and saved recovery codes. Package ownership is still
   pending the bootstrap step below. Metadata, bootstrap package verification,
   fixtures, tarball paths, and install documentation use the chosen scoped name.
5. [x] Choose GitHub Actions trusted publishing for the personally maintained
   `guisam/Agent-Profiles` repository. Prepare `.github/workflows/publish.yml`:
   manual dispatch on `main`, version/lock checks, tests, artifact rehearsal,
   Node 24, and OIDC. Publication defaults to off. Ordinary CI stays credential-free.
   GitHub environment `npm` now exists with deployments restricted to the `main`
   branch. The initial workflow was merged in PR #35; the scoped-name update must
   also pass CI and merge before publication and a fresh remote rehearsal.
6. [x] Run local type checking and `npx --no-install biome ci` (Windows, Node
   24.20.0, npm 11.19.0). These passed on 2026-10-28.
   An isolated manifest/lockfile-only `npm ci --ignore-scripts` also passed;
   this checks dependency installation, not a clean full-checkout CI run.
7. [x] Run the complete test suite and packed-package smoke; inspect the final
   tarball inventory, especially bundled `.agent-profiles/`, docs, and presets.
   The full run reported 2,081 passes, one skip, and one version-mismatch failure
   caused by editing the manifest during the run. With the version stable, all
   48 protocol/workflow tests passed. Packed-package smoke passed on Windows.
   The dry-run inventory has 94 files (~360 KB compressed); the bundled scaffold
   contains profiles, roles, and two example skills. No test/source trees, caches,
   npm configuration, or credential-named files appeared in the reviewed listing.
8. [ ] Review passing CI for the exact release commit on Windows, macOS, and
   Linux; resolve or explicitly document the delivery and live-host gates below.
   The unscoped preparation passed [CI](https://github.com/guisam/Agent-Profiles/actions/runs/40767942616).
   The scoped-name changes need their own complete passing CI matrix.
9. [x] Update the GitHub wiki's Versioning and upgrades page with this patch's
   changes and upgrade guidance; keep its source mirror under `docs/wiki/`.
10. [x] Obtain explicit authorization: the maintainer chose direct publication of
    the first release after CI passes. Publish the reviewed artifact only after
    that condition is met, then verify the installed registry copy. Git tags and
    GitHub releases remain separate decisions.

Public package versions cannot be overwritten; fixes need a new version. Beta
numbering remains a maintainer decision.

### Set up trusted publishing

The npm account is separate from GitHub's `guisam` account. Confirm its username
and enable 2FA before proceeding. An organization is not required.

1. Merge the reviewed workflow into `main` and create a GitHub environment named
   `npm`, restricted to `main`. No npm publishing token secret is needed.
2. Establish ownership of `@guisam/agent-profiles` on npm. npm requires the package to
   exist before configuring trust. A one-time authenticated first publication
   is one option; staged publication is another, but creates a publicly visible
   placeholder for a new package. Both require separate explicit authorization.
   Do not publish a dummy release or invent beta numbering to bootstrap trust.
3. In npm package settings, add a GitHub Actions trusted publisher with owner
   `guisam`, repository `Agent-Profiles`, workflow filename `publish.yml`, and
   environment `npm`. Enable direct `npm publish` permission for this workflow.
   Configure this only when ready: unused new configurations expire after two days.
4. Run **Publish to npm** on `main` with the exact manifest version and leave
   **publish** off. Inspect the check results and tarball listing. A dry run
   verifies packaging, not the OIDC publishing permission.
5. After release authorization and all gates pass, run the same reviewed commit
   with **publish** enabled. The workflow publishes the tarball it rehearsed;
   it does not create Git tags or GitHub releases. If bootstrapping already
   published that version, prepare and verify a new version before running it.

References: [npm publication and artifact contents](https://docs.npmjs.com/cli/v11/commands/npm-publish/),
[account publishing security](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
and [staged publication](https://docs.npmjs.com/staged-publishing/).

## Upgrading the source checkout from 0.1.0 to 0.4.1

The `0.4.1` patch adds release preparation and a manual OIDC publishing workflow,
and corrects the root lockfile's compiled CLI path. From `0.4.0`, rebuild and
explicitly select the new tarball; existing installations do not change by
updating the checkout. The assistant-assisted evaluation guide uses existing CLI and bridge APIs.

For an existing unscoped tarball installation, run `npm uninstall --save-dev
agent-profiles` in the consuming project, then install `@guisam/agent-profiles@0.4.1`
as a dev dependency. This replaces the npm executable shim with the scoped package's
copy. Keep `.agent-profiles/`, configuration, pins, stores, and retained evidence.
The terminal command remains `agent-profiles`; rerun doctor after installation.

No configuration YAML, managed lock, package, stamp, plan, result or promotion
format changes are introduced. Keep existing project configuration, package pins,
and retained experiment evidence; no schema migration is required for this update.

Update the source checkout deliberately and use Node 24. If using a packed
artifact, rebuild it and select the `guisam-agent-profiles-0.4.1.tgz` artifact explicitly;
changing this checkout does not update an installed copy. Follow the artifact
checks below before installing a new build.

Start the [guided workflow](guided-evaluation.md) with read-only inspection. Paid
search/evaluation, workspace proposal acceptance, promotion, and installation into
an active project remain separate explicit decisions. The guide does not certify
new model/host combinations or make prior results valid for changed conditions.

## Automated checks

- [ ] `npm ci --ignore-scripts` succeeds from a clean checkout.
- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass.
- [ ] `npm run test:package` passes on Windows, macOS, and Linux with Node 24.
- [ ] Review `npm pack --dry-run --json`: compiled executable, compiled modules, scaffold, docs,
      README, license, changelog, and metadata included; tests, caches, local
      agent settings, developer tooling, and generated artifacts excluded.
- [ ] README examples, CLI help, version/lockfile, Apache-2.0 license, repository
      URL, and changelog match the intended release.

The artifact check installs the tarball, invokes the npm-generated executable,
and tests empty repositories, existing repository instructions, alternate agent
files, and multiple agents. It verifies profile/family/fallback and role routing,
required versus available skill loading, wizard edits, preservation of customized
files on reinitialization, doctor, and uninstall. It uses a target path containing
spaces and fixtures with CRLF, BOMs, and missing final newlines. Unit tests cover
malformed configuration, linked paths, marker errors, failed writes, and rollback.
For releases including preset support, the packed workflow also inspects the
bundled example and exports/imports selected roles. Preset tests cover conflicts,
missing local skills, editable provenance, round trips, stale plans, and rollback.
Context-proof checks verify the packed CLI's human/JSON output and requested-skill
delta. The artifact check also runs the exact bootstrap command,
`npm exec --no -- agent-profiles resolve`, from the installed package offline. Accounting tests cover Unicode, line endings, previews, aliases, and the
host boundary; no tokenizer or live-host introspection is used.

## Versioned-package delivery gates (pending)

Configuration v2 and add/install/stamp/verify/diff/materialize are implemented in
this checkout. The [local tutorial](versioned-packages.md) and
[adjacent migration guide/prompt](migrations/README.md) describe source behavior;
Preserve the distinction between source checkout tests,
installed artifact behavior, platform qualification and live host observation.

- [ ] Qualify every complete tutorial YAML/required file with real validators;
      execute documented six commands plus resolve and frozen fresh-root steps in
      owned fixtures, preserving commands, exits, raw bytes and digest bindings.
- [ ] Verify package inclusion and the same new public commands through the final
      reviewed npm artifact under separately permitted installation conditions.
- [ ] Qualify full-tree hashing, cooperative publication/recovery and concurrent
      absent-destination exports on supported local Windows/macOS/Linux backends.
- [ ] Complete final whole-solution independent review, including documentation
      semantics; fixture rehearsals/wording tests do not prove AI approval compliance.

These tasks are not marked complete by an earlier installer artifact smoke or
listener-only visualizer check. No package-native invocation, complete host inventory,
runtime model attestation, universal filesystem semantics or power-loss guarantee
is supplied by ordinary source/offline tests.

## Live-host checks

Live checks record agent and host behavior (bootstrap expectations), never core
guarantees. Record results in [host-observations.md](host-observations.md) with the
host version, OS, model, and date, and update the per-host summary in
[hosts/claude-code.md](hosts/claude-code.md). Use a disposable repository with the packed
package installed as a dev dependency and the resolve command allowed (see
[bootstrap setup](bootstrap.md#host-setup)). Read tool calls from the host's
transcript or stream output rather than trusting the agent's self-report; live
tests found self-reports that omitted files the agent had read.

Run the protocol-sensitive rows with **Claude Haiku and Claude Opus**, and Sonnet
where available. One model does not represent all Claude behavior.

- [ ] Exact identity: the ID passed to `resolve` equals the host-stated exact model ID.
- [ ] Alias and family prefix: a dated or suffixed ID routes by alias or prefix.
- [ ] Unknown and missing identity: `constrained`; no identity from recollection.
- [ ] Required instruction skill: injected via `resolve` output.
- [ ] Required Claude-native skill: invoked through the host, not read as a file.
- [ ] Host-native skill without `name`: listed by the host and resolved by directory name.
- [ ] Available skill: listed; its body is not read for an unrelated task.
- [ ] Model switch: record whether the agent re-runs `resolve`, both when asked
      about its profile and on an unrelated task.
- [ ] Compaction: record re-resolution and which files the host re-attaches.
- [ ] Role assignment timing and transition: default role at start; a custom agent
      whose definition contains the `resolve --role` command.
- [ ] Subagents: built-in Explore and a custom agent; bootstrap visibility and identity.
- [ ] Claude Code and Codex installed together: one resolution per context.
- [ ] Permission rules written by `init`: in an untrusted workspace (expect approval
      prompts) and after accepting the trust dialog (expect none).
- [ ] Provider identity (Bedrock or Vertex) where access exists; otherwise mark unverified.
- [ ] Uninstall; original instruction bytes and configuration remain, and a new
      session no longer runs the bootstrap.

Repeat identity, routing, and uninstall checks for **Codex**; its identity exposure
is not yet observed. Claude Code 2.1.283 results from 2026-09-30 are recorded;
Codex, provider identities, interactive `/model`, automatic compaction, a trusted
workspace, and host skill invocation remain unverified.

## Publish (maintainer)

- [ ] Review the current CI matrix and store-cache-off job and live-host results; resolve failures before release.
- [ ] Confirm the intended npm account can publish `agent-profiles`. A registry
      lookup returned no public package on 2026-09-26; that does not reserve the
      name or establish account permissions. Recheck at release time.
- [ ] Change the changelog's Unreleased heading to the release date and update
      README publication status when publishing.
- [ ] Build and inspect the final tarball and publish that reviewed artifact.
- [ ] Tag the released commit `v0.4.1` and create release notes.
- [ ] Verify `npx @guisam/agent-profiles@0.4.1 init`, `configure`, `doctor`, and `uninstall`
      against the published package in a disposable repository.

No credentials or publishing automation are required for development or CI.
