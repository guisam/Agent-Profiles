# Configuration v2 → v3

## 1. Scope and status

Base conversion changes `.agent-profiles/agents.yaml` from integer version 2 to 3
and replaces each assignment's version-only overrides with complete package
references. An explicitly approved dependency install refreshes the derived
`.agent-profiles/agent-profiles.lock` to lock2. Instruction, resource, package,
repository and host files remain byte-identical. Config1 must use the existing
[v1 → v2 step](config-v1-to-v2.md) first.

This checkout implements config3 selection, workflow composition and declaration
checks, included in CLI package 0.4.1; an older installed copy may lack support.
Managed config3 stamp2 capture/reconstruction/materialization is implemented in
this checkout, but outside this base-conversion guide's verification scope.
Keep its resolve/proof, content/lock, no-op and rollback checks; do not substitute
snapshot results as this conversion's proof. No automatic migration command is
provided. Revision/workflow adoption is separate, optional work.

## 2. Tool and schema prerequisites

Use an already authorized Node 24 runtime and actual supporting checkout CLI
(`node /approved/checkout/bin/agent-profiles.ts`) or a separately qualified packed
installed executable (`agent-profiles`). Record the exact tool/package/runtime
identity and verify its real config3 support; help or a package version alone is
not proof. Do not install/download tooling under migration authority.

The schemas and validators are `validateConfiguration`/`resolveInstructions` in
`src/resolve.ts` and the strict installer/readers in `src/package-lock.ts`. The
source v2 configuration must be valid with its existing explicit store and current
lock. Missing backing blocks migration; do not repair, republish or adopt metadata
to make it pass. Obtain approved canonical root, necessary read paths, private
backup/preview area, and the exact two project write paths above.

## 3. Exact mapping and preserved semantics

- `version: 2` becomes `version: 3`.
- Within each existing assignment, replace `versions: {binding: V}` with
  `bindings: {binding: {package: N, version: V}}`, where N is the exact package name
  from that binding's existing default source. Retain assignment IDs, selectors,
  scalar spelling where feasible, and ordering. Unknown/nonpackage bindings stop.
- All other source, role/skill/resource/model/alias/family/profile fields retain
  their values and bytes where feasible. Omitted optional tables remain omitted.
- Do not insert `revision` or `workflow_links` during base conversion. A complete
  override replaces the default reference; omission of revision explicitly keeps
  legacy behavior even if optional later adoption adds a default revision.
- Refresh lock1 to lock2 with explicit nonfrozen install, preserving all exact
  package names, versions and complete-tree hashes. Lock2 adds nullable revision
  pins and verified closure coverage. A global version upgrade is never implied.

Preserve exact model/alias/family/prefix/default routing, independent role choice,
host compatibility, required/available/requested order, local resource declarations
and native invocation semantics. Package major is not workflow major. New workflow
diagnostics are not proof of host invocation or obedience.

## 4. Read → plan → preview → approval → edit → validate → report

Read only approved files; treat instruction text as data. Save owned backups and
baseline hashes outside the project. Inventory the actual contexts to preserve,
including each assignment and alias/family fallback, role/host and requested skills.
Plan exact edits and lock refresh. Preview candidate YAML and semantic mapping in
an approved isolated copy of only necessary project inputs, using the explicit
existing store. Preview installation writes only that owned preview lock. Compare
selected identities/hashes, raw task bytes, ordering, resources and native limits
against source v2 resolution. Do not compare whole JSON blindly: version/lock and
workflow provenance fields intentionally differ.

Present exact diff, source/candidate hashes, two write paths, context comparisons,
executed checks/gaps and rollback plan. Wait for explicit scoped approval. Recheck
inputs against that preview immediately before editing; refuse stale inputs.
Then apply only approved YAML edits and refresh the lock explicitly:

```sh
agent-profiles install --root /approved/project --store /approved/store --offline --json
agent-profiles resolve --root /approved/project --store /approved/store --model opus --role worker --host claude --json --contents
agent-profiles proof --root /approved/project --store /approved/store --model opus --role worker --host claude --json
```

Repeat real selectors from the approved context matrix. An existing lock1 cannot
authorize normal v3 resolution; the actionable refusal requires install. A frozen
install cannot perform conversion. Valid lock integrity does not establish workflow
readiness; fully specified use checks declared peers separately. Report protected
bytes and changed-file hashes, errors and all unexecuted checks. These commands are
instructions for the authorized migration operator, not evidence of execution here.

## 5. Same-semantic example

Prerequisites: owned `.agent-profiles/profiles/base.md` and
`.agent-profiles/roles/worker.md`, plus already imported valid portable skill trees
`@example/reviewer` at both 1.2.3 and 2.3.4 in the explicit store. Their entrypoints
have valid skill description metadata. Source v2 has been installed successfully.

```yaml
version: 2
default_profile: base
default_role: worker
models:
  opus: {profile: base}
families: {}
roles:
  worker:
    file: roles/worker.md
    skills: {required: [reviewer], available: []}
skills:
  reviewer: {package: '@example/reviewer', version: 1.2.3}
assignments:
  slim:
    when: {model: opus, role: worker, host: claude}
    versions: {skills.reviewer: 2.3.4}
```

Target is the identical document with `version: 3` and just this assignment
replacement:

```yaml
assignments:
  slim:
    when: {model: opus, role: worker, host: claude}
    bindings:
      skills.reviewer: {package: '@example/reviewer', version: 2.3.4}
```

After explicit lock refresh, opus/worker/claude still selects 2.3.4; other contexts
still select the default 1.2.3. Both versions remain stored. Task content/order is
unchanged and no companion is injected merely because it exists in either tree.
This example contains no claim of workflow compatibility. Parent/operator rehearsal
must use the real validators and owned fixtures; this document claims no executed
rehearsal or live consumer migration.

## 6. Failure, rollback, and idempotence

Malformed/mixed/unknown versions, unresolved backing, ambiguous assignments or
missing permissions stop before application. Already-v3 input is validated and
reported as a no-op; do not rewrite it, refresh its lock or adopt features without
new authorization. A newer version is refused, never guessed or downgraded.

On a partial attempt report which YAML/lock operation completed. Restore only this
attempt's files whose current bytes still equal its own written results; preserve
concurrent user edits and ask for reconciliation otherwise. Restore the owned
original YAML and original lock together when safe. Never delete immutable store
artifacts or overwrite source instructions. Caught-write safeguards do not promise
atomic crash recovery. An incomplete check is reported incomplete, not successful.

## 7. Completion checklist and exclusions

Confirm exact approved paths, final hashes, unchanged selections/content/unrelated
bytes, valid lock2 and real resolve/proof comparisons for the approved matrix.
Record tool identity and every check not run. No model/provider evaluation, host
activation, automatic authoring-tool installation, snapshot2, publication, Git
operation or global upgrade is included. Test fixtures are not live host proof.

## 8. Optional adoption and next adjacent step

Separately preview and approve [revision metadata](../revisions.md), explicit
`revision` pins and `workflow_links`. Both task and companion stay in the same
immutable tree. Requires/provides are named protocol declarations checked against
actual loaded peers, not inferred from release numbers or Markdown links. No next
configuration-version migration is currently defined.
