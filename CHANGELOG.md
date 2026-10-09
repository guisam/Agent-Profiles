# Changelog

## Unreleased — portable instruction mapping fix

- Guard legacy native-skill diagnostics when a host has no project-native skill
  interface, so explicit portable skill file mappings no longer break `doctor`
  or roll back initialization.
- Retain Claude-native migration warnings and cover read-only diagnostics,
  three-host installation, role composition, idempotence and packed workflows.

## Unreleased — agent-assisted setup (#17)

- Add read-only `inspect`/`inspect --json` before and after initialization, with
  bounded repository metadata, existing skill discovery and opt-in external roots.
- Separate shared configuration, machine environment, adapter configuration,
  filesystem executable detection and unverified current host invocation.
- Add a portable README prompt and approval-first setup guide reusing existing
  installer, role APIs, resolver, doctor/proof and presets; no embedded LLM or runtime.
- Cover unchanged pre-approval bytes, native references, unknown/failed metadata,
  environment limits and three packed-package inspection workflows.

## Unreleased — external native skill inventory (#15)

- Add opt-in metadata-only `skills --external`, `configure --external`, and
  `doctor --external`, plus `--sources` for machine-local approved roots.
- Discover personal Claude and Codex skills and explicitly namespaced Claude
  plugin roots; preserve portable host/scope/native-ID references and preset round-trips.
- Add Codex user-native references without injecting or measuring skill bodies.
- Show origin/status, retain opaque or missing assignments, and block known
  shadowed/non-addressable origins. Revalidate disk selections before preview/save.
- Keep repository containment rules and host settings unchanged. Metadata is not
  proof of host enablement or live invocation.


## Unreleased — Hermes bootstrap adapter

- Added `hermes` to installer/CLI host choices and deterministic resolver composition.
- Install into root `.hermes.md` or existing `HERMES.md`, respecting filename priority;
  detect shadowed blocks and preserve existing bytes through reruns and uninstall.
- Keep Agent Profiles model instruction profiles distinct from Hermes runtime profiles.
  No Hermes personality, runtime configuration, memory, credentials, sessions, or skill
  visibility is changed; portable instruction skills use the existing resolver.
- Add explicit shared-rule loading guidance because Hermes-specific context files take
  precedence. Native Hermes skill bindings and lifecycle enforcement are not included.
- Cover Hermes host/CLI composition, portable skills and cross-host limits, three-host
  coexistence, and the real packed artifact. Add a Hermes setup/sharing/limits guide.

## Unreleased ? Protocol 2 review fixes

- Preserve independent pathless host skills through selection and role editing; export them only as references.
- Verify the selected npm executable and its owning package across ancestor lookup; discover initialized non-Git roots.
- Keep repository reminders in host adapters, preserving Codex overrides. Render Bash/PowerShell rerun arguments literally and retain supplied families.
- Keep inferred visualizer families separate from explicit overrides. Record permission-rule ownership and retain pre-existing rules on uninstall.
- Qualify host compatibility and local-file verification: actual native skill invocation remains the host adapter's responsibility.

## Unreleased — host integration protocol

- The managed bootstrap (protocol 2) asks the agent only to run
  `npx --no agent-profiles resolve --host <host> --identity-source host-stated --model "<exact model ID>"`
  and follow its output. Matching, validation, and file selection moved from the model
  into code after live Claude Code tests showed models misrouting when they matched IDs
  themselves. Blocks are versioned; `doctor` reports stale ones and `init` refreshes
  every installed surface.
- Resolutions take a consuming `host`: another host's skills are not exposed, and its
  required skills are reported as `unsatisfied`.
- `init` writes the Claude Code permission rules, installs the package with
  `--package`, and exits nonzero while the bootstrap cannot run. `doctor` reports
  configuration, bootstrap availability, and host capability separately.
- Added `resolve` (agent-facing text, or `--json`); it replaces `scripts/resolve.js`
  and `npm run resolve` now calls it.
- Model `aliases` and owner-configured family `match.prefixes` (longest prefix wins),
  with collision validation and identity provenance (`identity`, `familySource`).
- Host-native Claude Code skills as `{host: claude, scope: project|user|plugin, id?}`
  references that are invoked, never injected or counted. Project skills must exist;
  user and plugin skills are `host-provided`.
  The wizard binds Claude skills by host identity instead of numbered aliases, and
  presets carry them under `skills.host`, along with model aliases and family prefixes.
- A skill without frontmatter `name` uses its directory name; errors report
  repository-relative paths.
- `doctor` reports host skill verification and each integration's observed
  capabilities. `proof` and the visualizer list host skills separately; `proof --host`
  reports the installed bootstrap block size, as stored on disk.
- Documented guarantee levels (core, native, bootstrap expectation, host-dependent)
  and recorded live-host observations for Claude Haiku, Sonnet, and Opus, summarized
  in `docs/hosts/claude-code.md`.

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
