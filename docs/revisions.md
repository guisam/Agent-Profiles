# Legacy release metadata adoption

Metadata adoption records explicit declarations around an already published
immutable local package. Config3 separately opts into their selection/composition
and checks. Recording alone does not publish new instruction bytes, evaluate a
model, activate a workflow or complete issue #21.

```sh
agent-profiles revision record ./reviewer-revision.json --store /path/to/store --json
```

`--root` is optional and identifies the CLI repository context. The manifest path
is relative to the working directory, as with ordinary file arguments. `--store`
overrides `AGENT_PROFILES_STORE`; no project initialization is required. Text output
identifies the recorded revision; JSON contains only the result object.

## Record format

Supply strict UTF-8 JSON, without a BOM, duplicate keys or unknown fields. Replace
the digest below with the existing package's actual complete-tree digest. Every
shown field is required.

```json
{
  "revisionVersion": 1,
  "identity": {"name": "@example/reviewer", "version": "1.2.3"},
  "kind": "release",
  "content": {
    "identity": {"name": "@example/reviewer", "version": "1.2.3"},
    "sha256": "<existing complete-tree SHA-256>"
  },
  "parent": null,
  "candidate": null,
  "dependencies": [],
  "workflow": {
    "file": "WORKFLOW.md",
    "provides": [{"protocol": "@example/agent-checkin", "major": 1}],
    "requires": []
  },
  "provenance": {
    "kind": "legacy-adoption",
    "workflowChange": {
      "kind": "initial",
      "reason": "Declare the existing check-in interface; no new evaluation is claimed."
    }
  }
}
```

The identity must exactly match `content.identity`, the existing legacy identity
mapping and the v1 `package.yaml` inside the fully verified tree. The version in
that payload is still hashed. Adoption changes neither its identity nor any tree
byte. External metadata does not remove the embedded v1 identity or permit a label
to refer to another package name/version.

`workflow` must be explicit:

- `null` records unknown compatibility.
- `{"file":null,"provides":[],"requires":[]}` declares no interface.
- A nonnull `file` names a distinct existing portable Markdown companion, even if
  both interface lists are empty. It cannot be the entrypoint or metadata; managed
  instruction delivery, valid UTF-8 and no NUL are required. Missing files, path
  escapes, links and hard links refuse.

Each interface is exactly `{"protocol":"@namespace/name","major":1}` with a
positive safe integer major. Repeated protocols within either list refuse.
Package release major and protocol major are independent declarations: release
`2.3.4` may still declare check-in major 1. These are author assertions, not proof
that a host loaded the companion or a worker obeys it.

Each dependency is exactly
`{"name":"@example/shared","version":"1.0.0","sha256":"<tree digest>","revisionDigest":null}`.
A nonnull `revisionDigest` pins existing adopted metadata. Adoption verifies every
legacy identity/tree and recursively verifies referenced metadata and its closure;
missing, conflicting, duplicate or cyclic declarations refuse. One closure has
one exact identity/metadata choice per package name. There is no version solver.
Recording dependencies does not install or inject them into legacy context.

## Immutability and replay

The synchronous API is
`retainRevisionManifest({storeRoot, manifestFile})` from `src/revisions.js`.
It returns exactly `{identity, sha256, recordDigest, status}`. `sha256` is the
unchanged v1 tree digest. `recordDigest` is the existing canonical record hash
under `agent-profiles/revision/v1`, not another evaluated-content hash.
`status: "published"` means metadata was newly retained; it makes no new evaluation
or release-publication claim. Identical replay returns `"reused"`, after verifying
all backing again, without writes. Same label with different metadata or tree
refuses; an existing label is never repointed.

Records live at `revisions/sha256/<recordDigest>.json`; write-once labels live under
`revisions/labels/<encoded namespace>/<encoded name>/<version>.json` in the existing
store. `lookupRevisionManifest({storeRoot, recordDigest})` returns the verified
record and verifies the complete declared backing closure. Neither API changes
legacy `lookupPackage`, configuration, locks, stamps or normal selection.

Published versions such as 1.2.3, 1.4.5 and 2.3.4 remain side by side. Existing
exact assignments still select each independently; metadata adoption causes no
global upgrade or implicit opt-in.

Validation finishes before store writes. Publication reuses the store writer lock,
private staging, flushed writes/readback, and guarded write-once publication. A
caught failure can leave verified immutable orphan records or a committed label;
it does not delete published artifacts or claim atomic crash recovery. Inspect an
interrupted writer before using existing explicit store recovery, then replay the
identical manifest. Do not edit labels or trees to repair an error.

## Config3 selection and workflow checking

Old v1/v2 references remain unchanged after adoption. In config3, opt in with the
exact source `{package, version, revision: <recordDigest>}`. Each assignment uses
`{when, bindings}`; its binding value is a complete replacement source, including
package name/version and optional revision. Omitting revision selects legacy
behavior even if the default source pins metadata. No version ranges or global
upgrades are introduced. See the [base conversion guide](migrations/config-v2-to-v3.md)
and [copyable approval-first prompt](migrations/prompts/config-v2-to-v3.md).

For example, after separately recording three existing releases, exact assignment
bindings can keep local-llm on 1.2.3, opus on 1.4.5 and slim-llm on 2.3.4, each with
its own record digest. Changing slim-llm's pin affects only matching selectors; all
old objects and labels persist. Same-version references with different package
names or metadata digests are distinct.

Explicit links have this YAML shape; every peer's role/model must be declared and
host known. Bindings must name actual configured package bindings whose selected
sources pin their previously retained exact records:

```yaml
workflow_links:
  checkin:
    protocol: '@example/agent-checkin'
    consumer:
      assignment: {role: coordinator, model: opus, host: claude}
      binding: skills.orchestrator
    providers:
      - assignment: {role: worker, model: local-llm, host: claude}
        binding: skills.reviewer
      - assignment: {role: worker, model: opus, host: claude}
        binding: skills.reviewer
      - assignment: {role: worker, model: slim-llm, host: claude}
        binding: skills.reviewer
```

An active consumer requires the protocol/major in its retained declaration. Each
explicit provider must supply that same major through its actual required loaded
closure. Merely available skills, missing links, unknown metadata, mismatched
majors and conflicting providers refuse fully specified use. Multiple separate
worker actors are valid; multiple distinct providers within one actor cannot win
by order. Peer actors use required context only; caller-requested extras cannot
silently qualify them. Worker instructions are checked, never injected into the
orchestrator. Doctor checks explicitly linked actors and reports unspecified actor
readiness as unverified; bounded inspection does not claim metadata validity.

Selected/requested managed packages load their exact dependencies first, then task
and declared companion as distinct raw-backed context parts. An identical package
identity/content/metadata repeats once in one actor; conflicting pins within that
actor refuse. Different actors may select different releases. Required companions
count in proof totals and text output even with empty interfaces. Unrequested
available companions and declared resources remain unloaded. Native prerequisites
cannot be injected; this v3 composition refuses them with an invocation-unverified
diagnostic rather than silently dropping them.

Explicit dependency install emits lock2/configurationVersion3/resolver-v3, nullable
revisionDigest per default/rule pin and sorted revisionDigests per retained package
identity in the complete declaration closure. Normal v3 use requires that contract,
verifies real records/labels/trees and refuses stale/mismatched locks. Nonfrozen
install may refresh lock1 during approved conversion; frozen install cannot. Old
v1/v2 behavior uses its old contracts. Lock integrity is separate from readiness:
installing a structurally sound incompatible graph can succeed, but fully specified
resolve/proof must refuse before returning context. No background acquisition or
implicit metadata adoption occurs. Preview/apply retains the explicit store; preset
schema1 import/export refuses config3 instead of flattening its semantics.

Compatible fully specified output reports `declared-compatible`, runtime
`unverified`, and exact consumer/provider assignment/binding/record pins. Missing
identity, metadata-only inspection or unknown selected declarations do not assert
readiness. These checks are not host loading, invocation or model obedience proof.

## Workflow-aware managed snapshots

Config3 opts into `stampVersion:2`, `configurationVersion:3` and the existing
record-hash primitive with domain `agent-profiles/stamp/v2`. Config1/2 continue
using stamp1 and its original domain/serialization; recording metadata does not
change old pins or opt them into workflow declarations.

The existing `stamp`, `verify`, `diff` and filesystem `materialize` commands need
no new flags. Keep the explicit store and actual role/model/host selectors:

```sh
agent-profiles stamp --root /path/to/project --store /path/to/store --role worker --model opus --host claude --json
agent-profiles verify <full-stamp-digest> --store /path/to/store --json
agent-profiles materialize <full-stamp-digest> --root /path/to/project --store /path/to/store --adapter filesystem-v1 --output-root /path/to/owned/exports --destination /path/to/owned/exports/capture --json
```

Stamp2 supports active and bounded typed candidate captures: active `capture` is
`{"kind":"active","migration":null,"candidate":null}`; the candidate variant is described below. It retains ordered raw
task/companion bytes, direct selectors and logical alias uses, original physical
owners, declared local resources, observed shared files, exact nullable/adopted
package pins and complete immutable trees. Dependency-first instruction parts are
not assumed to follow two fixed profile/role positions. Shared instruction backing
is not charged or emitted twice merely because two configured names select it.

A revision catalog binds canonical retained records to their exact trees. Primary
`selectionBindings` include actual required/requested roots even without a known
host/model. Separate required-only `workflowActors` retain canonical assignments,
selected profiles, actual roots and dependency closures for every reached actor.
Thus an optional request cannot become a required peer. Native roots remain
separate from their managed providing dependencies, and peer rows bind the actual
requiring/providing revision and named protocol major to the selected actor binding.

Historical reconstruction validates canonical record digests, strict schemas,
complete tree bytes, dependency membership/order, selectors, physical composition,
root declarations and peer/coverage relations using retained backing. It needs
neither mutable project/source/manifest files nor current registration labels or
routing. Missing/corrupt backing refuses; a rehashed snapshot selecting a different
otherwise-valid peer record still fails its captured selection relation. These
checks are internal consistency, not authentication if someone replaces every
relation, backing and digest together.

Filesystem export includes `content/snapshot.json`, actual ordered instruction
bytes, resources/shared files, one full package tree per SHA and the exact canonical
metadata bytes at `content/revisions/sha256/<recordDigest>.json`. Record mappings
use `sourceKind:revision`, logical `sourcePath:record.json`, and null package digest;
no original absolute source/home/store path is embedded. The existing filesystem-v1
plan/receipt domains, absent-destination guards, staging/readback, ownership,
verification and explicit recovery boundaries remain. Caught errors are reported;
this does not promise atomic recovery from every crash or hostile same-user process.

Managed reproducibility is separate from host invocation or model compliance.
Native and peer package trees/metadata are retained as evidence, never injected as
native/peer context into the primary consumer. Host invocation/rendering and runtime
identity remain unverified, including native peer roots not listed in the primary
host-reference inventory. Unknown declarations remain unknown. No host hook is
installed or activated, and `nativeReady:true` reconstruction still refuses.

## Deferred boundaries

This is an additional local foundation slice under coordinator qualification,
not completion of issue #21 or publication. Broader candidates, actual fork lineage,
live evaluation, multi-tuple promotion, session attribution and host adapters remain
pending; offline evidence and single-tuple promotion are described in
[skill migrations](skill-migrations.md#promote-the-exact-evaluated-tuple). No provider evaluation or live host/model proof is claimed by fixture,
installed-artifact or managed-byte checks.

## Typed candidate metadata (revisionVersion 2)

The [task-only candidate slice](skill-migrations.md#publish-one-advisory-task-only-candidate)
adds a distinct immutable record, not a conversion of adopted release records:

```js
{revisionVersion:2, kind:'candidate', identity:plannedRelease,
 content:{identity:embeddedLegacyIdentity,sha256:exactEditedWholeTree},
 parent:adoptedReleaseDigest, candidate:candidateId,
 dependencies:unchangedExactParentPins, workflow:unchangedParentDeclaration,
 provenance:{migrationId,binding,migrationBase,evaluationBase,configSha256,
   expectedTreeSha256,proposals:completeAcceptedRecords,
   workflowChange:{kind:'task-only',reason}}}
```

Canonical metadata uses `agent-profiles/revision/v2` and the existing
`revisions/sha256/<recordDigest>.json` storage. This metadata digest is not another
instruction-tree checksum. The immutable tree still contains its old name/version
inside package.yaml; `content.identity` verifies that actual manifest. The planned
external `identity` does not rewrite it. Old tools refuse the new record/capture
variant; existing revision-v1 labels, readers and complete-tree identities remain
strict and unchanged. `revision record` continues accepting legacy adoption only.

Historical candidate reading verifies canonical bytes/domain, exact parent backing,
literal accepted task replay, unchanged companion/resources/metadata and declared
dependency closure. Its stamp2 uses
`{kind:'candidate',migration:migrationId,candidate:recordDigest}` and checks exact
base/selection, primary logical bindings, reached actors and workflow peer relations.
Active stamp2 and stamp1 retain their existing contracts. Reproduction needs retained
backing ancestry, not mutable configuration/source paths or current release labels.

The final candidate index is the only reservation/commit record; no legacy identity
mapping or selectable release label is created. Normal revision lookup/closure and
install explicitly refuse unpublished candidates. Multiple immutable candidate ids
can reserve the same still-unpublished planned version, but no id may be repointed.
Published versions continue coexisting independently. Publication is neither an
evaluation nor a correctness override or promotion decision. The candidate record
itself stays unselectable; a promoted release (below) references identical evaluated
content without a rebuild. Host/runtime compliance and attribution remain unverified.

## Promoted release wrapper (revisionVersion 2)

[Promotion](skill-migrations.md#promote-the-exact-evaluated-tuple) adds a second
typed variant. It is a new immutable record, not a conversion of candidate or v1
records:

```js
{revisionVersion:2, kind:'release', identity:plannedRelease,
 content:candidate.content, parent:candidate.parent, candidate:candidateRevisionDigest,
 dependencies:candidate.dependencies, workflow:candidate.workflow,
 provenance:{kind:'promotion', decisionDigest}}
```

Content, parent, dependencies, workflow and the logical identity must equal the
evaluated candidate record exactly. Its digest (`agent-profiles/revision/v2`) differs
only because it carries approval provenance. There is no second content hash. The
tree is the evaluated candidate tree; its package.yaml still names the old embedded
version, and `content.identity` verifies that physical manifest. No legacy identity
mapping is created, so `lookupPackage` for the external label stays empty, and
ordinary imports cannot claim the label.

Raw reading verifies the record, tree, companion, candidate relation and the
canonical decision object it names. That is integrity only. Public admission
(`lookupRevisionManifest`, config3 resolution and dependency install) also requires
the write-once label and the committed decision index
`promotions/decisions/ids/<id>.json` to bind this exact wrapper digest. An orphan
wrapper whose index commit failed is never selectable, even if a different decision
later publishes the same label. Config3 selects it with the ordinary exact source
`{package, version: plannedVersion, revision: wrapperDigest}`. Lock2 records it like
any other pinned identity (`source: {type: provided}`). Active stamp2 captures read
the physical tree through `content.identity`.

Old tools refuse this record kind. `revision record` still adopts legacy v1 releases
only, and revision-v1, candidate records, legacy labels and existing complete-tree
identities keep their strict behavior. Old immutable records are not migrated, and
no adjacent conversion guide is needed for this new record kind.
