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

## Live-host checks

For **both Claude Code and Codex**, record host version, OS, result, and any
host instruction exclusions or size limits. Use a disposable repository and
review generated files before starting a fresh host session.

- [ ] Initialize with the selected integration; check its reported target file.
- [ ] Ask the host to report its profile, selected role, loaded instruction paths,
      and available skill metadata. Supply `example-model` and role `reviewer`
      explicitly for the fixture; expect `autonomous`, `reviewer`, required
      `code-review`, and available `testing` without its body.
- [ ] Repeat with unknown model identity; expect `constrained`. Supply
      `example-family` instead to verify family fallback to `scaffolded`.
- [ ] Request `testing` for a relevant task and verify its instructions load.
- [ ] Run the interactive role wizard in a real terminal, then restart the host
      with the new role. Verify existing repository rules still apply.
- [ ] Uninstall; check that original instruction bytes and user configuration
      remain. Restart the host to verify the managed bootstrap is gone.

These adapters supply instructions, not a programmatic host context filter.
Global instructions and built-in host skills may still load independently.
Doctor validates local files and references; it cannot observe a host's session.

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
