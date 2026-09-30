# Contributing

Use Node.js 22 or newer and npm. From a checkout:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:package
```

`typecheck` uses TypeScript's `checkJs` on runtime JavaScript and scripts,
without a build step. `lint` uses that same compiler for unused bindings,
unreachable code, unused labels, and switch fallthrough. TypeScript and Node
type declarations are development-only dependencies. Runtime needs only `yaml`
for parsing, validation, and comment-preserving edits.

`test:package` packs the actual npm artifact, checks its contents, installs it in
an isolated temporary project, invokes the npm executable, and exercises the
installer, wizard, resolver, doctor, and uninstall. It may need registry access
for `yaml`; it never publishes. Temporary repositories are removed afterward.
The CI matrix runs these checks on Windows, macOS, and Linux with Node 22 and 24.

## Where things live

- `src/resolve.js`: YAML validation and deterministic instruction composition.
- `src/diagnostics.js`: exact resolved-text accounting, streaming available-skill
  measurement, and proof/JSON presentation with explicit host boundaries.
- `src/visualize.js`, `src/visualizer/`: loopback-only HTTP adapter and static
  browser UI consuming resolver diagnostics; no build step or UI dependencies.
- `src/integrations.js`: agent instruction targets and managed bootstrap text.
- `src/install.js`, `src/files.js`: installer lifecycle and guarded file writes.
- `src/configure.js`, `src/skills.js`, `src/wizard.js`: validated role edits, local
  skill discovery, and terminal prompts.
- `src/presets.js`, `src/preset-wizard.js`: local preset inspection, import/export
  plans, and prompts reusing the existing selector and role wizard.
- `bin/agent-profiles.js`: public CLI, including the agent-facing `resolve` command.
- `.agent-profiles/`: complete, minimal example shipped with the package.
- `examples/presets/`: small, inspectable preset examples; see [the format](docs/presets.md).
- `test/`: Node's built-in test runner; `docs/`: contracts and user guides.

Start with the [architecture](docs/architecture.md). For a new agent integration,
add a small adapter in `src/integrations.js` following the
[adapter contract](docs/installer.md#integration-contract). Verify its instruction
discovery against official host documentation and add tests for fresh and existing
files, precedence, reruns, and exact uninstall preservation. Keep file mutation
in the shared lifecycle; routing should not change to support another host.

Example profiles belong in `.agent-profiles/profiles/`; roles belong in `roles/`.
Keep them short and illustrative. Use fictional model identities in `agents.yaml`,
not capability claims about real models. Validate reference changes with tests
and the resolver examples in [bootstrap.md](docs/bootstrap.md).

Keep changes small. Prefer the standard library and existing helpers; justify
each new runtime dependency. Cover changed behavior with a focused regression
test and update docs and the changelog when configuration, routing, or integration
behavior changes. Do not commit local caches, agent settings, or generated
packages. Review instruction-file changes as carefully as source changes.
