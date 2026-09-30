# Changelog

## Unreleased — host integration protocol

- The managed bootstrap now asks the agent only to run
  `npx --no agent-profiles resolve --model "<exact model ID>"` and follow its output.
  Matching, validation, and file selection moved from the model into code after
  live Claude Code tests showed models misrouting when they matched IDs themselves.
  `init` replaces older managed blocks in place.
- Added `resolve` (agent-facing text, or `--json`); it replaces `scripts/resolve.js`
  and `npm run resolve` now calls it.
- Model `aliases` and owner-configured family `match.prefixes` (longest prefix wins),
  with collision validation and identity provenance (`identity`, `familySource`).
- Host-native Claude Code skills as `{host: claude, id?}` references that are
  invoked, never injected or counted, with `verified-local`/`host-provided` states.
  The wizard binds Claude skills by host identity instead of numbered aliases, and
  presets carry them under `skills.host`.
- A skill without frontmatter `name` uses its directory name; errors report
  repository-relative paths.
- `doctor` reports host skill verification and each integration's observed
  capabilities. `proof` and the visualizer list host skills separately and report
  the bootstrap block size on its own line.
- Documented guarantee levels (core, native, bootstrap expectation, host-dependent)
  and recorded live-host observations for Claude Haiku, Sonnet, and Opus.

## Unreleased — local visualizer

- Added `visualize`: a local, read-only context explorer with model/family/role
  selection, temporary skill requests, file provenance and loaded text inspection,
  and a pinned comparison. It reuses resolver diagnostics and explicit host/project
  accounting boundaries.
- Bundled a responsive browser UI and loopback-only server with private session
  URLs, fixed assets, and same-origin access checks. No new dependencies, remote
  services, telemetry, or configuration writes.
- Added HTTP/CLI and package checks plus a visualizer guide and README examples.

## Unreleased — context diagnostics

- Added `proof` with human-readable and JSON output, exact UTF-8 byte and Unicode
  code-point counts, loaded-entry classifications, category totals, and separate
  accounting for available context not loaded.
- Resolver output retains diagnostic fields with or without instruction contents.
  Repository/host context is explicitly outside managed instruction-body totals;
  token counts are marked not calculated. No additional runtime dependencies.
- Updated the README around installation, configuration, presets, and proof.

## Unreleased — presets

- Added local `preset inspect`, `preset import`, and `preset export` workflows
  with a versioned data-only manifest, role selection, bundled/local skills,
  explicit conflict choices, opt-in defaults, and editable provenance records.
- Added in-memory validation of proposed instruction files, source/target stale
  checks, and shared rollback for preset application.
- Added a small release-review preset and documentation. No remote sources,
  executable hooks, automatic updates, or conditional role/profile routing.

## 0.1.0 — Unreleased

- Deterministic exact-model, family, and fallback profile resolution, independent
  of role selection; local YAML configuration with validated references.
- Required skill loading and available skill metadata with on-demand loading,
  including explicit repository-local source mappings.
- Claude Code and Codex bootstrap integrations with preserved instruction files,
  idempotent initialization, validation, and managed-block removal.
- Interactive role creation, editing, and deletion with paginated, filterable
  skill selection, explicit duplicate-source aliases, and preview before save.
- Minimal profiles, roles, skills, portable bootstrap, and contributor guides.
- Guarded file writes with stale-edit detection and rollback on reported failures.
- Package-artifact workflow checks and CI for Windows, macOS, and Linux on
  Node.js 22 and 24; development type and lint checks without a build step.

No remote instruction fetching, telemetry, model execution, or orchestration.
