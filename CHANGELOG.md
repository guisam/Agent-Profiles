# Changelog

## Unreleased

### Saved profile evidence and distinct skill examples (source version 0.4.0)

- Add two inspectable model/role preset examples with distinct required skill
  assignments and a routing regression test. Add an offline per-rollout YAML
  archive tool with referenced instruction copies, skill/version/hash manifests
  and safe restoration notes. Backfill 25 historical task runs and retain two
  explicitly configuration-only examples; no historical skill set is rewritten.
  Optimization experiments are stopped. The examples demonstrate persistence and
  selection, not model-quality parity or production qualification. No schema or
  live-project migration is introduced.

### Luna/Sol diagnostic (source version 0.3.1)

- Record twelve completed documentation trials and six blind rubric grading
  sessions using the existing Codex subscription. The verification candidate
  did not demonstrate improved Luna performance. Preserve rubric conflicts,
  CSV-format defects, timing/usage observations and native evidence without
  equating no-regression eligibility with qualification or adopting the skill.
  This documentation patch introduces no application or schema changes.

### Guided agent qualification (source version 0.3.0)

- Add one assistant-assisted qualification entry point with a small requirements
  intake, a readable retained report template and a worked live-pilot example.
  Separate native no-regression eligibility from absolute service quality,
  repeated held-out coverage, turnaround and measured cost. Missing evidence
  stays unknown; adoption and routing remain explicit decisions. This workflow
  uses the existing native plans/results and promotion tools without new schemas,
  a model runner, automatic certification or production routing implementation.

### Twenty-minute Strata follow-up (source version 0.2.2)

- Record the user-authorized, fresh candidate-only trial with a 1,200-second
  limit. The same candidate completed four documents in about 691 seconds and
  passed integrity checks. Offline example checks found correct boundary
  chunking/retry behavior and a separate sync helper that rejects valid 202
  responses. Confirmed authentication facts were also mislabeled unknown. Keep
  the candidate unadopted and the old ten-minute failure unchanged. The normal
  pilot default, installed skills, application behavior and schemas are unchanged.

### Strata verification-skill experiment (source version 0.2.1)

- Record an isolated native skill candidate and matched Strata control on the
  JobBench writing task. Required-skill selection changes generated context, so
  both new arms use that loading mode. The control completed four documents;
  the candidate timed out after 600 seconds with two partial documents and
  retained unsupported examples. Keep it unadopted; no improvement or held-out
  qualification is claimed. No application behavior or configuration schema
  changes are introduced by this experiment-recording patch.

### Guided evaluation workflow (#33; source version 0.2.0)

- Add a bounded Windows JobBench pilot launcher using the public Harness² Codex
  substrate and stamped seeds, with two-model file-access preflight, pinned task
  inputs, retained logs, unchanged-input checks and explicit ungraded status.
  Preserve normal executor policies and distinguish the custom Windows deployment
  from the stock Linux runner. Carry forward the user's configured native Windows
  sandbox while excluding unrelated user settings; refuse missing selections.

- Add one assistant-assisted entry point for selecting a role/model/host, checking
  compatibility, keeping tuning and held-out cases separate, reviewing one skill
  candidate, comparing fixed arms, explicitly adopting or rejecting it, and
  rehearsing guarded restoration before repeating for a second model.
- Keep internal artifact generation with the coding assistant and execution with
  the external Harness² driver. Record unavailable metrics, driver/budget gaps,
  and live qualification separately; no model runner in core resolution, schema
  change, or new Agent Profiles CLI command.
- Bump application metadata from 0.1.0 to 0.2.0. Existing configuration, lock,
  package and evidence formats are unchanged. The package remains unpublished.

### OpenCode host integration (#30)

- Verify a live four-rollout OpenCode/Harness² paired workflow through measured
  answers, cache reuse, changed-input refusal, retained results, preview and
  explicit promotion. Keep the opt-in test and its measured evidence separate
  from credential-free fixtures and broad benchmark quality claims.
- Register the distinct OpenCode host with independent managed `AGENTS.md`
  ownership alongside Codex, safe repeated setup/uninstall, inspection/proof,
  explicit provider/model and role routing, and native skill metadata support.
  Keep user JSON/JSONC and permissions unchanged and require new-session semantics
  for clean model/agent/role changes.
- Retain real OpenCode assignments through stamps, skill migrations, candidates,
  paired Harness² plans/results and explicit preview/promotion. Preserve historic
  null-host evidence and reject mismatched host/surface/substrate identities.
  Extend native seeding/batch and converter regressions to both hosts.

- Add an opt-in native smoke check for installed OpenCode v2.1.3, verifying
  project instruction consumption and native skill invocation with the current
  default model. Record live observations separately from the v1 source research.
- Record the native host contract investigation and implementation plan in
  `docs/development/issue-30-opencode-contract.md` and `issue-30-plan.md`, including
  shared instruction ownership, identity, skill discovery and evidence checks.
  Keep the earlier v1 research as historical; v2.1.3 is the native validation target.

### Harness² integration (#28)

- Add verified `harness2-tree` materialization for Codex and OpenCode surfaces,
  deterministic adoption capture, seeded benchmark adapters, and proposal and
  paired-evaluation converters under `integrations/harness2/`. Keep model execution
  external, executable package content inert, and promotion explicit.
- Pass materialized seeds into real native execution and batching paths, record
  content fingerprints, and reserve run input identities before launch to prevent
  changed-seed reuse from overwriting attributed output. Cover WorkBuddy, LAB and
  JobBench launch paths on both surfaces, native cache reuse, failures, partial
  batches, and native rollout evidence through the migration CLI.
- Add an opt-in compatibility workflow against pinned upstream source using
  Node 24. Live Codex execution and judge quality remain untested; OpenCode is a
  surface layout without a migration/evaluation host integration. Candidates
  remain limited to skill entrypoints. Earlier literal-base sidecars require
  fresh evidence under new run IDs.

### Migration workspace groundwork (#21)

- Start migration workspaces directly on a current config3 project and lock2. The
  authoring base is an ordinary active stamp2; selected roots are taken by kind and
  binding, so dependency-first context and workflow companions are handled. Overlay,
  status, proposals and candidate history use that base; nothing is converted or
  rebased automatically. An open migration on the same primary tuple refuses before
  sharing discovery, and every considered sharing tuple must still resolve. The
  installed candidate scenario now starts natively instead of via a config2 detour.
  This supersedes the config1/2-only start and separate config3 evaluation
  preparation described in the bullets below. Actual forks/shared activation,
  iteration/closeout, session continuity and broader issue #21 completion remain pending.

- Add bounded single-tuple promotion: `migrate preview` (read-only) and `migrate
  promote` with a strict immutable decision bound to one retained task-only candidate,
  its paired plan/results and only the evaluated primary role/model/host. Any per-case
  correctness drop refuses unless an exact recorded correctness-only override names the
  regressed cases; integrity/coverage/freshness/workflow/config3 failures stay
  non-overridable and historical reports keep the regression. A typed revision-v2
  release wrapper labels the identical evaluated bytes (no rebuild, no legacy mapping,
  embedded manifest unchanged). Public admission requires both the committed decision
  index and the write-once label, so orphans stay unselectable. Apply repins only the
  evaluated tuple, adding one most-specific rule only when needed. It preserves YAML
  comments and concurrent edits, refreshes lock2 and captures a fresh active stamp.
  Post-decision-commit failures are reported as partial; same-decision replay completes.
  There is no rollback or crash guarantee. Extend the installed scenario through
  preview, blocked refusal, promotion, resolve/lock/stamp and rootless readback. This
  supersedes the earlier promotion deferrals in the bullets below only for this one-tuple
  slice; multi-tuple/collateral promotion, forks, workflow-change candidates,
  lifecycle/session/live work and issue #21 completion remain pending. Coordinator
  execution and fresh independent review remain required; the package is unpublished.

- Add bounded offline paired external evidence: strict plan/result v1 import,
  immutable canonical objects/id indexes and rootless historical report for one
  retained managed candidate context. Reverify exact base/candidate/peer backing,
  complete paired coverage/conditions and safe decimal metrics before commit/reuse.
  Report per-case correctness regressions and complete/partial comparable efficiency;
  no aggregate cancellation, efficiency veto, provider execution or promotion write.
  Add explicit evaluation-only numeric codecs while preserving integer-only defaults
  and old metadata/tree hashes. Extend the installed candidate scenario through
  decimal plan/results/reuse and report after project deletion without activation.
  Imported outcomes remain external claims; runtime unverified, promotion unauthorized.
  Earlier external-result deferrals are superseded only for this offline slice.
  Coordinator execution and fresh whole-evidence review remain required; broader
  forks/session/live lifecycle, promotion and issue #21 completion remain pending.
  The package is unpublished.
- Add the bounded advisory task-only candidate slice: explicit publication/readback
  and installed CLI smoke, literal accepted-history replay, guarded atomic final
  index, reserved external label, raw immutable object retention and typed
  revision-v2/candidate stamp2 without activation. Keep embedded manifest bytes,
  complete-tree hashes, old release pins and active stamp formats unchanged.
  Explicit config3 evaluation preparation is separate from config1/2 workspace start.
  Historical candidate reconstruction retains workflow/dependency/base evidence;
  caught pre-commit failures may leave valid backing and preserve concurrent edits.
  No general crash guarantee. Coordinator execution and independent candidate review
  remain required. Earlier groundwork bullets describe their historical slice limits;
  this new slice supersedes their candidate-publication deferral only. Broader
  candidates/forks, provider execution, scoped promotion, attribution/live
  activation and completion of issue #21 remain pending; npm remains unpublished.

- Add the config3/stamp2 snapshot slice: exact raw task/companion/resource bytes,
  nullable/adopted package pins, canonical revision backing, primary logical uses,
  required-only actor roots/closures and actual peer-selection relations. Historical
  reconstruction needs no mutable project or current label index; corruption and
  inconsistent selected-peer evidence refuse. Export exact metadata bytes and
  deduplicated package trees through the existing filesystem adapter/receipts.
  Preserve config1/2 stamp1 behavior and hashes. Extend the installed workflow
  scenario through stamp2/verify/export; coordinator qualification remains required.
  Native invocation/rendering/model compliance and remaining #21 lifecycle work
  remain outside this additional foundation slice.

- Add the config3/lock2 foundation slice: complete per-assignment package/revision
  replacements, retained verified dependency closure, separate task/workflow context,
  explicit peer protocol-major checks, real proof accounting and caller safeguards.
  Preserve v1/v2 selections and bytes; package releases remain independently pinned.
  Add the adjacent v2→v3 guide/prompt and installed resolve/proof scenario. Config3
  snapshot2/materialization is supplied by the additional slice above; remaining
  issue21 lifecycle work is still pending.
- Add `revision record` and synchronous immutable legacy-release metadata adoption:
  verify existing identity/tree and exact dependency closure, retain explicit
  workflow declarations/provenance, and verify identical replay without writes.
  Labels cannot be repointed; legacy selection and complete-tree hashes stay intact.
  Packed checks cover installed runtime/docs and unchanged legacy context. Workflow
  loading/readiness and config3/lock2 are supplied by the additional foundation
  slices above; remaining #21 lifecycle delivery is deferred.
- Add an additional proposal slice: `migrate propose/proposals/accept/reject`
  imports strict JSON v1 advisory data with retained-base evidence, lists it
  read-only and requires explicit acceptance or a retained rejection reason.
- Guard single existing UTF-8 instruction changes with verified retained backing,
  classification/path boundaries, exact before bytes and duplicate/history checks.
  Repo recommendations never apply; draft cases remain inert data. Caller-supplied
  session claims are not verified host attribution. Active inputs/store stay intact;
  caught acceptance failures use guarded compensation without atomic crash guarantees.
- Extend the installed-artifact smoke scenario for proposal outcomes and retention.
  Actual forks/lineage, candidate/release labels, external evaluation, promotion,
  attribution and explain remain pending; this additional slice does not complete #21.
- Add `migrate start/status/abandon` for one explicit role/model/host assignment,
  canonical ownership, shared-use reports, explicit fork/shared intent and retained
  primary/collateral base stamps.
- Copy editable portable instructions/resources and complete selected packages into
  a separate workspace; report changed membership/bytes and preserve originals,
  active assignments and dependency locks. Abandon retains records and edits.
- Reuse existing store/stamp formats without new runtime dependencies. Candidate
  publishing, actual forks, evaluation, promotion, attribution and explain remain
  pending; this is not completion of issue #21.

## Unreleased — versioned local packages (#20)

- Add strict full-tree local packages, immutable revision coexistence, v2 exact
  bindings/selector assignments and complete dependency locks with frozen/offline install.
- Capture raw managed bytes/provenance in immutable stamps; verify/reconstruct and
  structurally compare them; export into absent isolated filesystem destinations.
- Expose add/install/stamp/verify/diff/materialize, explicit store propagation and
  package-aware caller safeguards. Native invocation/runtime identity remain unverified.
- Document the runnable fictional workflow and adjacent v1 → v2 scalar-only migration
  with a companion approval-first prompt. Retain v1 source validation; dependency
  installation requires v2. Package 0.1.0 remains unpublished; artifact/platform and
  final whole-solution review gates remain pending.

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
