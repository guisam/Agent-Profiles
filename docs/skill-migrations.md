# Skill migration workspaces

This checkout implements **additional slices** of issue #21: start, status,
abandon, evidence-linked proposal import/list, explicit acceptance/rejection and
bounded immutable task-only candidate publication/readback, offline paired external evidence import/report
and explicit promotion of that candidate for its one evaluated role/model/host tuple.
It reuses the existing package store, raw-byte stamps and resolver. It
adds no runtime dependencies, compiler, repository-per-skill requirement, second
evaluated-content hash or automatic Git commits. The npm package is unpublished.

**This is not the complete migration lifecycle.** Actual package forks/lineage,
broader candidate targets/batches, provider execution, promotion of more than the
one evaluated tuple, session attribution/continuity and `explain` are not implemented yet.

Workspaces start directly from a current configuration version 3 project and its
lock2. The retained base of each assignment is an ordinary active stamp2 capture.
Selected profile, role and skill roots are taken by kind and binding, so
dependency-first package context and workflow companions are handled. The overlay,
status, proposals and candidate history all use that base. Workspace operations
preserve active package versions/hashes, configuration and lock. Nothing is converted,
downgraded or rebased automatically; any configuration change requires its own
preview and approval.

## Start an isolated workspace

From a trusted prepared checkout with Node.js 24 and dependencies installed:

```sh
node bin/agent-profiles.js migrate start --root /path/to/project --store /path/to/store --role reviewer --model example-model --host codex --sharing fork --json
```

Use an initialized project whose ordinary `resolve` works with that store. Supply
one explicit role, model and supported host (`claude`, `codex` or `hermes`). Model
aliases map to the configured canonical model for migration ownership. An unknown
explicit model uses ordinary resolver fallback; declaring it is not verification
that a session actually ran that model.

Choose `--sharing fork` to reserve only the primary assignment, or `--sharing
shared` to also reserve the discovered collateral assignments and capture their
base stamps. Both choices are explicit; there is no automatic shared mutation.
The choice is **recorded intent**, not publication of a fork or shared revision.
Only one open migration may reserve the same canonical role/model/host tuple.

Sharing discovery checks configured models plus the explicitly requested model,
all declared roles and supported hosts, matching selected exact package revisions
and portable local instruction paths (including available instructions). It is
not an exhaustive inventory of arbitrary unknown/family model identities, external
consumers or running sessions. Inventory validates configuration, locks, backing
and selected roots without requiring workflow readiness from uncaptured tuples.
Fork captures only the primary; shared also captures every discovered collateral
assignment. Every captured assignment must pass ordinary workflow checks before
any base stamp is written; an unready collateral therefore blocks shared start,
while remaining in fork's sharing inventory. An open migration on the same primary
tuple refuses before sharing discovery. Start changes no active assignments. Promotion
(below) changes only the one evaluated tuple and makes no claim about other
discovered sharers. Host-native references are not editable portable instructions.

Start writes a project record and editable copies under:

```text
.agent-profiles/migrations/<generated-id>/
  record.json                 # scope, sharing intent, bases, workspace inventory
  proposals.json              # imported advisory documents and outcomes, when present
  workspace/
    local/<repository-path>   # portable local profile/role/skill/resource bytes
    packages/<digest>/...     # complete selected immutable package copies
```

The returned JSON supplies `id`, the repository-relative `workspace`, `scope`,
`shared` binding reports, `collateral` and `bases`. Each base uses the existing full
stamp digest. Available portable instructions and declared resources are retained,
not just injected entrypoints. Root shared rules such as `AGENTS.md` remain in the
base stamp; they are not included as editable migration instructions.

Edit only the returned workspace when developing the migration. Original source
files, active `agents.yaml` and dependency lock remain unchanged. The ordinary
resolver continues using those active inputs, not the workspace. Workspace copies
are not hard links to the originals or store.

## Inspect changes

```sh
node bin/agent-profiles.js migrate status <generated-id> --root /path/to/project --json
node bin/agent-profiles.js migrate status --root /path/to/project --json
```

Status reads only local records/workspaces; it needs no store argument. Omitting
the ID lists all migrations, including abandoned records. No migration directory
is created by an empty listing. Output includes:

- `dirty: true`: this is a mutable development workspace, not a candidate stamp;
- `workspaceChanged`: whether file contents/membership differ from the initial copy;
- `changes`: sorted `added`, `changed` and `removed` relative file paths.

This is a structural content-change report, not a replacement for Git's text diff.
The command does not mint dirty stamps, run models, install host skills or execute
workspace content. Read-only status rejects malformed records and linked/special
workspace files rather than traversing them.

## Import and review an advisory proposal

One proposal describes **one existing selected UTF-8 workspace instruction**.
Its literal `before`/`after` strings are the diff; there is no patch parser.
No new files, binary/resource changes, package metadata, migration records, active
configuration or repository root rules can be edited by a proposal. Complete
package copies remain ordinary workspaces, not published forks.

Save a strict JSON v1 document such as this as `proposal.json`. This example
assumes the selected reviewer instruction is at the shown workspace-relative path
and currently contains exactly `# Reviewer` followed by CRLF. Replace the all-zero
digest with the actual motivating stamp from this migration's returned `bases`.

```json
{
  "proposalVersion": 1,
  "classification": "role",
  "target": { "path": "local/.agent-profiles/roles/reviewer.md" },
  "change": {
    "before": "# Reviewer\r\n",
    "after": "# Reviewer\r\nCheck boundary handling and retain evidence.\r\n"
  },
  "evidence": [{
    "sessionId": "caller-claimed-session-21",
    "excerpt": "The review omitted a boundary check.",
    "baseStamp": "0000000000000000000000000000000000000000000000000000000000000000"
  }],
  "draftCase": {
    "input": "Review a change at an input boundary.",
    "expected": "Identify the missing boundary check."
  }
}
```

All fields except `draftCase` are required, and unknown fields refuse. Evidence
must be a nonempty array of entries with nonempty `sessionId`, `excerpt` and
`baseStamp`. Every stamp must belong to this migration and its recorded assignment;
retained snapshot/package/blob backing is verified before importing or accepting.
Foreign, wrong or missing stamp bindings refuse. Session IDs and excerpts are
**caller-supplied claims**, not verified host/session attribution. No transcript is
read to authenticate them. Unattributed evidence without a retained base binding
is refused; explicit developer attribution support remains pending.

`draftCase`, if supplied, contains only nonempty `input` and `expected` strings.
It is retained as inert draft data: no runner, grader or evaluation result is
created. Instruction strings preserve UTF-8 bytes, BOM, CRLF and Markdown spaces;
NUL and invalid Unicode refuse.

| Classification | Allowed target and behavior |
| --- | --- |
| `role` | The selected role's instruction backing, including a package-backed role |
| `package` | A selected package's instruction entrypoint, never `package.yaml` or a resource |
| `model-specific` | The selected model-profile instruction, or an isolated package instruction under `fork` intent; any package target under `shared` intent refuses |
| `repo` | Retain a recommendation about an otherwise allowed profile/role/package instruction; explicit acceptance refuses and never edits the workspace or repository |

Import and list using the explicit migration ID returned by start:

```sh
node bin/agent-profiles.js migrate propose <migration-id> proposal.json --root /path/to/project --store /path/to/store --json
node bin/agent-profiles.js migrate proposals <migration-id> --root /path/to/project --json
```

Import is advisory and **does not apply** any workspace or active change. It retains
the original parsed document even if the import file is later removed. Output is
`{id, proposal, status, reason}`; the returned `id` is the proposal ID and status is
initially `proposed`, with null reason. Listing returns these records without
writes or store access; `--store` is irrelevant and refused for `proposals`.

## Explicitly accept or reject

```sh
node bin/agent-profiles.js migrate accept <migration-id> <proposal-id> --root /path/to/project --store /path/to/store --json
node bin/agent-profiles.js migrate reject <migration-id> <proposal-id> --reason "Keep the rule narrower" --root /path/to/project --store /path/to/store --json
```

Acceptance re-verifies retained bases, classification and safe selected paths, then
requires the current workspace file to match `before` **byte for byte**. A stale
workspace edit, removed file or substituted link refuses. It changes only that
instruction and records `accepted`, retaining the original proposal/evidence.
It does not activate assignments, alter sources/configuration/lock or rewrite the
immutable store. Inspect the resulting workspace with `migrate status`.

Rejection requires a nonempty reason, retains the original proposal/evidence and
records `rejected` without changing workspace bytes. Retained backing must still
verify, but rejection does not require the workspace to match `before`. Repeated
acceptance/rejection and exact duplicate imports refuse. Re-raising the same
rejected classification/target/change requires new evidence; changing only draft
data or evidence ordering is insufficient. Closed/abandoned migrations refuse
proposal writes while listing remains available. There is no implicit current
migration and importing never grants acceptance.

Operational `--store` overrides `AGENT_PROFILES_STORE`, then the ordinary default
store is used if neither is supplied. Keep the original store available for base
verification. All four commands support `--json` with no human header; omit it for
action-labelled text and record details. Operand counts and action-specific flags
are strict; repeated options refuse.

## Abandon without deleting evidence

```sh
node bin/agent-profiles.js migrate abandon <generated-id> --root /path/to/project --reason "Trying a narrower change" --json
```

A nonempty reason is required. Abandon updates the record to `abandoned`, releases
its assignment reservations and preserves workspace edits and retained base stamps.
Imported proposals, accepted/rejected outcomes and rejection reasons also remain.
It does not delete package objects, candidates or evidence. Running it again on a
closed record refuses. Normal Git commits of the desired project records remain
under developer control; transcript evidence should be reviewed for secrets before
any later publication.

## Write safety and incomplete operations

Start resolves the effective store (explicit argument, environment, then default)
and refuses a store equal to or inside the migration records or migration writer
directory before capture or writes. Keep retained backing outside those directories.

Start privately stages the complete workspace and record, checks copied bytes and
current configuration/local inputs, then publishes the directory by rename. A
caught pre-publication error removes the operation's staging lock; immutable base
stamps already captured may remain. Abandon uses a staged record replacement and
refuses an observed concurrent record edit. These checks are not a filesystem
sandbox or a claim of protection from a hostile same-user process.

Proposal writes reuse the project writer and stage/read back outcome data.
Acceptance stages the single instruction and original before bytes, publishes the
instruction, then publishes its accepted outcome. If a caught outcome-write failure
occurs after the instruction write, it restores before bytes only when the target
still contains this operation's after bytes and proposal history is unchanged.
Observed concurrent edits are preserved. Unsafe or failed compensation reports
`proposal acceptance incomplete` with the original error and compensation detail;
it does not return a successful acceptance. An outcome already published is kept
for inspection rather than silently undone.

These two file publications are **not an atomic crash transaction**. A process kill
can leave workspace and outcome out of step. On an incomplete error or interrupted
operation, inspect the workspace, retained proposal's before/after/evidence and
outcome with status/list before deciding any manual repair. Do not blindly retry,
overwrite intervening edits or treat an error as proof that no write occurred.

A project migration writer is exclusive. An existing
`.agent-profiles/.migration-writer` refuses another write. A killed process can
leave it behind: confirm that no migration writer is active, preserve/inspect the
staging content, then remove only that interrupted writer directory manually.
There is no automatic recovery/deletion command. Status remains read-only.

Local automated tests cover the API, CLI, raw bytes, sharing/reservations,
unchanged active inputs, workspace changes, abandon retention, links, intercepted
concurrent edits, copy mismatch and caught rename failure. The packed-artifact
smoke workflow also exercises start/edit/status/unchanged active content/abandon.
Proposal API/CLI cases cover advisory import, explicit outcomes, strict admission,
evidence/base validation and stale/target refusals. The packed workflow also uses
the installed executable for import/list/accept/reject and retained history.
Those are local filesystem tests, not live host attribution or model evaluations.

## Publish one advisory task-only candidate

This additional slice freezes one managed **skill package task** from an existing
fork-intent workspace. It does not evaluate, approve, release or activate it. Shared
batches, local role/profile targets, native targets, changed dependencies/workflow,
actual fork names/lineage remain unsupported; activating one evaluated tuple is the
separate explicit [promotion step](#promote-the-exact-evaluated-tuple).

Prerequisites are explicit. The current config3 project must have a fresh lock2,
and the target package binding must pin adopted revision metadata. Start the workspace
there and accept literal package proposals against its retained base, an active stamp2.
Separately capture the evaluation base with an ordinary `stamp` for the **same
role/model/host**. If active inputs are unchanged since start, it is the same digest as
the migration base. Both fields are still supplied and retained separately: one records
where the edit was authored, the other the evaluated active context. Publication
performs no preparation, conversion or rebase. A stale configuration or lock, or
missing metadata, refuses.

Supply strict JSON v1; replace every digest/id below with the actual retained value:

```json
{
  "candidateVersion": 1,
  "id": "reviewer-task-check",
  "binding": "skills.reviewer",
  "release": {"name": "@example/reviewer", "version": "3.0.0"},
  "migrationBase": "<owned-migration-base-active-stamp2-64-hex>",
  "evaluationBase": "<current-compatible-active-stamp2-64-hex>",
  "configSha256": "<current-lock2-configSha256>",
  "expectedTreeSha256": "<edited-workspace-package-whole-tree-sha256>",
  "proposalIds": ["proposal-<accepted-uuid>"],
  "workflowChange": {"kind": "task-only", "reason": "Retain the accepted task check; workflow remains unchanged."}
}
```

Use the existing `readPackage({root: workspacePackage}).sha256` for the expected
complete-tree digest, not a second content hash. The planned version must be a
new exact version of the same package name. Keep package.yaml unchanged: its old
embedded version is still inside the evaluated raw tree. All accepted workspace
changes must be explained by the listed accepted package history, in order, for
this one entrypoint; fresh digests and proposal-id membership alone are insufficient.
Companion, resources, metadata and every untargeted workspace file must be unchanged.

```sh
agent-profiles migrate candidate <migration-id> ./candidate.json --root ROOT --store STORE --json
agent-profiles verify <returned-stampDigest> --store STORE --json
```

The result contains `candidateVersion`, `id`, `migrationId`, planned `release`,
physical `content:{identity,sha256}`, `revisionDigest`, `stampDigest` and transient
`status:published|reused`. `migrationCandidate({storeRoot,id})` reopens the verified
committed index without a project. Equal replay verifies the same backing without
writes; changed replay cannot repoint that id. Text identifies the candidate and
outcome; JSON has no human header. Explicit `--store` overrides ambient selection.

The candidate retains complete accepted records, caller-claimed evidence, inherited
exact dependencies/workflow and a typed candidate stamp2. After mutable workspace,
project or source removal, historical reconstruction uses retained objects, metadata,
base stamps and blobs. Do not delete that backing ancestry. Ordinary package/revision
selection and dependency installation cannot activate the candidate; its planned
label is reserved against ordinary imports. Existing releases and independently
pinned consumers remain unchanged. A dirty workspace alone is never a candidate.

One canonical write-once `candidates/ids/<id>.json` is the publication commit. The
publisher verifies backing first and rechecks configuration, lock, workspace,
manifest and accepted history before that rename. A detected concurrent edit is
preserved and refuses publication. A caught failure before final-index rename leaves
no committed candidate; legitimate immutable backing may remain and is not rolled
back. Owned writer/staging cleanup does not promise power-loss durability, every
filesystem/race boundary or general transaction recovery. Inspect an interrupted
writer and retained evidence before manual repair; do not treat an error as proof
that no immutable backing was written.

Candidate publication is advisory retention, not compliance evaluation or verified
session/host/model attribution. Offline paired external result ingestion/reporting
and explicit single-tuple promotion are described below. No running-session
continuity or live activation is provided by this slice. Coordinator execution and
fresh independent whole-evidence review remain acceptance gates for this checkout's new code.

## Retain paired external evaluation claims

The local checkout implements offline plan/result v1 retention and a read-only report
for one retained candidate and its exact primary role/model/host/requested context.
It runs no harness, judge, grader, provider or model. The npm package is unpublished;
this is not completion of step3 or issue #21.

```sh
agent-profiles migrate plan <candidate-id> ./plan.json --root ROOT --store STORE --json
agent-profiles migrate results <plan-id> ./results.json --root ROOT --store STORE --json
agent-profiles migrate report <result-id> --store STORE --json
```

Writers use ROOT as a filesystem safety context; they do not start/reopen a workspace
or change active config, lock, defaults or assignments. The candidate's separately
recorded evaluation base remains the evaluated context. Rootless
report readback works from retained storage after project/source/input deletion.
Use explicit STORE to select the intended evidence independently of ambient stores.

Every field is required and unknown keys refuse. Plan JSON is:

```js
{planVersion:1,id,candidateId,candidateRevisionDigest,baseStamp,candidateStamp,
 context:{assignment:{role,model,host},requestedSkills:[],workflowPeers:{base:[],candidate:[]}},
 cases:[{id,kind,input,expected,target:{assignment:{role,model,host},binding,member,protocol}}],
 trials,conditions:{harness:{id,version,settings:{}},judge:{id,version,settings:{}},rubric:{id,version,settings:{}}}}
```

Use exact retained candidate index/revision/stamp and its original active evaluation
base (which may be the same digest as its migration base), not a current label. Context and peer arrays must equal
the captures. Cases require motivating and regression coverage, and workflow cases
for every actual required consumer/binding/member/protocol-major obligation. Kinds
are `motivating`, `regression`, `workflow` or `collateral`; `input` and `expected` are
literal nonempty text. Workflow targets use `protocol:{protocol,major}`; other targets
use null. Every target must be a real managed member of the selected/reached binding
closure on both sides. Collateral/peer cases observe the ONE primary paired trial;
they do not capture independent peer prompts or authorize promoting peer tuples.
Trial counts are positive safe integers with safely bounded case/side cardinality.
Harness/judge/rubric id/version/settings are fixed inert JSON claims for both sides.

Result JSON is:

```js
{resultVersion:1,id,planDigest,candidateRevisionDigest,
 conditions:{base:plan.conditions,candidate:plan.conditions},
 outcomes:[{caseId,trial,side,stampDigest,assignment:{role,model,host},correct,
   metrics:{costUsd,tokens,turns,toolCalls,latencyMs},evidenceRef}]}
```

Supply exactly one row per planned case/1-based trial/side (`base` or `candidate`),
with exact primary assignment and side stamp. Correctness is boolean. All five
metric keys are required: measured finite nonnegative numbers or explicit null for
unavailable. Tokens/turns/toolCalls are safe integers; cost is USD and latency is
milliseconds, allowing decimal JSON numbers up to MAX_SAFE_INTEGER. Invalid or
unsafe aggregate arithmetic refuses before publication. Signed finite decimal
settings are legal; they do not relax metric rules. `evidenceRef` is nonempty opaque
text, never fetched, opened, executed, graded or authenticated as runtime identity.

The report retains plan order, per-case pass counts/rates and exact complete/partial
metric coverage. Totals are null unless that side is completely measured; deltas
are null unless both sides are complete. Comparable-pair sums use only pairs with
both measurements, with explicit available/expected pair counts; zero available
pairs yields null sums. Any per-case correctness drop blocks default eligibility,
even with aggregate or efficiency gains. Equal correctness still reports efficiency;
slower metrics alone do not veto. No tolerance exists, and the report itself writes
no override or promotion; a recorded override belongs to the separate promotion decision.
Integrity/completeness/scope/conditions/backing/readiness failures refuse rather
than become waivable report findings.

Report evidence labels are `verified` managed integrity, `declared-compatible`
workflow, `external-claim` correctness, `unverified` runtime and `not-authorized`
promotion. Eligible means complete external claims passed the default correctness
gate only. Native invocation, host/system/tool prompts and model/session attribution
remain unverified; declared workflow compatibility is not observed compliance.

Exact canonical plan/result objects live at `evaluations/plans/sha256/<digest>.json`
and `evaluations/results/sha256/<digest>.json`, using the explicit evaluation codec
and the existing framed metadata hash in the two evaluation v1 domains. Write-once
id indexes at `evaluations/<plans|results>/ids/<id>.json` commit publication. Equal-id
exact reuse revalidates all data/backing without writes; changed data cannot repoint
an id. Reads/report recheck schema, hashes and captured relations, including a
rehashed result whose side-stamp relation is wrong. Historical evidence remains
inspectable after later plans/routes; future promotion must separately establish
live freshness and authority.

The named JSON source is one file, not a recursively copied parent. Actual files
inside destination store/owned writer boundaries and stores inside the protected
migration namespace/writer refuse. Ordinary sibling JSON/project/store layouts are
allowed. Original safely read input bytes remain commit guards; detected concurrent
edits are preserved. Complete canonical backing/index are staged and verified under
the store writer before the final index rename. Caught precommit failures have no
success index; valid immutable orphan backing may remain. A postcommit error reports
incomplete publication with retained index for inspection. These guards are not a
universal race, power-loss or recovery guarantee. No source repair occurs on read.

Programmatic entry points in `src/migrations.ts` are `planMigrationEvaluation`,
`migrationEvaluationPlan`, `importMigrationEvaluationResults` and
`migrationEvaluationReport`. Paired claims do not activate the reserved candidate;
only the explicit promotion below can. Broader forks/batches, session continuity and
all live/provider operations remain later separately bounded work.

## Promote the exact evaluated tuple

The local checkout implements read-only preview and explicit synthetic promotion of
ONE retained task-only candidate for ONLY the primary role/model/host of its paired
evidence. Collateral and workflow cases are observations inside primary trials; they
never authorize promoting a peer tuple. The npm package is unpublished; this is not
completion of step4 or issue #21.

```sh
agent-profiles migrate preview ./decision.json --root ROOT --store STORE --json
agent-profiles migrate promote ./decision.json --root ROOT --store STORE --json
```

The decision file is the retained decision record. Every field is required and
unknown fields refuse:

```js
{decisionVersion:1, id, resultId, candidateId, candidateRevisionDigest, planDigest, resultDigest,
 assignment:{role,model,host},   // exactly the evaluated primary assignment (canonical model)
 release:{name,version},         // exactly the candidate's planned label
 regressions:[{caseId,basePassed,candidatePassed,trials,reason:'per-case-correctness-drop'}],
 correctnessOverride:null | {gate:'per-case-correctness-drop', reason, cases:[caseId]}}
```

`regressions` must equal the retained report's rows exactly; it holds integers only,
and fractional rates stay derivable from `resultDigest`. Any per-case drop refuses by
default and names the case. A nonempty recorded `correctnessOverride` may waive only
that gate and must name exactly the regressed cases; the historical report still
shows them. An override with no regression refuses. Missing, foreign, mismatched,
duplicate or corrupt evidence, stale live state, a config2 project and unresolved
workflow are never overridable. No tolerance, rounding or efficiency veto exists.

Live freshness re-resolves the evaluated tuple with the current config3 project and
lock, and requires the retained evaluation base exactly: selections, workflow actors
and peers, loaded bytes and local inputs. Changed routing refuses promotion without
invalidating retained history. Configuration is never converted automatically.

Preview writes nothing. It returns `{status:'preview', decision:{id,decisionDigest},
gate:{status:'eligible'|'overridden',regressions,override}, release:{identity,content,
releaseDigest,state}, target}`. `target` names the assignment, binding, rule
`{id,when,action}`, and `before`/`after` binding sources. The ordinary resolver
selects the rule. If that rule pins the exact evaluated role, model and host, only its
binding is replaced. Any extra qualifier it carries, such as `profile`, already matched
the evaluated context, and its id and full `when` are kept. Otherwise one new rule with a
stable derived id is added. It keeps the selected rule's qualifiers and pins the exact
tuple, so the resolver selects it over every matching rule. The broader rule stays
unchanged. Before anything is written, the proposed configuration must pass the normal
schema and ambiguity checks. Shared defaults, other rules and other consumers keep their
exact pins. The decision assignment is still role/model/host only. The evaluated
profile is bound through the captured context and freshness, not a separate field.

Promotion publishes, in order and under the store writer: the canonical decision
object at `promotions/decisions/sha256/<decisionDigest>.json` (domain
`agent-profiles/promotion-decision/v1`), the typed
[release wrapper](revisions.md#promoted-release-wrapper-revisionversion-2), the
write-once decision index `promotions/decisions/ids/<id>.json`
(`{promotionIndexVersion:1,id,decisionDigest,releaseDigest}`), then the write-once
external label. It then edits only the exact binding through the existing guarded
YAML document edit (comments are preserved), refreshes lock2 through ordinary
install, and captures a fresh ordinary active stamp. That stamp must contain the
evaluated candidate's exact composition. The result is
`{status:'promoted'|'reused', decision, release, target, stampDigest}`.

The decision index commits the DECISION, not project promotion. A caught failure
before it leaves no index or label; valid immutable decision/wrapper objects may
remain as orphans that are never selectable. A failure after it, such as a label or
project-write error or a concurrent project edit, is reported as `partial/incomplete`,
never `promoted`. Concurrent user edits are preserved. The original validated
decision/config/lock bytes stay the guards. Reads never repair. Replaying the same
decision completes the remaining steps and reuses existing immutable bytes; replay
after completion returns `reused` without writes. An id or label can never be
repointed. A different decision for an already published label refuses. There is no
global rollback, crash or recovery guarantee. Stores inside the protected migration
namespace and decision files inside the store refuse.

`migrationPromotion({storeRoot,id})` is the rootless readback. It revalidates the
decision, its evidence relations and public release admission. Programmatic entry
points are `previewMigrationPromotion`, `applyMigrationPromotion` and
`migrationPromotion`. Promotion leaves the migration record open; close, abandon and
iteration semantics, multi-tuple and collateral promotion, workflow-change candidates,
fork naming, session continuity and live consumers remain later work. Correctness
stays an external claim and runtime stays unverified.
