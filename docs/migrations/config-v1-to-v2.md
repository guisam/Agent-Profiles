# Configuration v1 → v2 migration

## 1. Scope and status

**From:** integer `version: 1`. **To:** integer `version: 2` in
`.agent-profiles/agents.yaml` of one explicitly approved consuming project.
**Base conversion:** change that scalar only; retain local and native bindings.
Package adoption is separate, optional work (section 8).

**Implemented in this checkout:** [resolve.js](../../src/resolve.js) validates
both configuration versions 1 and 2. The [package manifest](../../package.json)
remains CLI version `0.1.0`, **unpublished**; no published v2-supporting release
number is established. The [v2 contract](../development/issue-20-contract.md#5-project-schema-and-deterministic-assignment-c08c09)
and [package guide](../versioned-packages.md) describe the accepted working behavior.
Artifact, supported-platform and final whole-solution review gates remain separate.
Verify the actual local tool before use: an older installed executable may still
reject v2. Missing suitable tools or safe preview validation blocks application;
checkout support never grants permission to edit a real consumer. Use the
[companion prompt](prompts/config-v1-to-v2.md) with exact-preview approval.

## 2. Tool and schema prerequisites

- Approve a canonical project root, the required read paths, the sole write target
  `.agent-profiles/agents.yaml`, and a private evidence/preview directory outside the
  project. Do not infer permission to read user/plugin skill directories or credentials.
- Identify the actual locally available executable and its package version from its
  installed package manifest; inspect `agent-profiles --help`. No invented `migrate`,
  `validate`, `--version`, package-install or v2-only flags are needed for base conversion.
  Do not use an invocation that silently downloads a missing executable.
- The current manifest requires Node.js `>=24`; confirm the runtime and the selected local tool's documented requirements. Use an already-installed, explicitly identified
  v2-capable checkout/tool whose code and documentation support both schemas and the
  read-only `resolve` operation. Also identify the source v1 validator. Missing tools
  block application; this guide does not authorize installation or upgrades.
- Validate v1 with its actual resolver, including all referenced profiles, roles and
  configured skills. Inspect the accepted v2 schema: base conversion is valid only if
  retaining these exact fields/values is still supported. Any changed rule or unsupported
  legacy construct requires a clarified mapping and refreshed approval, not improvisation.
- Establish safe candidate preview validation using the verified local resolver/API or an
  approved isolated preview root with only the necessary relative-path copies. Copy
  bytes, not symlinks; never execute copied instructions. Do not copy whole projects,
  machine settings, dependencies, or external user/plugin skills. If no supported safe
  preview is possible, stop before application.

## 3. Exact mapping and preserved semantics

| Source v1 | Target v2 base conversion |
| --- | --- |
| Top-level integer `version: 1` | Top-level integer `version: 2` |
| `default_profile`, `default_role` | Unchanged |
| `models` keys, profiles, aliases; `families` keys, profiles, prefix lists | Unchanged |
| Roles, descriptions, role-relative `file`, required/available skill lists | Unchanged, including declaration order |
| Implicit conventional profile/skill paths | Still implicit, with the same IDs and files |
| Explicit skill `file` | Same repository-relative path; do not make it role-relative |
| Native skill `host`, `scope`, optional `id` or implicit host-ID fallback | Unchanged; native stays invocation metadata, never injected text |
| Missing optional maps/fields | Remain missing; do not insert `profiles`, `assignments`, `resources`, package bindings or empty maps |
| Existing instruction/support/shared files and any leftover lock | Byte-identical and untouched |

Preserve exact model key → alias → supplied family → longest configured prefix →
default routing, case sensitivity, and independent role selection. Preserve required
then first-occurrence-deduplicated requested skill order; available list order and
permission do not change. Composition remains profile, role, required injected skills,
then requested available injected skills. Native skills do not enter composition;
compatibility/host-provided metadata is not proof of actual invocation or visibility.
Instruction bytes, BOM, CRLF/LF and trailing blanks must remain identical, not merely
trimmed text. Configuration/resolver-version metadata may change; routing provenance,
selected bindings and instruction semantics must not.

For this zero-package conversion, v2 resolution needs no dependency lock;
an unrelated leftover lock remains untouched. Do not run dependency install, add
resource declarations, create stamps, import packages or adopt assignments as part
of base conversion. Invalid tokens, ambiguous local definitions, missing files,
unknown fields or duplicate keys stop rather than being normalized or guessed.

## 4. Read → plan → preview → approval → edit → validate → report

### Read

Read the guide, approved configuration and required referenced files as data.
Record configuration bytes/hash and version; record protected instruction hashes and
existing lock presence/hash. Validate the source before any write. Record relevant
existing dirty files without resetting them. If version is already 2, use the
already-target procedure in section 6; do not interpret it as a package-adoption request.

These read-only command forms support v1 and v2 in this checkout. Replace placeholders with approved absolute paths
and use the verified local executable; they are examples, not commands to execute
against this repository automatically:

```text
agent-profiles --help
agent-profiles resolve --root "<approved-project-root>" --json
agent-profiles resolve --root "<approved-project-root>" --model "<declared-model-or-alias>" --role "<declared-role>" --json
```

Use the real `--family`, `--host`, and repeatable `--skill` selectors where applicable.
Build and record a context matrix: defaults; every configured model and alias; every
supplied family; configured prefix and longest-overlap routes; an unrecognized model
for default; every role; representative ordered/duplicate requests covering available
skills; relevant supported hosts and a hostless context. Preserve cross-host required
native findings instead of inventing readiness. Do not submit these model IDs to a
provider: resolver inputs are routing data only.

### Plan

Propose only the version-scalar replacement. List exact write/read/evidence paths,
expected unchanged fields/files and context outcomes, validator/tool identities,
backup/rollback procedure, and any missing or failed checks. Do not add unrelated
cleanup. If the selected local tool/schema differs, stop and resolve that difference
before proposing a revised migration contract.

### Preview

Produce a candidate without overwriting the source. Preserve original YAML bytes
except the scalar token where feasible (use syntax-aware location, not a global
replace that changes nested package pins/comments). Parse both documents strictly;
compare the full parsed structures after excluding only the top-level `version`.
Show the exact diff, candidate hash and any formatting differences. With the verified local v2-capable resolver, validate the candidate in the approved preview boundary and
compare the recorded context matrix, ordered composition and raw instruction hashes
against v1. The `resolve --root "<approved-preview-root>" --json` form works with this checkout; verify that the chosen installed tool also accepts v2 before application. No unsupported
preview flag or automatic migration command is implied.

### Approval

Present the preview, findings, evidence and remaining gaps. Wait for explicit approval
of the exact candidate, write target, evidence/backup location and bounded rollback.
A request for analysis or the prompt alone is not application approval. Missing v2
validation blocks application even if the diff looks simple.

### Edit

After approval, make an exact-byte backup of the sole target in the approved evidence
location and verify its hash. Do not overwrite preexisting backups. Re-read configuration
and required inputs, including lock/instruction hashes; if they differ from the preview
baseline, stop and re-plan. Apply only the approved scalar edit with guarded paths,
retaining comments/newline style/BOM where feasible. Record and read back the exact
result and its hash. No whole-project serializer/reformatter or extra file writes.

### Validate

Reparse the result with the actual supported v2 schema, re-run the same context matrix using
the verified v2-capable resolver, and compare field values, routing provenance,
role/skill ordering, local/native bindings and all protected instruction bytes.
Check that only the approved target changed; leftover lock stays identical. Save exact
arguments, exits and diagnostics. Repeat the procedure on this target-version input:
validation must succeed with a no-op, byte-identical config and no new backups/writes.
If a check fails, stop and use section 6; no silent repair, relock or partial success.

### Report

Report `completed`, `already-target/no-op`, `blocked`, `failed/restored`, or
`incomplete/recovery-conflict`. Include source/target versions, guide/tool identities,
exact changed paths, before/after/backup hashes, executed checks/exits and context
comparisons, unchanged protected files, rollback outcome and unexecuted checks.
Do not call it complete without source, preview, post-edit and repeat no-op validation.

## 5. Same-semantic example

Fictional consumer names only. Before validating, supply unchanged regular Markdown
files `profiles/{constrained,autonomous,scaffolded}.md` and `roles/reviewer.md` under
`.agent-profiles/`; supply `.agent-profiles/skills/testing/SKILL.md` and
`.agent-profiles/instructions/review/SKILL.md` with valid skill frontmatter including
`description`. No conventional `skills/local-review/SKILL.md` or
`skills/native-review/SKILL.md` may conflict with those explicit bindings.
The native user reference stays host-provided/unverified; no user-home read is needed.

**Source v1:**

```yaml
# Generic consumer; retain this comment and the original newline style.
version: 1
default_profile: constrained
default_role: reviewer
models:
  example-large:
    profile: autonomous
    aliases: [example-large-alias]
families:
  example-family:
    profile: scaffolded
    match:
      prefixes: [example-small-]
roles:
  reviewer:
    file: roles/reviewer.md
    description: Review changes without editing instructions.
    skills:
      required: [testing]
      available: [local-review, native-review]
skills:
  local-review:
    file: .agent-profiles/instructions/review/SKILL.md
  native-review:
    host: claude
    scope: user
    id: review-helper
```

**Target v2 (accepted by the current checkout):**

```yaml
# Generic consumer; retain this comment and the original newline style.
version: 2
default_profile: constrained
default_role: reviewer
models:
  example-large:
    profile: autonomous
    aliases: [example-large-alias]
families:
  example-family:
    profile: scaffolded
    match:
      prefixes: [example-small-]
roles:
  reviewer:
    file: roles/reviewer.md
    description: Review changes without editing instructions.
    skills:
      required: [testing]
      available: [local-review, native-review]
skills:
  local-review:
    file: .agent-profiles/instructions/review/SKILL.md
  native-review:
    host: claude
    scope: user
    id: review-helper
```

The complete diff is `version: 1` → `version: 2`. Exact/alias `example-large` routes
to autonomous; supplied `example-family` or prefix `example-small-` routes to
scaffolded; unrecognized input falls back to constrained. Role is reviewer independently.
Requesting `[native-review, local-review, local-review]` on host `claude` still injects
profile, role, testing, local-review in that order, while native-review remains invoke
metadata with host ID `review-helper`. No package identity, revision, import or lock
is introduced. These selections are exercised by the owned fixture controls. Qualify the actual local tool and approved consumer inputs before application.

## 6. Failure, rollback, and idempotence

- Missing/unparseable/noninteger/unknown version, a version other than 1 or 2, or a
  newer version: stop without writes; do not downgrade or infer an adjacent mapping.
- Already version 2: validate with the actual v2-capable resolver and applicable lock
  rules, report findings and no-op. Never rewrite, create backups, import dependencies
  or regenerate a lock. If v2 tools/package bytes/valid lock are unavailable, report
  blocked/invalid rather than successful no-op. Existing package-enabled v2 inputs
  are not permission to repair them; zero-pin rules do not bypass their lock checks.
- Invalid v1 or uncertain mapping: report the exact location/error and ask for a
  separate repair decision. Unavailable preview/v2 validation: preserve source; blocked.
- Approval denial or drift: leave source untouched; retain evidence, restart preview
  only under the same approved scope. Do not overwrite another actor's edits.
- Post-edit failure: stop dependent work. Under approved rollback, restore the backed-up
  configuration **only if current bytes still equal this attempt's recorded result**;
  verify restored bytes/hash. If they differ, retain backup/result/current evidence,
  report recovery conflict and wait. Never restore instructions, package sources, locks,
  host files or unrelated dirty files. A killed attempt may need manual bounded recovery;
  classify an unverified result as incomplete, not success. If the result cannot be
  established as this attempt's bytes, do not overwrite it.

## 7. Completion checklist and exclusions

- [ ] Actual source/target schemas and executable/runtime identities recorded; v2 ready.
- [ ] Valid v1 baseline, protected bytes and context matrix captured.
- [ ] Scalar-only preview, semantic equality, v2 preview validation and approval recorded.
- [ ] Exact backup verified; stale-input check passed; sole approved edit read back.
- [ ] Post-edit v2/context/byte/protection checks and repeat validation/no-op passed.
- [ ] Final paths/hashes, actual outcomes, limitations and any rollback reported.

No Git publication or repository reset, instruction/package source changes, package
imports/dependency installation/downloads, model/product calls, credential access,
host settings/bootstrap edits, native enablement, successor delegation, real consumer
migration by this documentation task, automatic migration engine or history UI.
Separate authorization is required for any such expansion. Structural/byte preservation
is not live host invocation, runtime model attestation, or exclusive skill visibility.

## 8. Optional adoption and next adjacent step

After base migration is separately verified, the user may explicitly choose package
bindings/import/lock/assignments. Obtain exact user-selected logical bindings, approved
existing local source directories, manifest identities, exact versions and verified
bytes/digests; never invent package names or revisions from local filenames, Git
labels or an example. Keep native delivery unchanged unless separately requested.
Package binding plus a conflicting conventional local definition is rejected, not
silently shadowed; resolving it may need separately approved instruction-file changes.
D2 requires explicit conflict reporting unless a more-specific combined rule resolves
it. Selection rules, full pin coverage, store/import and lock validation need a separate
preview, scope and approval against the accepted implementation. The implemented [package commands](../versioned-packages.md) are available in this checkout; verify the selected local tool before separately approved adoption.

A future v2 → v3 transition requires its own adjacent guide and prompt under the
[common pattern](README.md#future-chains). Stop if that guide/tool/schema is missing;
do not infer an arbitrary v1 → v3 leap or implement a migration framework.
