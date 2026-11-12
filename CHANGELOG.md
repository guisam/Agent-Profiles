# Changelog

## 0.28.0 — unreleased — edit the configuration from the visualizer (#119)

- `visualize --edit` lets the page add a skill to the selected role (required or
  available, chosen per click), remove role skills, and add models, families and
  roles. Without `--edit` the visualizer stays read-only.
- Each edit goes to the layer that owns it: the project `agents.yaml` or, for
  adapter roles and adapter skills, the adapter `agents.yaml`. Edits are validated
  alone and composed, keep YAML comments, refresh locks and roll back on failure.
- `POST api/edit` requires the session URL, same-origin `Origin`, a JSON body,
  `X-Agent-Profiles-Edit: 1` and the current configuration revision.
- Tooltips explain Host, Model, Family fallback and Role. The library table wraps
  to the panel width.
- Binding a new library package version and the replace prompt for skills with the
  same SKILL.md name come in a follow-up. No YAML, lock or bootstrap migration.

## 0.27.0 — unreleased — side-by-side skill comparison (#119)

- Skill library rows add **Set as left** and **Set as right** buttons that fill
  the comparison sides from the filtered table.
- **View → Side by side, full files** lists every file of both skills, unchanged
  files and lines included, aligned and numbered like a two-pane diff tool.
  Changed, removed and added lines are highlighted. Binary files are named only.
- `api/compare` adds an `aligned` field with side-by-side rows per file. Existing
  fields are unchanged. No YAML, lock or bootstrap migration.

## 0.26.0 — unreleased — skill library panel in the visualizer (#119)

- The visualizer page adds a **Skill library** panel that loads on request. It
  lists library and project-local skills with version, source, abbreviated digest,
  role usage and evidence status, with search and filters.
- **Compare skills** shows both sides (identity, full digest, usage, evidence and
  files) and every changed file: text as a unified diff, binary by name only.
- **Preview** switches the resolution view to a role that uses the skill, with the
  current configuration. No configuration, pin or skill file is changed.
- No YAML, lock or bootstrap migration. See `docs/visualize.md`.

## 0.25.0 — unreleased — skill catalog and comparison API (#119)

- The visualizer adds read-only `api/skills` and `api/compare` endpoints. The
  catalog lists library skill packages by version with identity, digest, project
  pins and the roles that require or offer them, plus project-local skills.
- Compare any two skills: two versions of one package, differently named packages
  or a project-local skill. Supporting and binary files are shown, not only
  `SKILL.md`. A missing version, digest or evaluation is reported as unknown or
  untested, never as a recommendation.
- The visualizer page itself is unchanged; the catalog and comparison UI follow.
  No YAML, lock or bootstrap migration. See `docs/visualize.md`.

## 0.24.1 � unreleased � refresh live files on demand

- Remove visualizer background polling. **Refresh files** rereads the composed
  project and adapter while retaining valid selections and surfacing errors.
- After fixing configuration, locks or approvals, click Refresh files again.
  Host selection and direct adapter support remain unchanged. No migration needed.

## 0.24.0 — unreleased — live project adapters in the visualizer

- Open adapter-backed projects directly with `visualize --root <project>`.
  Composed pickers include adapter roles and exact assignment model IDs without
  changing profile routing. `--host` and the host selector preview host predicates.
- Automatically reread live configuration, instructions, locks and approvals,
  debounce related writes, retain valid selections and report removed choices.
  Errors hide old results and recover after repair; Refresh files remains available.
- Show package revisions and trust-withheld errors. Keep the visualizer read-only,
  with existing loopback, same-origin and token protections.
- No YAML or bootstrap migration. Build/use the new checkout runtime or upgrade
  the installed runtime separately; preserve `AGENT_PROFILES_TRUST`. Running agents
  still need to resolve again. See `docs/visualize.md`.

## 0.23.10 — unreleased — reconcile the wiki source with the live wiki

- `docs/wiki/` now holds every live wiki page. Nine pages that existed only on
  the live wiki are copied in, including "Using Agent Profiles with T3 Code" and
  "PowerShell selector forwarding". The sidebar takes the live order.
- Edits made only on the live wiki are merged into the shared pages: the T3
  guide links, the companion-project follow-up and the PowerShell follow-up.
  "Resolved before any other tool" becomes "before role work (ToolSearch may
  precede resolution)", which matches the #82 and #83 transcripts.
- Content added only in the repository is kept: the 0.23.0 variant-package notes
  in Skill library and the tuning guide, and "bound selection and stamp" in MCP
  service, which matches `src/mcp.ts`.
- Fixes: links to deleted feature branches now point to `main`; the npm version
  in the T3 guide moves from 0.19.4 to 0.23.9; the 0.23.0 note no longer claims
  a 0.23.0 npm release.
- Not carried over: the live wiki's dated publication notes and its
  "unpublished working source" 0.19.6–0.19.11 compaction notes. The live wiki
  itself marks them as superseded by the merged 0.19.7 preset; they remain in
  the wiki history. No runtime or configuration change.

## 0.23.9 — 2026-11-11 — npm release of 0.22.1–0.23.8

- Publishes the unreleased 0.22.1–0.23.8 changes to npm. The last published
  version was 0.22.0. Each change keeps its own entry below.
- Changes that affect users of the package: `resolve` text names the package
  identity of each packaged skill (0.22.1), and `update` can move a tuple to a
  variant package (0.23.0). The other versions add documentation and tests.
- The README and `docs/setup.md` now use 0.23.9 in their examples instead of 0.19.4.
- No YAML, lock, store or bootstrap migration. The bootstrap stays at protocol 3.

## 0.23.8 — included in 0.23.9 — #83 repeated failure-case trials (#83)

- `docs/host-observations.md` records #83 item 5: five runs per cell on Claude
  Code 2.1.322 (headless) and T3 Code with Opus 5.5, 40 sessions, 40 pass. Two
  cells are deferred for host reasons. Headless cost was $1.86 at API rates.
- The headless permission cause is confirmed from Claude Code's stderr: it ignores
  a new folder's project allow rules until the folder is trusted.
- `docs/setup.md` and the wiki copy now point to the recorded results. The wiki
  copy gains the missing 0.23.6–0.23.8 entry. No runtime or configuration change.

## 0.23.7 — included in 0.23.9 — #83 pilot results and fixture order fix (#83)

- `docs/host-observations.md` records a one-run pilot of the five #83 failure
  cases on Claude Code 2.1.322 (headless) and T3 Code, Opus 5.5: 7 pass, 2 not
  exercised (`delayed` in headless CLI, `mcp-cut` in T3), none failed. Repeated
  trials (item 5) are not run.
- `test/fixtures/issue-83/prepare.mjs` no longer breaks the skill before `init`,
  which refused that configuration, and never runs `init` itself. A new
  `--finish <dir> --case <case>` step applies the fault after `init`.
- The shim's `--cut-output` flag is now `--run`: in the pilot an agent read the
  old name as the cause of the cut.
- The README lists the host limits the pilot found and a 40-session matrix with
  the infeasible cells deferred. No runtime or configuration change.

## 0.23.6 — included in 0.23.9 — failure-case fixtures for live #80 checks (#83)

- New `test/fixtures/issue-83/`: `prepare.mjs --case <tool-error|mcp-cut|shell-cut|delayed|cli-enoent>`
  builds a disposable project from the #80 fixture with one controlled fault, and
  `shim.mjs` cuts tool output in half or delays the MCP server without changing
  anything else. The README gives pass criteria and a 5-run trial matrix.
- `test/issue-83-fixture.test.js` checks each fault without a host. Nothing was run
  live; live runs wait for an approved budget. No runtime or configuration change.
- `test/fixtures/issue-82/prepare.mjs` exports its Git guard and command runner
  for reuse; behavior is unchanged.

## 0.23.5 — included in 0.23.9 — proposed TDD completion protocol (#33)

- Docs: `docs/examples/tdd-completion-protocol.md` proposes, without accepting
  or running it, an Opus 5.5 / Sonnet 5.5 implementer protocol for the
  remaining #33 criteria (1, 4, 7) as a revision of the planned Luna/Sol
  example. It records #33's state after the #109 fixture replay (criterion 9
  mechanics), frozen identities, independently authored held-out and
  regression cases, deterministic grading, how companion evidence maps to the
  native candidate/plan/results/promotion contracts (`apsp-results/1` is not
  native evidence), stop conditions, the novice adoption/rejection, model-switch
  and guarded-restoration demonstration, and an approval-ready budget.
- It separates meaning-preserving compaction from clarifying shared
  configuration and competing-instruction failures, lists the policy decisions
  needed first, and hands off proposed corrections for inconsistent companion
  status records. Neither candidate is adopted or held-out confirmed.
- Docs: `docs/guided-evaluation.md` links the proposal.
- No runtime, configuration, lock, store or bootstrap change. No model calls.

## 0.23.4 — included in 0.23.9 — guided journey replay test (#33)

- New `test/guided-replay.test.js` connects the guided evaluation steps in one
  test through existing interfaces: per-model selection, an unknown-host
  refusal, retained report readback, a refused decision for an unevaluated model,
  read-only preview, explicit fixture adoption, unchanged pins for the other
  models and unchanged unrelated instructions/settings, a guarded restore that
  refuses an intervening edit, then restoration to the baseline stamp with the
  promotion history retained. Evidence is labeled fixture-only. No source or
  configuration format changes.

## 0.23.3 — included in 0.23.9 — PowerShell selector forwarding (#106)

- Document a reproduced `npx.ps1`/wrapper argument-loss interaction before AP
  runs, its minimal probe, and tested `npx.cmd` forwarding.
- No runtime or YAML change. No lock, store, bootstrap migration or live pin change.

## 0.23.2 — included in 0.23.9 — mixed-model reviewer case study (#105)

- Document the bounded native CLI and T3 model-specific variant delivery results,
  including effort differences, cache contamination and fixture-only fallback.
- Track reported PowerShell selector loss separately in #106. No runtime,
  configuration, lock, store or bootstrap migration; no skill pins change.

## 0.23.1 — included in 0.23.9 — subagent delivery observations (#82)

- Docs: `docs/mcp.md`, `docs/host-observations.md` and the wiki record live
  subagent observations in headless Claude Code CLI 2.1.322 and in T3 Code with
  Opus 5.5. Custom agents, built-in `general-purpose` and T3 `delegate_task`
  children resolved their own role before work, with complete instructions. No
  child took the parent's role. Children whose `resolve` failed stopped role work.
  The built-in `Explore` agent receives no bootstrap; its delivery is not supported.
- Docs: bind a server shared with subagents to the host only. A role-bound server
  imposes its role on every caller.
- Test: `test/fixtures/issue-82/` adds a disposable fixture generator
  (`prepare.mjs`), a transcript summarizer (`trace.mjs`) and the live protocol.
  `test/issue-82-fixture.test.js` covers role separation, host-only binding, a
  skill removed after a healthy server start, and the summarizer.
- Interactive Claude Code CLI: the custom agent with an assigned role (C1)
  resolved `reviewer` first, with complete instructions, in one operator-run trial.
- Not covered yet: other interactive CLI rows, other models and repeated trials.
  #105 tracks them after #82 closed. No runtime change.

## 0.23.0 — included in 0.23.9 — update to a variant package (#89, #91)

- `update` and MCP `update_preview` accept a package-qualified target
  (`@namespace/name@version`). In configuration v3 it moves one exact
  role × model × host tuple to a differently named package, such as a
  model-specific variant. The tuple's rule binding (`package`, `version`,
  `revision`) is replaced in place when a rule pins exactly that tuple; otherwise
  one exact rule is added. A broader rule is never widened.
- The move has the same guards as a version move: a release label, the native
  package-type check, the other-tuple sweep, a content diff from the selected
  package to the target, evidence and approval for the target,
  `previewDigest`/`--expect`, live trust checks, and #97 layer ownership with
  #98 stamps. Apply never signs or approves.
- The preview names both identities. `--json` adds `before.package` and
  `after.package`; `package` is the target package. The `applyCommand` repeats
  the target as given.
- A bare version still means a version of the package the tuple selects now,
  which may already be a variant. Same-package previews keep their digests and
  text.
- Configuration v1/v2 refuse a target that names another package, with a pointer
  to the v2 → v3 conversion guide. `update` never converts the schema.
- Fix (#91): targets are parsed before any lookup. A malformed or unsupported
  target (a range, a tag, a missing version, a malformed name or a doubled
  identity) is reported as written, and no identity is synthesized from the
  binding's package and the target.
- Fix: an update that would stop any tuple from resolving (for example, a target
  of the wrong package type) is refused with the resolver's error, instead of
  "does not change the target selection".

## 0.22.1 — included in 0.23.9 — required skill package identity (#90)

- Text `resolve` now names the selected package, version and SHA-256 digest above
  each required or explicitly requested packaged skill body, in CLI and MCP
  output. Available skills already included this identity. Local skill bodies,
  JSON resolution and skill selection are unchanged; no store path is exposed.
- Package identity is visible to the receiving agent. Blinded evaluations must
  account for that rendering change; this fix adds no identity-hiding option.

## 0.22.0 — 2026-11-10 — stamps, verify/diff, evidence and inspect with a project adapter (#98)

- `stamp` works with a project adapter. A composed stamp adds a
  `configurationSources` field: the composed configuration digest (the
  `configSha256` that the adapter lock covers) and a blob of its record; each
  contributing input with its layer (project `agents.yaml`, local reference,
  adapter `agents.yaml`, role files and lock); adapter approvals for the captured
  packages; and the entries the adapter added. Committed-only stamps are
  byte-identical to 0.20.0 (golden test).
- No machine paths in stamps or evidence. File paths are relative to their layer.
  The local reference is recorded only as a reference digest. An optional `label`
  in `agents.local.yaml` names the adapter; it cannot hold a path.
- `verify` reports each configuration input as `reproducible`, `missing`,
  `mismatched` or `digest-only`, and checks that the adapter lock covers the
  composed configuration. It exits 1 when they don't reproduce. `diff` labels each
  change's layer (`project`, `adapter`, `local`, `composed`, `derived`), counts
  changes per layer, and reports `sameMode: false` between a committed-only and a
  composed stamp. Diffs of two committed-only stamps are unchanged.
- Session records gain `configuration` (`committed`, or `composed` with digest and
  adapter label/reference digest). The MCP stamp line names a composed
  configuration. `sessions` works in adapter mode.
- `inspect` lists the adapter as a configuration source, with its files, and
  never reads outside the adapter root.
- `update` records a stamp after an adapter-owned update. After a project-owned
  update the adapter lock is stale, so it records none and says to run `install`,
  then `stamp`.
- `materialize`, `revision` and the `migrate` evaluation workflow still refuse in
  adapter mode. No YAML, lock, store or bootstrap migration.

## 0.21.0 — 2026-11-09 — guarded updates with a project adapter (#97)

- `update` and MCP `update_preview` support a project adapter. The layer that
  declares a binding owns its updates. An adapter binding's update edits only the
  adapter's `agents.yaml` and lock. A project binding's update edits only the
  project's `agents.yaml` and lock, and the result must be valid alone and composed.
  The adapter's lock then becomes stale. Update never writes another layer's lock;
  `install` refreshes it as a separate step. Cross-layer edits are refused.
- An adapter update for a model that the project does not declare writes an
  exact-model rule. It adds no `models` entry and does not change routing.
  `outdated` sweeps the exact model IDs that adapter rules name, and reports each
  pin's `layer`.
- `previewDigest` covers the project configuration and lock, the local reference,
  the adapter configuration and lock, and the current and target store identities.
  Previews name each edit's `layer` and `file`, and list the action for each lock.
- Apply never signs; it refuses unapproved targets under `require_approval`. In
  adapter mode, it records no stamp (#98).
- Committed-only text output is unchanged. JSON gains `layer`, `adapter`, `locks`
  and per-edit `layer`/`file`. Previews made before 0.21.0 must be redone.

## 0.20.0 — 2026-11-09 — project adapter (#85)

- An ignored `.agent-profiles/agents.local.yaml` can name one external adapter
  whose `.agent-profiles/` composes over the committed configuration. The adapter
  may add package skills, roles and assignments over its own bindings, and append
  skills to project roles. It cannot override project policy, routing or trust.
  See [docs/project-adapter.md](docs/project-adapter.md).
- In adapter mode, `install` writes only the adapter's lock, which covers the composed
  configuration. Approval checks read project and adapter approvals.
  `library approve` records new approvals in the adapter. Install and update never sign.
- Adapter assignments may select an exact model ID the project does not declare,
  for adapter-owned bindings only. Routing stays the project's; any other model,
  alias, prefix or near match keeps the adapter's baseline pin.
- `resolve`/`explain` and `doctor` report adapter provenance. Committed-only output
  is unchanged. Commands that don't compose an adapter yet refuse while one is
  configured.

## 0.19.10 — 2026-11-09

- Ship only the ten named `.agent-profiles/` templates in the npm package instead
  of the whole directory (#85). Local locks, approvals, permissions, trust
  policy, host settings and extra roles or skills beside the templates no
  longer enter the tarball, or new projects through `init`.
- Add a packaging test that places sentinel local data beside the templates and
  checks the packed file list and contents.
- Add a wiki guide on keeping a personal skill workshop in its own repository.
  No configuration, lock or bootstrap migration.

## 0.19.9 — 2026-11-09

- Add Anthropic and OpenAI model-specific prompt auditing to the skill-tuning
  guide, with a scoped audit prompt and dated official sources.
- Separate editing, selection, policy and runtime-setting changes; retain
  behavioral evaluation before adoption. Documentation only, no migration.

## 0.19.8 — 2026-11-09

- Add a model-and-role skill tuning guide with preparation and retrospective
  prompts, evaluation gates, versioned selection and rollback guidance.
- Explain how Matt Pocock's retro feeds the next tuning cycle and distinguish
  screening results from adoption. Documentation only; no configuration,
  lock, bootstrap or runtime migration. No npm release is implied.

## 0.19.7 — 2026-11-08

- Add the Skill Compaction preset (preset 1.0.5): a `skill-compactor` role and
  a skill for preparing model-specific skill candidates that remove familiar
  execution explanation while preserving the behavioral contract (triggers,
  ordering, exceptions, approvals, verification). Editorial and
  capability-dependent cuts are labeled separately; candidates stay
  unvalidated until behavioral comparison.
- Ship draft development cases (suite 0.2.1, unexecuted), a protocol and a
  result template with the preset source. Worked application: the
  agent-profiles-superpowers companion (TDD for Sonnet 5.5).
- Documentation/example patch; no runtime, schema, lock or bootstrap migration.

## 0.19.6 — 2026-11-07

- Add an experimental Superpowers role example, resource-preserving setup steps,
  initial findings and a volunteer report template.
- Documentation/example patch; no runtime, schema or bootstrap migration.


## 0.19.5 — 2026-11-06

- Add a portable Ponytail preset with implementation, review, audit and debt
  roles, adapted MIT-licensed instructions, provenance and standalone agents.yaml.
- Document the cross-project experiment, clear/compact recovery limits and how
  evaluated model-specific library pins differ from copied preset instructions.
- No runtime or configuration schema changes; existing projects need no migration.

## 0.19.4 — 2026-11-06

### Complete npm, MCP and security onboarding

- Update the README prompt, quick start and setup guide to use 0.19.4 and
  explicitly configure MCP registration alongside the protocol-3 project bootstrap.
- Include host permissions, package pins, trust-policy choices, signed approvals,
  credential handling and withheld-package reporting in the setup proposal.
- Verify complete resolution before work, recovery after clear/compaction and the
  shell fallback; distinguish successful delivery from instruction adherence.
- Correct stale MCP documentation that said startup instructions contain profiles
  or that tool calls can override bound selectors. Prefer the npm quick start and
  keep source-package alternatives.
- Documentation patch only: no runtime, YAML, lock, store or bootstrap protocol change.

## 0.19.3 — 2026-11-06

### Truncation-safe MCP startup instructions (#80)

- **Bound server instructions no longer embed the resolved profile.** Hosts
  truncated them (Claude Code cut a bound payload inside its first required
  skill) and the old text told the agent not to call `resolve` again. Bound and
  unbound instructions are now a short bootstrap (under 2 KB, tested): call
  `resolve` before role work and again after `/clear`, compaction or a model or
  role change.
- **Truncation is detectable.** Every `resolve` output ends with
  `End of Agent Profiles context: <n> section(s): <ids>.` and says so at the
  top; a missing line means report incomplete setup, not proceed.
- **Bound selectors are authoritative.** A bound server refuses `resolve` or
  `explain` arguments that conflict with its `host`, `model`, `family`,
  `identitySource` or `role` binding.
- **Managed block, protocol 3.** The MCP handoff always calls `resolve` (the
  server's instructions never contain the profile) and runs the shell command
  when the tool is not available yet, including while the server is connecting.
  Both variants carry the final-line check. Protocol 2 blocks and
  `.agent-profiles/BOOTSTRAP.md` are reported stale; run `init` to refresh them.
- `bound` session records are documented as selection, not delivery.
- Lifecycle hooks for `/clear` and compaction are deferred until live tests show
  the instruction fix is insufficient.
- Portable fixture `test/fixtures/issue-80/`: two required skills sized like
  the report, each ending with a `FIXTURE-FINAL` line, used by an automated MCP
  and shell-fallback check and documented for live runs.
- Subagent delivery is documented as not validated (#82).
- **Any resolver failure stops role work.** The managed block, MCP
  instructions, the failed `resolve` tool result and CLI stderr all say setup is
  incomplete after any failure (not only a missing final line), and that
  reporting the error does not complete setup.

## 0.19.2 — 2026-11-06

### Published-package and MCP onboarding

- Refresh the README setup prompt and setup guide with approved, version-pinned
  npm inspection and installation, while retaining checkout/artifact alternatives.
- Separate MCP handoff from server registration and require an actual connection
  check; qualify compaction observations and T3/provider behavior.
- Explain existing deny rules, shared-library reuse and optional trust/update
  steps without changing permissions or automatically adopting packages.
- Documentation only; no configuration, lock, store or bootstrap migration.

## 0.19.1 — 2026-11-06

### Release preparation: the first npm release since 0.4.1

- Install snippets in README and `docs/setup.md` name `@guisam/agent-profiles@0.19.1`.
- The wiki's Versioning and upgrades page gets release notes and an upgrade path
  from 0.4.1.
- No code, configuration, lock or store-format change.

## 0.19.0 — 2026-11-06

### Instruction lint (#55 step 3)

- **Heuristic warnings, never blocking,** for package text that looks like prompt
  injection:
  - **High:** hidden characters (zero-width, bidirectional overrides, tag
    characters); instructions to override earlier rules or redefine the agent;
    keeping things from the user; sending secrets or data to an address; and
    `curl … | sh`-style downloads.
  - **Notes:** destructive or system-changing shell commands (unless the manifest
    declares `commands`), links (unless it declares `external-references`), HTML
    comments, and long encoded strings.

  Calibrated on 47 real skills: one high finding, which was a benign line.
- **Where they show:**
  - `library publish`: output, and `lint` in JSON.
  - `update` previews and the MCP `update_preview`: `lint`, each finding with
    `new`; carried-over findings are labeled.
  - New `library lint <@ns/name>@<version>`, for any version in the library.
- **Session records:** live check on Claude Code 2.1.318 recorded in
  `docs/sessions.md`.
- No configuration, lock or store-format change.

## 0.18.0 — 2026-11-05

### Session records (#38 phase 7)

- **`mcp --record-sessions`:** each resolution the server makes is written to a
  machine-local record. That covers the bound instructions at start and every
  `resolve` or `explain` call. A record holds:
  - the stamp digest;
  - model, role, host, project and profile;
  - the MCP client's name and version;
  - the selected package versions and digests;
  - skills the trust policy withheld.

  One record file per server process. Records go only to
  `~/.agent-profiles/sessions/` (or `AGENT_PROFILES_SESSIONS`), never to the project
  or store. This is the one opt-in exception to the MCP server's read-only rule,
  and a test checks the repository, store and home stay unchanged.
- **`resolve --record-session`** records a CLI resolution the same way.
- **`agent-profiles sessions [--root] [--all] [--limit] [--json]`** lists records,
  newest first.
- Recording never fails a resolution: an unwritable folder gives one warning.
- See [docs/sessions.md](docs/sessions.md). Off by default; nothing changes
  without the flags.

## 0.17.0 — 2026-11-05

### Trust policy enforcement (#71 part 3; completes step 2 of #55)

- **`resolve` withholds packaged skills the policy blocks.** This covers the CLI and
  the MCP `resolve`/`explain`.
  - **Always:** a namespace or manifest effect the policy doesn't allow.
  - **With `require_approval`:** versions without a valid signed approval.

  The profile and role still resolve. Blocked skills leave the required,
  available and loaded lists, and appear under `withheld` with the reason. The
  rendered context tells the agent not to look for them elsewhere and to tell the
  user. Without a policy, the output is unchanged.
- **`install`** refuses pinned versions the policy blocks, and **`update --apply`**
  refuses a blocked target. The preview shows `trustBlockers` and "Apply will be
  refused". `outdated`, `update` and `library info` keep showing configured pins,
  so blocked versions can still be seen and approved.
- **Terminal confirmation without a key:** with a policy but no `signing_key`,
  `update --apply` asks for the first 8 characters of the preview digest, and
  `library publish` asks for `name@version`. Without a terminal, such as an agent's
  shell, they refuse.
- **Docs:** the enforcement table and a migration path for turning on
  `require_approval` (approve existing pins first). This also records the Windows
  live check of `library approve`.
- No configuration, lock or store-format change.

## 0.16.0 — 2026-11-05

### Signed approvals (#71 part 2, step 2 of #55)

- **`library approve <@ns/name>@<version>`:**
  - writes `.agent-profiles/approvals/@ns/name/<version>/<principal>.json` (package,
    version, object digest, principal, time);
  - signs it with `ssh-keygen -Y sign` using the policy's `signing_key` (or `--key`);
  - verifies the result.

  A failed signature or verification leaves nothing behind. Commit the files with
  the project.
- **Formatter-proof:** the signature covers a canonical serialization, so a
  reflowed file still verifies, while any changed value doesn't.
- **Status:** `library info --root`, `outdated`, `update` previews and the MCP
  `update_preview` show whether a version is approved and by whom (`approvals` /
  `approval` in JSON; `null` without a policy). Files that don't count are listed
  with the reason. With `require_approval`, `doctor` notes each unapproved pin.
- **Deny rule:** `init` now also denies `library approve` to agents. Existing
  installs get a `doctor` note until `init` is run again.
- **Nothing is enforced yet:** `resolve`, `install` and `update` behave as before.
- See [docs/trust.md](docs/trust.md).

## 0.15.0 — 2026-11-05

### Trust policy and SSH signature verification (#71, step 2 of #55, part 1 of 3)

- **Trust policy:** `~/.agent-profiles/trust.yaml` (or `AGENT_PROFILES_TRUST`)
  holds:
  - `allowed_signers`: an OpenSSH file naming who may approve;
  - `signing_key`;
  - `require_approval`: opt-in;
  - allowed `namespaces`, manifest `effects` (default: `substitution` only), and
    approver `principals`.

  A project's `.agent-profiles/trust.yaml` can only narrow it, and can't name keys.
- **SSH signatures, verified natively:** the SSHSIG format from `ssh-keygen -Y sign`,
  for `ssh-ed25519` and hardware `sk-ssh-ed25519@openssh.com` keys, with Node's
  Ed25519. It checks the namespace, `allowed_signers` principals (with patterns),
  `namespaces=`, `valid-after=` and `valid-before=`. Hardware-key signatures must
  carry the user-presence (touch) flag. No new dependency.
- **`doctor`** reports the policy, and errors on anything that would stop
  approvals from verifying.
- **Nothing is enforced yet:** approvals (`library approve`) and enforcement in
  `resolve`, `install` and `update` follow. Projects without a policy are
  unaffected.
- See [docs/trust.md](docs/trust.md).

## 0.14.1 — 2026-11-04

### `--version` from the installed package (#69)

- **Fix:** `agent-profiles --version` (added in 0.13.3) failed from an installed
  package with `ENOENT … dist/package.json`: the published CLI runs from
  `dist/bin/`, and it looked one folder too shallow. It now finds the package
  root from either layout, as the rest of the CLI does. The package test checks
  `--version` and `-v` against the installed build.
- **Host record:** on 0.14.0, the agent read `SKILL.md` with `library_read`, with no
  store-folder listing or shell command.
- No configuration, lock or store-format change.

## 0.14.0 — 2026-11-04

### Verified package reads for agents (#67, follow-up to #55)

In a live check, an agent asked for a version's `SKILL.md` listed the store
folder and read the object file directly. The text was right, but nothing
verified it: the resource read, which checks the object first, was skipped.

- **`library read <@ns/name>@<version> <path>`:** prints one package file after
  verifying the version's object, like `library info` does. A tampered version is
  refused, never printed. `--json` carries `encoding` (`utf8` or `base64`).
- **`library_read` MCP tool:** the same, returning the CLI's JSON. The resource
  handler now reads through the same code.
- **Server instructions** tell agents to read package files with `library_read`
  or the resources, and not to open files in the store folder.
- **Host record:** the user applying the agent's command on 0.13.3, and `resolve`
  selecting the new version afterwards.
- No configuration, lock or store-format change.

## 0.13.4 — 2026-11-04

### Librarian tools live recheck (docs)

- Records the 0.13.3 recheck on Claude Code with Opus 5.5: the agent's
  `update_preview` summary listed both `agents.yaml` edits (the rule and the
  model declaration) and relayed the `npx --no agent-profiles …` apply command
  as returned. The host record and MCP status rows are marked verified.
- No code change.

## 0.13.3 — 2026-11-04

### Preview edits in the structured result; `npx` apply command; `--version` (#64)

Found rechecking 0.13.2 live on Claude Code: the agent relayed the apply command
exactly, but again reported only the rule, not the model declaration. It
described the rule from the structured result, and that had no list of edits.

- **`edits` in JSON and MCP:** previews carry every `agents.yaml` edit as
  `edits` (`add-rule` or `replace-binding`, and `declare-model`), the same list
  the text shows. The `update_preview` description and server instructions point
  agents at it.
- **Apply command:** now `npx --no agent-profiles update …`, the invocation
  `init` writes for hooks, so it runs where the CLI is a dev dependency.
- **`--version` (`-v`):** prints the installed version.
- **Host record:** the 0.13.2 recheck is recorded.
- No configuration, lock or store-format change.

## 0.13.2 — 2026-11-04

### Preview: complete apply command and every edit listed (#62)

Found when rechecking 0.13.1 live on Claude Code: the agent's `update_preview`
succeeded, but its summary left out the model declaration, and it had to rebuild
the apply command, since "the same command" means nothing over MCP.

- **Complete apply command:** previews end with the full command, every argument
  filled in, including `--root` (and `--store` when one was given), with paths
  quoted when needed. `--json` and `update_preview` carry it as `applyCommand`.
- **Edits listed together:** the rule and any model declaration appear under one
  "Edits to agents.yaml (n)" list, replacing the separate `Rule:` and `Model:`
  lines.
- **MCP guidance:** the `update_preview` description and server instructions ask
  agents to relay every listed edit and the `applyCommand` as returned.
- **Host record:** the 0.13.1 recheck is recorded, including that the agent read a
  store file directly instead of through the verified resource.
- No configuration, lock or store-format change.

## 0.13.1 — 2026-11-04

### Update for undeclared models (#60)

Found in a live check of the librarian tools on Claude Code: the agent chose
`update_preview` over the denied shell `update` and read `SKILL.md` as a resource,
but the preview failed.

- **Undeclared models:** `update` and `update_preview` failed with "not a declared
  model" when the model reached its profile through `default_profile` or a
  family, which is how most real model IDs route in the example configuration.
  `update` now declares the model with the profile it resolves to now, in the
  same edit as the rule, so routing doesn't change. The preview shows a `Model:`
  line, and `--json` carries `declaredModel`. An alias targets its canonical
  model and declares nothing.
- **Profile changes count:** the check that refuses an edit affecting other
  tuples now also compares each tuple's profile, not only its bindings.
- **Binding suggestion:** a bare skill ID such as `security-review` now gets
  "did you mean skills.security-review?".
- **Host record:** the live check is recorded in the Claude Code host page and
  host observations.
- No configuration, lock or store-format change.

## 0.13.0 — 2026-11-04

### Librarian tools in the MCP service (#58, phase 5 of #38)

- **Six read-only tools:** `library_list`, `library_search`, `library_info`,
  `library_evidence`, `outdated` and `update_preview`. Each returns the same JSON
  as its CLI equivalent as structured content, plus the CLI's text rendering.
  - `update_preview` never applies. It's how an agent previews a pin move, since
    the #55 deny rules refuse an agent's `update` command.
  - Tools that take `root` choose the project like `resolve` does, including
    workspace roots.
- **Package files as resources:**
  `agent-profiles://library/{@namespace}/{name}/{version}/{path}`. The list
  offers each version's entrypoint, and reads verify the object first (a tampered
  version is an error). Text files come back as text and binary files as blobs.
- **Server instructions** tell agents that library tools only read, and that
  pins change only when the user runs the apply command.
- No configuration, lock or store-format change.

## 0.12.1 — 2026-11-04

### Deny rules live check (#55)

- Documentation only. Recorded a live check on Claude Code 2.1.318 (Windows 11,
  Opus 5.5) in `docs/hosts/claude-code.md`, `docs/host-observations.md` and
  `docs/bootstrap.md`:
  - an agent's `library publish` was refused and nothing was published;
  - read-only `outdated` ran;
  - `update` previews are refused too, because the deny rule matches the whole
    `update` command.

## 0.12.0 — 2026-11-04

### Library guardrails (#55, step 1)

- **Deny rules.** `init --agent claude` adds `permissions.deny` rules for the
  commands that change the library, a project's pins or the installation:
  `library publish`, `add`, `install`, `update`, `migrate promote`,
  `revision record`, `init` and `uninstall`, for both `npx --no agent-profiles` and
  `agent-profiles`, in Bash and PowerShell. They're owned in
  `.agent-profiles/permissions.json`, removed exactly by `uninstall`, and noted by
  `doctor` when missing.
  - **Limit:** they match command prefixes, so they're a guardrail, not a
    boundary.
- **Content diff.** `update` previews now include `contentDiff`: a unified diff of
  every text file, old version to new, plus binary, added and removed files. The
  text output prints the diff before the apply hint.
- **MCP stays read-only.** This is documented as an invariant: no write tools will
  be added to the MCP server.
- **Fix to `uninstall`.** It no longer leaves an empty `permissions.allow` (or an
  empty `permissions`) in settings that had none before `init`.
- No configuration, lock or store-format change. Re-run `init --agent claude` to
  add the deny rules to an existing installation.

## 0.11.2 — 2026-11-04

### Performance (#53)

- **Store records skip a redundant parse.** They are canonical JSON, and they no
  longer go through a second, full YAML parse after `JSON.parse`. Text that equals
  its own canonical encoding cannot contain a duplicate key or a non-integer
  literal, which is all that pass checked. Other input (plan, result and decision
  files) keeps the strict path.
- **Manifests are parsed once.** Validated `package.yaml` manifests are cached by
  their exact bytes within a process, instead of being re-parsed on every object
  and companion verification. Callers get a deep copy, and failures aren't cached.
- **Lighter CLI start.** Heavy command modules (installer, library, migrations,
  outdated, notice, stamps, materialize, visualizer, presets) load only for the
  command that uses them. `findRoot` moved to `src/root.ts` (still re-exported
  from `install.ts`).
- **CI:** Windows tests run in three shards, with the package check as a fourth
  parallel job.
- **Measured on Linux:**

  | | Before | After |
  | --- | --- | --- |
  | Promotion contract suite | 147 s | 70 s |
  | Library evidence suite | 40 s | 21 s |
  | Outdated suite | 23 s | 12 s |
  | Compiled `resolve` start | 185 ms | 113 ms |

- No behavior, configuration or format change.

## 0.11.1 — 2026-11-04

### Update notice live check (#49)

- Documentation only. Recorded a live check of the update notice hook on Claude
  Code 2.1.318 (Windows 11, Opus 5.5) in `docs/hosts/claude-code.md`,
  `docs/host-observations.md` and `docs/versioned-packages.md`:
  - shown on a new session as `SessionStart:startup says: …`;
  - not shown after `/clear` or on a restart with nothing changed.

  That the notice stays out of model context is recorded as limited (a model
  self-report). `/compact` and `resume` remain unverified live.

## 0.11.0 — 2026-11-03

### Update notice (#49, follow-up to #48)

- **New command, `agent-profiles notice`.** It shows a once-a-day summary of
  library updates for the project:
  - actionable lines for newer, pinnable versions with `promoted` evidence for a
    tuple a pin serves;
  - a count of pins with newer versions but no such evidence.

  It is silent until a cheap fingerprint changes (store index names, plus the
  project's configuration and lock), at most once a day per project, with state
  under `~/.agent-profiles/notices/`. `--hook claude` prints only a user-facing
  `systemMessage` for a Claude Code `SessionStart` hook, ignores non-startup
  sources, and is silent on any error.
- **The installer adds the hook.** `init --agent claude` adds a startup-only
  `SessionStart` hook to `.claude/settings.json` next to the permission rules,
  recorded in `.agent-profiles/permissions.json`. `uninstall` removes exactly that
  hook. `doctor` notes a missing hook without failing.
- **CI check.** `outdated --check` prints the summary and exits 1 when something
  is actionable.
- **Doctor.** `doctor` adds an "Updates" line.
- **Setting.** `AGENT_PROFILES_NOTICE=all|actionable|off` controls the level.
- **Fix to `outdated`.** A host-less tuple no longer counts evidence recorded on a
  host that a rule of the same binding names.
- No configuration, lock or store-format change. Re-run `init --agent claude` to
  add the hook to an existing installation.

## 0.10.0 — 2026-11-03

### Outdated and update (#48, phase 4 of #38)

- Add `agent-profiles outdated`. For every pin (the shared default and each
  assignment rule) it shows:
  - the role × model tuples the pin serves;
  - newer library versions, marked when the major version changes and, in v3,
    when a version needs a `revision record`;
  - per newer version and served tuple, the #46 evidence or "untested".

  It's read-only, filters by model, role and host, and takes `--json`.
- Add `agent-profiles update <binding> <version> --model --role --host`.
  - It previews by default. It moves one exact tuple's pin, using promotion's
    targeting: the selected rule is replaced if it already pins the tuple, and
    otherwise one `update-<hash>` rule is added.
  - It refuses if any other tuple's selection would change.
  - `--apply` edits `agents.yaml` (comments kept), refreshes the lock and
    captures a stamp. `--expect <previewDigest>` refuses if anything changed
    since the preview.
  - `--require-evidence` refuses without promoted evidence for the tuple.
  - "Already pinned" writes nothing.
- Promotion's exact-tuple targeting moved to `src/binding-target.ts`, shared by
  both. Promotion rule ids are unchanged.
- New APIs: `outdatedPins`, `previewUpdate`, `applyUpdate`.
- No configuration, lock, stamp or store-format change; no migration.

## 0.9.0 — 2026-11-03

### Library evidence (#46, phase 3 of #38)

- `library info` shows an Evidence section per version, and the new
  `library evidence <@ns/name>[@<version>] [--model] [--role] [--host] [--root]`
  filters it. Each row is one retained paired evaluation for one exact
  role × model × host, with:
  - the outcome: `promoted`, `promoted with override` (naming the waived cases),
    `eligible, not promoted`, or `blocked` (with its regressions);
  - correctness per side, and metric deltas when both sides are completely
    measured;
  - the harness, judge and rubric;
  - the origin: `evaluated here`, `approved elsewhere` or `evaluated elsewhere`;
  - with `--root`, the configured family.

  With a filter, versions that have no matching row are listed as `untested`.
- The library now includes promoted releases (source `promoted`), which have a
  release label but no imported identity, and marks adopted releases (source
  `adopted`). Previously `library list` did not show promoted versions.
- Evidence is read through the existing revalidating readbacks; nothing is written,
  and a record that fails revalidation is reported as a problem. Correctness stays
  an external claim and runtime stays unverified.
- New APIs: `libraryEvidence` and `listReleaseLabels`. Library versions gain
  `source` and `revisionDigest` fields.
- No configuration, lock, stamp, evaluation or promotion format change; no
  migration.

## 0.8.0 — 2026-11-03

### Local skill library (#44, phase 2 of #38)

- Add `agent-profiles library` over the existing store:
  - `list [--type skill|instruction]` shows every package with its versions,
    newest first;
  - `search <text>` matches names and descriptions;
  - `info <@namespace/name>[@<version>] [--root <directory>]` shows verified
    details per version and, with `--root`, which versions that project pins
    and locks;
  - `publish <directory>` imports a package directory, reading its identity from
    `package.yaml`, with the same validation and store bytes as `add`.

  All take `--json`.
- `list`, `search` and `info` never write. They verify every version they report,
  and a corrupted object is reported rather than listed as valid. Stray entries in
  the store are reported as problems without hiding the rest.
- New APIs: `listLibrary`, `searchLibrary`, `libraryInfo`, `publishPackage`, and
  `listIdentities` in the store module.
- No configuration, lock, stamp or store-format change; no migration. `add` is
  unchanged.

## 0.7.1 — 2026-11-03

### MCP live check on Claude Code (#38)

- Documentation only. Recorded a live check on Claude Code 2.1.317 (Windows 11,
  Opus 5.5) in `docs/hosts/claude-code.md`, `docs/host-observations.md` and the
  `docs/mcp.md` status table. Verified:
  - the `resolve` tool runs without the shell allow rules and without a
    permission prompt;
  - with the `init --mcp` block, the agent calls the tool instead of the shell
    command;
  - Claude Code offers workspace roots;
  - bound server instructions, stamp line included, survive `/compact` and
    `/clear`.
- Still unverified: other models, workspace trust as a variable, and Codex,
  OpenCode and Hermes.

## 0.7.0 — 2026-11-02

### MCP workspace roots and session stamp digest (#39, part of #38)

- `resolve` and `explain` use the host's workspace roots when neither a `root`
  argument nor `--root` names the project and the client offers roots: the one
  root containing `.agent-profiles/agents.yaml` is used. Several are refused; none
  falls back to the working directory. Works on 2025-era connections
  (`roots/list`) and the 2026-07-28 revision (in-band input request), where roots
  are deprecated.
- Bound MCP instructions start with the session's stamp digest, computed without
  writing to the store. It equals what `agent-profiles stamp` records for the same
  selectors, and the line says whether that stamp is already retained.
- New `previewStamp` API: the digest and snapshot `createStamp` would record,
  without writing. `createStamp` output is unchanged.
- No configuration, lock, stamp format or managed-block change; no migration.

## 0.6.0 — 2026-11-02

### MCP handoff in the managed block (#39, part of #38)

- `init --mcp` writes a managed-block variant that tells the agent to call the
  connected `agent-profiles` MCP server's `resolve` tool with the same values, or
  to follow the server's instructions when they already carry the session's
  profile. The shell command stays in the block as the fallback.
- `init` without a flag keeps each block's current variant; `init --no-mcp`
  restores the shell-only block. The flags apply to the agents selected with
  `--agent`; other installed blocks keep their variant.
- `init --mcp` prints the host's MCP server setup (a `claude mcp add` command,
  Codex TOML, OpenCode JSON or Hermes YAML). `doctor` shows which blocks have the
  handoff and whether the project's host file (`.mcp.json`,
  `.codex/config.toml`, `opencode.json`) names the server. User-scope host
  configuration is not read, and the installer still never writes host MCP
  configuration.
- Protocol stays 2 and `BOOTSTRAP.md` is unchanged: existing shell-only blocks
  remain current, so no repository has to re-run `init` after upgrading.

## 0.5.0 — 2026-11-02

### MCP service (#39, part of #38)

- Add `agent-profiles mcp`, an optional stdio MCP server with five read-only
  tools: `resolve`, `explain`, `verify`, `diff` and `report`. Each matches its
  CLI equivalent (`resolve`, `resolve --json`, `verify --json`, `diff --json`,
  `migrate report --json`). Started with `--model` or `--role`, the server's MCP
  instructions carry the resolved profile for that session; otherwise they point
  the agent to `resolve`. No tool writes configuration, locks, stores or host
  configuration. See [MCP service](docs/mcp.md).
- `resolve` rendered for MCP points packaged skills and "run again" to the
  `resolve` tool instead of shell commands. The CLI rendering is unchanged.
- New runtime dependencies, loaded only by the `mcp` command: the official MCP
  TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0) and `zod` 4.6.7.
  Rationale is recorded in #38.
- No configuration change and no migration required. Host MCP configuration is
  never written by the installer.

## 0.4.1 — 2026-10-28

First npm release. The source-development notes below retain their historical
publication and qualification status; they are not separate npm releases.

### npm publication preparation (source version 0.4.1)

- Publish under the personal scope `@guisam/agent-profiles`; npm rejected the
  unscoped name as too similar to `agentprofiles`. The CLI command stays
  `agent-profiles`. Bootstrap verification, fixtures and tarball paths use the
  scoped package identity.

- Track npm publication readiness in the existing release checklist and correct
  the lockfile CLI path to match the compiled executable in the package manifest.
  Add a manually triggered GitHub Actions trusted-publishing workflow with
  version checks, validation, and publication disabled by default. No configuration
  migration is required. Initial publication is authenticated manually; future
  releases use the configured GitHub Actions trusted publisher.

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
