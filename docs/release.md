# v0.1.0 release checklist

The repository is preparing `agent-profiles@0.1.0`. Publication and live-host
verification are explicit release steps; a passing local test does not publish
anything or prove a model followed the bootstrap.

## Automated checks

- [ ] `npm ci --ignore-scripts` succeeds from a clean checkout.
- [ ] `npm run typecheck`, `npm run lint`, and `npm test` pass.
- [ ] `npm run test:package` passes on Windows, macOS, and Linux with Node 22/24.
- [ ] Review `npm pack --dry-run --json`: executable, source, scaffold, docs,
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

## Live-host checks

Live checks record agent and host behavior (bootstrap expectations), never core
guarantees. Record results in [host-observations.md](host-observations.md) with the
host version, OS, model, and date. Use a disposable repository with the packed
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
- [ ] Provider identity (Bedrock or Vertex) where access exists; otherwise mark unverified.
- [ ] Uninstall; original instruction bytes and configuration remain, and a new
      session no longer runs the bootstrap.

Repeat identity, routing, and uninstall checks for **Codex**; its identity exposure
is not yet observed. Claude Code 2.1.283 results from 2026-09-30 are recorded;
Codex, provider identities, interactive `/model`, and automatic compaction remain
unverified.

## Publish (maintainer)

- [ ] Review the six CI jobs and live-host results; resolve failures before release.
- [ ] Confirm the intended npm account can publish `agent-profiles`. A registry
      lookup returned no public package on 2026-09-26; that does not reserve the
      name or establish account permissions. Recheck at release time.
- [ ] Change the changelog's Unreleased heading to the release date and update
      README publication status when publishing.
- [ ] Build and inspect the final tarball and publish that reviewed artifact.
- [ ] Tag the released commit `v0.1.0` and create release notes.
- [ ] Verify `npx agent-profiles@0.1.0 init`, `configure`, `doctor`, and `uninstall`
      against the published package in a disposable repository.

No credentials or publishing automation are required for development or CI.
