# Contributing

Use Node.js 24 or newer and npm. From a checkout:

```sh
npm ci
npm run typecheck
npm run lint
npm run check
npm test
npm run test:package
```

Sources are moving from JavaScript to TypeScript one file at a time. Node 24
runs both directly, so development and tests need no build step. `typecheck`
runs two passes: `tsconfig.json` checks every file, including unused bindings,
unreachable code, unused labels, and switch fallthrough; `tsconfig.strict.json`
holds converted `.ts` files to full `strict`. Import converted modules with
their `.ts` extension. `lint` runs [Biome](https://biomejs.dev)'s
recommended rules over sources and tests; `check` also formats and sorts
imports in place. CI runs `biome ci`, which fails on lint errors or unformatted
files. TypeScript, Biome, and Node type declarations are development-only
dependencies. Runtime needs only `yaml` for parsing, validation, and
comment-preserving edits.

Node will not strip types inside `node_modules`, so the published package ships
`dist/`: `npm run build` (also run by `prepack`) emits it with `tsc`.

`npm run test:affected` runs only the test files your uncommitted changes can
reach (`-- <base>` or `-- a..b` for commits, `--list` to preview). It follows
imports, treats tests that spawn the CLI as importing everything the CLI does,
and falls back to the full suite for any change it cannot map. CI still runs
`npm test`.

`test:package` builds `dist/`, packs the actual npm artifact, checks its contents, installs it in
an isolated temporary project, invokes the npm executable, and exercises the
installer, wizard, resolver, doctor, and uninstall. It may need registry access
for `yaml`; it never publishes. Temporary repositories are removed afterward.
The CI matrix runs these checks on Windows, macOS, and Linux with Node 24.

## Where things live

- `src/resolve.ts`: YAML validation and deterministic instruction composition.
- `src/diagnostics.js`: exact resolved-text accounting, streaming available-skill
  measurement, and proof/JSON presentation with explicit host boundaries.
- `src/inspect.js`: read-only setup inventory; keep repository metadata bounded,
  machine facts separate, and skill scanning in the existing discovery adapters.
- `src/visualize.ts`, `src/visualizer/`: loopback-only HTTP adapter and static
  browser UI consuming resolver diagnostics; no build step or UI dependencies.
- `src/integrations.js`: agent instruction targets and managed bootstrap text.
- `src/install.js`, `src/files.ts`: installer lifecycle and guarded file writes.
- `src/configure.ts`, `src/skills.js`, `src/wizard.ts`: validated role edits, local
  skill discovery, and terminal prompts.
- `src/presets.ts`, `src/preset-wizard.ts`: local preset inspection, import/export
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
