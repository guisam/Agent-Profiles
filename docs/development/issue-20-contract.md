# Issue 20: proposed package, lock, stamp, and materialization contract

> Current checkout status (P9b): P2–P9a implementation and the finite P9b test
> contract were parent-accepted. Configuration v2 validation and the six public
> package/stamp commands are implemented; version 0.1.0 remains unpublished.
> [Current package workflow](../versioned-packages.md) and
> [migration guide/prompt](../migrations/README.md) supersede historical statements
> below that v2/tool validation is unavailable. This P1 proposal/decision history
> remains intact; historical permissions/gates are not current execution authority.
> Artifact/platform qualification and final whole-solution independent review
> remain pending. Documentation authorship is not parent acceptance of its result.

Status: **PROPOSED — parent contract assessment required before RED or GREEN.**
Assignment: I20-P1-SOL. Source baseline: `f6ac1c4d7336bbb077d2ba089ffe6937ef6c0caa`.
This document proposes policy; kickoff approval did not approve these schemas.
Its companion [requirement-to-test map](issue-20-test-map.md) defines observable offline acceptance cases.

## 1. What a developer should be able to do

Import two local directories containing different releases of one skill. Keep both
unchanged in a verified local store. Choose a release using the existing model and
role resolver. Lock every declared package pin, capture the selected managed bytes,
and later verify, reconstruct, compare, and export that snapshot into a new isolated
directory without rereading mutable project instructions or switching Git revisions.

The export is ordinary filesystem output, not a launched or host-invocable plugin.
Package integrity, managed snapshot reproducibility, materialized output integrity,
host compatibility, and runtime invocation are separate results. A selected model
identity is routing input, not evidence of the model actually executing a task.

### Governing baseline and deliberate changes

[CONTRIBUTING](../../CONTRIBUTING.md) governs development. The current
[architecture](../architecture.md) governs existing version-1 behavior; this proposal
cannot silently amend it. Relevant implemented seams:

- [resolve.js](../../src/resolve.js): strict configuration validation, model/alias/
  supplied-family/longest-prefix/default routing, independent role selection, required
  then requested instruction order, and native/injected delivery separation.
- [files.ts](../../src/files.ts): guarded paths and rollback after caught errors;
  **not** an immutable concurrent store publication protocol.
- [configure.ts](../../src/configure.ts) and [presets.ts](../../src/presets.ts):
  preview through the resolver, then stale-input checks before mutation.
- [diagnostics.js](../../src/diagnostics.js): decoded-text accounting and presentation;
  `.trim()` presentation and UTF-8 decoding must not become snapshot backing bytes.
- [skills.js](../../src/skills.js), [wizard.ts](../../src/wizard.ts),
  [inspect.js](../../src/inspect.js), [install.js](../../src/install.js), and
  [CLI](../../bin/agent-profiles.js): consumers requiring compatibility changes.

**D1 accepted, with the maintainer's later clarification:** use configuration
**version 2** for package-enabled projects. The maintainer has one current consuming
project, but every configuration schema transition must still provide a documented
**vN → vN+1 migration path**, a consistent migration-guide format, and a companion
prompt an AI tool can use to perform that bounded migration when needed. Deliver
v1 → v2 guidance and its prompt with this issue, and require the same artifacts for
future configuration-version increments. This supersedes the earlier inference that
having one project removed the need for a migration path.

The guide/prompt must specify prerequisites and supported CLI versions, exact changes
and preserved semantics, explicit choices that cannot be inferred, preview/approval,
validation, rollback, and incomplete/failure handling. An AI-assisted edit is optional,
not automatic execution or proof of correctness. No automatic schema change on read;
no unrequested model calls, package imports, host edits, Git publication, or implicit
selection of package revisions. A general automatic migration engine is not required
by this clarification. Retain existing version-1 behavior/tests; old executables reject
version 2 rather than misread package bindings.

Configuration-document version history remains a future requirement beyond these
migration artifacts; its broader history/comparison/upgrade interfaces are not silently
implemented by package locks or profile stamps.

The adjacent-documentation slice supplies the [consistent migration pattern](../migrations/README.md),
[adjacent v1 → v2 guide](../migrations/config-v1-to-v2.md), and
[copyable AI-tool prompt](../migrations/prompts/config-v1-to-v2.md).
Base conversion changes only the version scalar, preserving routing, ordering,
local/native bindings and instruction bytes; package adoption is separately approved.
V2 preview/post-edit/no-op validation is implemented in this checkout; verify the selected local tool before application, independently of publication. That original documentation slice did not itself accept D3–D6 or certify the independent recheck; see the current status annotation above.

## 2. Package format and portable tree (C01–C04)

### Identity and manifest

One package exports one Markdown entrypoint and any number of supporting files.
`@namespace/name@version` is display syntax; internal fields remain separate.
Namespace and name each match `[a-z0-9][a-z0-9-]*`. Version initially matches
`(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)`, with each component at most
`9007199254740991`. No ranges, tags, prereleases, build metadata, transitive dependency
solver, or publisher authentication. Exact pins are enough for this issue; a label is
not integrity or endorsement. Digest fields are 64 lowercase hexadecimal characters.

A required UTF-8 `package.yaml` has this complete illustrative manifest:

```yaml
schema_version: 1
package:
  name: "@example/security-review"
  version: "2.0.0"
  type: skill
  description: Review application changes for security defects.
  license: Apache-2.0
entrypoint: SKILL.md
behavior:
  delivery: instruction
  hosts: []
  effects: []
```

Required keys are exactly those shown, except `package.description` and
`package.license` are optional nonempty descriptive strings. `type` is `skill` or
`instruction`. `entrypoint` names an existing regular `.md` file. Skill metadata
uses the existing bounded frontmatter reader (description required); instruction
packages need no skill frontmatter. An instruction package can back a model profile
or role without introducing a second package system. All mappings reject duplicate
and unknown fields; all scalars have exact types. YAML warnings, multiple documents,
merge keys, custom tags, and aliases/anchors in new package manifests are rejected.
Manifest parse rules and raw manifest hashing are distinct: changing a comment
changes the package digest even when parsed metadata stays equal.

### Executable and native surfaces

`behavior.delivery` is `instruction` or `native`. Native delivery is allowed only for
skill packages, with a nonempty duplicate-free `hosts` list of existing integration
IDs. Instruction delivery requires `hosts: []`. `effects` is a duplicate-free list
from `commands`, `substitution`, `external-references`, `host-configuration`.
These are **publisher declarations of possible behavior**, not security approval,
complete static detection, or proof of safe execution. Instructions with no declared
effects are not certified harmless.

Manifest install scripts, lifecycle hooks, dependencies with callbacks, and unknown
keys are always rejected. Supporting scripts and binaries may be archived as inert
bytes. No package code, shell substitution, hook, plugin, or subprocess is executed
by acquisition, validation, hashing, resolution, stamping, verification, diff, or
filesystem export. A resource file with a script suffix is not an installation hook.
For native packages, known entrypoint frontmatter keys `hooks`, `allowed-tools`,
`model`, `effort`, `context`, or `agent`, and tree paths under `.claude-plugin/`,
`hooks/`, or `.mcp.json` require `host-configuration`. For this bounded native lint, inspect the parsed
entrypoint frontmatter within the existing 64 KiB boundary and its complete UTF-8
body. Body recognizers are: `!` immediately followed by a backtick, or a line
beginning with three backticks followed by `!` (commands); literal `$ARGUMENTS` or
`${` followed by one or more ASCII letters/digits/underscore/dot and `}`
(substitution); and a line beginning with `@` followed by a nonwhitespace token
(external-references). Apply the recognizers literally even inside prose examples;
false positives require declaration rather than an exception. Native manifests
missing a corresponding effect fail with the effect and relative entrypoint path.
These exact small recognizers are conservative signals, not a universal host parser
or proof that undeclared executable behavior is absent. Instruction delivery
copies/injects text, never evaluates such syntax. No automatic
native-to-instruction conversion. A future native adapter must independently inspect
and reject unsupported declared/observed effects before deployment. Reference output
can preserve any declared effects as inert data; it cannot mark them executable-safe.

### Tree membership and path policy

All regular files below the explicitly selected package root are members, including
hidden files and `package.yaml`; there is no ignore-file, suffix, or manifest allowlist
that can omit a supporting resource. Reject `.git` path components; point at a package
subdirectory in an already-existing Git checkout, not the checkout's metadata root.
Git is provenance, never acquisition by checkout/fetch during these operations.
Empty directories are ignored and not reconstructed; nonempty directories are implicit
in member paths. Permissions, executable bits, timestamps, owner IDs, and physical
hard-link identity are not hashed and are not promised to be restored. Reject symlinks,
junctions/reparse links, hard-linked regular files (`nlink > 1`), devices, pipes, and
sockets rather than following them. Canonicalize the explicitly approved existing
root with `realpath` once; ancestor links above that canonical approval boundary are
not traversed again or rejected (for example a platform's `/var` alias). Reject links
at or below the canonical root, including an explicitly linked package root supplied
as a child of an approved source boundary. This rule also bounds repository, store,
and output-root link checks; it does not relax checks on descendants or escapes.

Canonical relative paths use `/`; each component consists only of ASCII letters,
digits, `.`, `_`, and `-`. Components may not be empty, `.` or `..`, end with a dot,
or equal a Windows reserved device basename (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`,
`LPT1`–`LPT9`, case-insensitive, including before an extension). Reject absolute paths,
drive/UNC forms, backslashes, colon/alternate streams, controls, Unicode filenames,
and file/directory prefix collisions. Reject ASCII-case-folded collisions at every
component, including two directory spellings whose leaf names differ. Never repair
or normalize a rejected path. Sort accepted full paths by unsigned UTF-8 byte order,
not locale sorting. ASCII-only names sacrifice some author convenience to avoid a
Unicode normalization/case-folding dependency and ambiguous cross-platform identity.
Original bytes may be arbitrary binary; entrypoint and manifest must decode as strict
UTF-8 (BOM allowed and retained). Do not normalize line endings or text.

Source reads use no-follow checks, open-file identity checks before/after read, and a
second membership/metadata scan. Any changed membership, type, size, or read identity
aborts; staged copied bytes are then independently rehashed. This detects ordinary
concurrent edits, not an adversarial same-size in-place rewrite with forged metadata.
The published identity always names the copied bytes, not a source Git commit alone.
An expected digest supplied by the caller must match those copied bytes.

## 3. Canonical hashing framing (C03, C10, C14)

Define `U64(n)` as eight unsigned big-endian bytes; lengths/counts must be nonnegative
safe integers. `B(x)` is raw bytes; UTF-8 strings are strictly encoded. No delimiters
are inferred from text and no trailing bytes are permitted.

For an ordered tree of regular files:

```text
TREE(domain, files) = SHA256(
  UTF8(domain) || 0x00 || U64(fileCount) ||
  concat, in byte-sorted path order:
    0x46 || U64(pathByteLength) || UTF8(relativePath) ||
    U64(contentByteLength) || rawContentBytes
)
```

Package domain is `agent-profiles/package-tree/v1`. Raw single-file backing blobs
use ordinary `SHA256(rawBytes)` with byte length stored beside the digest. Manifest,
resources, and zero-byte files all participate. Whole-tree deduplication includes
the manifest; identical bodies with different names/versions are different trees.
Identical published bytes at different machine roots have identical package hashes;
LF and CRLF publications intentionally do not.

For generated structured records, define `J(value)`:
null/boolean/string/safe-integer/array/plain-string-key-object only; reject duplicate
keys, negative zero, nonintegers, nonfinite numbers, unpaired UTF-16 surrogates, and
unknown fields. Object keys sort by unsigned UTF-8 bytes. Preserve array order.
Emit compact JSON with no BOM, whitespace, or final newline. Strings escape quote
and backslash, emit U+0000–U+001F as lowercase `\u00xx`, and emit other Unicode as
UTF-8, including `/` literally. No Unicode normalization. This is a specified local
canonical encoder, not an unspecified `JSON.stringify` or YAML serializer.
When parsing generated JSON records, numeric tokens must use plain decimal integer
syntax (`-?(0|[1-9][0-9]*)`), before conversion to JavaScript numbers; fractional and
exponent spellings are rejected even when rounding would yield a safe integer.
`canonicalJSON(number)` still accepts ordinary safe-integer JavaScript values.
Package `schema_version` requires YAML integer type and value 1; valid YAML integer
spellings remain supported. These new-format rules do not change legacy agents.yaml
parsing.

```text
RECORD(domain, value) = SHA256(
  UTF8(domain) || 0x00 || U64(byteLength(J(value))) || J(value)
)
```

Domains: `agent-profiles/config/v2`, `agent-profiles/lock/v1`,
`agent-profiles/stamp/v1`, `agent-profiles/materialization-plan/v1`.
Materialized content uses TREE with domain `agent-profiles/materialized-tree/v1`.
Separate digests must not be substituted for one another. Each future implementation
gets independently computed golden vectors, including empty/binary/Unicode records,
framing ambiguity, path order, and changed-resource controls.

## 4. Offline acquisition and immutable local store (C05–C07)

Proposed store root: explicit API `storeRoot` / CLI `--store`, then
`AGENT_PROFILES_STORE`, then `path.join(os.homedir(), '.agent-profiles', 'store')`.
Reject blank/nonlocal/linked roots. It is a configurable operational location, never
part of canonical package, lock, or stamp identity. The store is writable local
storage with corruption detection, not a tamper-proof vault or authenticity service.

```text
store/
  objects/sha256/<packageDigest>/tree/<all package files>
  identities/<E(namespace)>/<E(name)>/<version>.json
  blobs/sha256/<rawBlobDigest>
  stamps/sha256/<stampDigest>/snapshot.json
  .staging/<random-operation-id>/
  .writer-lock/owner.json
```

Generated identity components use `E(s) = "x-" + lowercase hex of UTF8(s)` (two hex
digits per byte, no separators). Decode only canonical `x-` hex spellings; reject
odd-length/nonhex or invalid UTF-8 and require re-encoding equality. This injective,
reversible encoding is used for namespace/name, logical available-skill IDs, and
qualified resource-binding IDs, never for already-validated tree member paths.
For example `con` becomes `x-636f6e`, `nul` becomes `x-6e756c`, and `skills.con`
becomes `x-736b696c6c732e636f6e`. Logical IDs/package names remain unchanged in
records and comparisons; do not reject accepted legacy IDs to make generated paths
portable. A generated component exceeding the actual backend's length limit fails
with a path-length diagnostic before publication, never truncation/collision.

Identity record is exactly `{identity, sha256}` where `identity` is the structured
`{name, version}` pair. Object directories contain only `tree/`; identity metadata
and receipts are not package-tree members. Package lookup requires a complete identity
record and verified tree, not directory existence. Blob and stamp objects follow the
same immutable publication rules. Creation time, source absolute paths, process IDs,
and optional Git provenance belong in unshared receipts, not hashed snapshots.

`importPackage({sourceDirectory, storeRoot, expectedDigest?})` imports a directory
only. No URL, archive extraction, remote discovery, fetch, Git checkout, npm command,
or host installation. An existing local Git checkout is an ordinary source directory;
optional recorded provenance is `{type: git, repository, commit, subdirectory}` using
a full observed commit ID, not a claim that Git bytes equal package bytes. Git records
are informational and never an authorization to download. No scripts run to discover
version or provenance. Source paths remain in local receipts. Same-version/different-
digest is an identity conflict even if the package body appears semantically equal.

### Cooperative publication protocol

1. Validate source and destination boundaries before reads/writes; acquire exclusive
   `.writer-lock` with atomic directory creation. A busy writer fails with `store-busy`
   (caller may explicitly retry); readers take no writer lock.
2. Create unique private staging on the same filesystem. Copy full files, revalidate
   staged membership/manifest, compute digest, and verify expected digest if present.
3. Under the writer lock, read the existing identity mapping. Same digest: reverify
   its complete tree and return reused. Different digest: fail `identity-conflict`.
   Existing corrupt mappings or trees fail; do not overwrite, silently repair, or
   treat corruption as a cache miss.
4. Publish a complete verified object with same-filesystem directory rename into an
   absent digest destination. Existing objects must verify equal; no replacement.
   Flush written files before rename where supported. Readers only consider final
   names, never `.staging`. Different processes with the same content deduplicate.
5. Write complete identity JSON with exclusive creation (mode 0600 where supported)
   as `identity.json` in the same private `.staging/<random-operation-id>/` directory,
   flush/close, then, holding the writer lock, require an absent identity target whose
   parent shares the staging device, and rename that file (not the step-4 object
   directory) into it. Readers never see staging; explicit recovery removes it. This
   mapping is the publication commit point. Reuse verifies both mapping and tree.
   Release own lock.

This relies on atomic same-filesystem rename and cooperating writers on a supported
local backend. Reject known nonlocal/UNC roots, observed staging/final device mismatch,
or rename errors `EXDEV`/`ENOTSUP`/`EOPNOTSUPP` with `unsupported-filesystem`; report
rename `EPERM`/`EACCES` as `publication-denied` with its observed code (permissions
alone do not establish non-atomic behavior). Other IO errors retain their observed
diagnostic. Never fall back to visible per-file copying. These are bounded support
assumptions and observed failures, not universal detection of secretly non-atomic
filesystems. Undetected non-atomic behavior is outside the qualified guarantee.
No malicious simultaneous mutation guarantee.
Directory durability/power-loss guarantees depend on platform/filesystem flush support;
process termination must never expose a partly copied committed object. Cross-platform
qualification is required before claiming those properties on supported platforms.

Crash before mapping publication may leave staging or a verified unreferenced object,
not an installed revision. Re-import may verify/reuse that orphan and commit its
mapping. Never delete committed objects for rollback. Crash with a writer lock left
behind yields `store-busy`; no automatic timeout/PID-based stealing. Explicit local
recovery, only after the operator confirms no writer is active, reports and removes
uncommitted staging/lock state; it never deletes or changes published identities.
Readback verifies published objects before success. A killed writer's lock handling
and orphan reuse are testable in child processes; catch-based rollback alone is not.

Batch acquisition preflights every requested identity/expected digest before publishing.
A late IO failure may leave verified additional immutable objects; it must not change
project configuration or lock until every dependency succeeds. This is monotonic cache
publication, not an all-or-nothing transaction over multiple packages.

## 5. Project schema and deterministic assignment (C08–C09)

Version 2 retains all version-1 fields and rules; optional new top-level maps are
`profiles` and `assignments`. Each model/family/default still names a profile ID.
A profile not in `profiles` uses the conventional local Markdown. An explicit profile
binding is `{file: <path-inside-.agent-profiles>, resources?: [RelativeRepositoryPath]}`
OR a package binding. A role has
`file` OR `package`+`version`, plus its unchanged `skills` and optional description.
A skill is the existing local-file or native-host union OR `{package, version}`.
Local roles and explicit file-skill bindings likewise permit optional `resources`.
It is a list of explicit repository-relative regular-file paths under section 2,
duplicate-free by exact path, with case-collision/prefix rules across captured members;
no directories, entrypoint duplicate, traversal, or links. Omitted means `[]`;
snapshot resources sort by path bytes, independent of declaration order. Native-host
and package bindings reject `resources`; package resources belong to the full tree.
Package name is the manifest name; version is a mandatory exact fallback pin.
Profiles/roles require `instruction` type and instruction delivery; skill bindings
require `skill` type. No `file`+`package`, `host`+`package`, or arbitrary entrypoint
override. Binding package plus a conventional local definition is ambiguous and
rejected rather than shadowed. Explicit mapped local paths preserve existing rules.
Package objects are read through a verified store handle, not `localFile(repository,
cacheAbsolutePath)`; operational cache paths never become portable resource identities.

Example (local profiles and role file must exist):

```yaml
version: 2
default_profile: constrained
default_role: reviewer
models:
  example-large:
    profile: autonomous
    aliases: [example-large-alias]
  example-small:
    profile: scaffolded
families: {}
roles:
  reviewer:
    file: roles/reviewer.md
    skills:
      required: [security-review]
      available: []
skills:
  security-review:
    package: "@example/security-review"
    version: "1.0.0"
assignments:
  large-review:
    when: {model: example-large, role: reviewer}
    versions: {skills.security-review: "2.0.0"}
```

Assignment IDs use the existing logical-ID grammar. `when` is a mapping with zero
or more of `model`, `role`, `profile`, `host`; `versions` is a nonempty mapping from
qualified binding IDs (`skills.<id>`, `roles.<id>`, `profiles.<id>`) to exact versions.
Only package bindings may be overridden. Role/profile selectors must name declared
roles/referenced profiles. Model selector must be a canonical `models` key, not an
alias or new routing rule. Host selector must be a known integration ID. A hostless
resolution matches no host-specific selector. Empty `when` means explicit default.
Unknown and duplicate fields/IDs fail; local or native-host bindings cannot acquire
versions. These rules do not conditionally select roles or change model routing.

### Precedence without arbitrary dimension ranking

First run the existing model routing unchanged (exact key, alias, supplied family,
longest configured prefix, default) and select the role independently. Build context
`{model: identity.canonical, role, profile, host}`; unknown models have `model: null`.
Then, **per package binding**, match all assignments that both mention the binding
and agree on every selector. A matching rule strictly dominates another if it contains
all its identical selector pairs plus at least one additional pair. Keep only maximal
rules. Exactly one maximum selects its version and rule ID. No matches uses the
binding's base version and `selectedBy: binding-default`. Two maxima are an error,
**even if they name the same version**; duplicate selectors also fail. Declaration
order and assignment ID spelling never break ties.

Thus model+role overrides model-only and role-only; role+profile overrides role-only;
host+model overrides host-only; every selector rule overrides an empty default.
Model-only versus role-only, or model+role versus host+profile, is intentionally
ambiguous where both match. Add a combined rule or remove overlap. This partial order
avoids silently deciding that host, model, or role always matters more. **D2 accepted:**
report conflicting applicable revisions unless an explicit more-specific combined rule
resolves them; never break the tie by declaration order or an implicit dimension ranking.
For deterministic validation, the proposed technical contract uses exactly the routing-reachable pairs
`(canonicalModel, models[canonicalModel].profile)` for each model key, plus
`(null, default_profile)` and `(null, families[family].profile)` for every family.
Deduplicate equal pairs, cross them with every declared role and each known host ID
plus null. Aliases add no pair; canonical models cannot route to another profile.
For each affected binding separately, reject duplicate selectors among its rules
(even unreachable duplicates) and incomparable matching maxima in exactly this set.
Disjoint bindings never compete. Do not reject other model/profile cartesian pairs.
For example model A routed to autonomous and a scaffolded-only rule do not overlap;
model-A and autonomous-only rules do overlap unless a dominating rule resolves them.
No infinite model enumeration or second routing engine is needed. Selection also
checks ambiguity at runtime for defense in depth.

Return, per binding, `binding`, `package`, `version`, `sha256`, `selectedBy`,
`selectors` (empty for base), and existing routing provenance. Required/available
lists keep declaration order. Requested available skills keep the existing API order
with first-occurrence deduplication after required skills. Assignment map order is
irrelevant; instruction list order is significant. Do not conflate logical skill ID,
package identity, revision digest, or an eventual adapter's host-visible name.

## 6. Complete lock and frozen/offline semantics (C10–C12)

File: `.agent-profiles/agent-profiles.lock`, strict JSON, lock version 1. Lock covers
**every declared package binding's base pin and every assignment override**, including
available skills, unused roles/profiles, and overridden or currently unselected rules.
It does not enumerate infinitely many incoming model IDs. The coverage table plus
unchanged authoritative routing determines any requested context. Each pin entry is
identified by `(binding, rule)`; `rule` is null for base, otherwise assignment ID.
Every pin must map to exactly one package identity/digest; no missing/extra entries.

Normative record fields:

```text
Lock = {
  lockVersion: 1,
  configurationVersion: 2,
  resolverContract: "agent-profiles/resolver/v2",
  configSha256: Digest,
  pins: [{binding: BindingID, rule: null|AssignmentID,
          package: PackageName, version: ExactVersion, sha256: Digest}],
  packages: [{name: PackageName, version: ExactVersion, sha256: Digest,
              source: {type: "local-directory", locator: RelativeRepositoryPath}
                    | {type: "provided"}
                    | {type: "git", repository: String, commit: FullCommitID,
                       subdirectory: RelativePortablePath}}]
}
```

All fields shown are required. Pins sort by binding then rule (null before string);
packages sort by name then version, both byte comparisons. No duplicate entries.
`configSha256` is RECORD over the fully validated parsed configuration with maps
converted to objects, explicit values as supplied (no absolute paths), lists preserved.
Missing optional maps are canonicalized to empty maps before hashing. Assignment
map/key/YAML formatting changes do not stale a lock; ordered skill list, routing,
selector, binding, or pin changes do. Mutable instruction-file contents do not stale
this dependency lock; stamps capture them. Lock RECORD digest is external, not a
self-hash field. No timestamp, user home, store root, or local absolute source path.
`provided` means bytes must already exist or be supplied through an explicit invocation
source map; it is not a registry fallback. Relative local locators reject traversal,
links, URLs, and escapes; interpreted relative to project root, not current shell.
Git source is provenance only in v1 acquisition; offline install needs an explicit
local directory mapped to that identity if the verified store lacks the artifact.
Full Git SHA-1/SHA-256 commit spelling is recorded as observed, never shortened.

`installDependencies({root, storeRoot, sources = [], frozen = false, offline = false})`
is the proposed API. `root` is the explicitly approved project root; `storeRoot`
follows section 4 precedence. `sources` is a duplicate-free array of strict
`{name: PackageName, version: ExactVersion, directory: NonemptyLocalPath}` records;
relative directories resolve against root, not cwd. Reject duplicates (even equal),
foreign identities, remote paths and unsafe boundaries before acquisition. The CLI
uses repeatable `--source <name> <version> <directory>` triples; missing operands fail.
Each supplied directory explicitly authorizes reading only that canonical directory
under the source boundary checks. Its manifest must match the map identity and any
locked digest. A source inside canonical root is recorded as `local-directory` with
a portable repository-relative locator; an external supplied source is `provided`.
Verified store reuse without a supplied source is `provided` on first lock creation;
preserve supported existing nonstale lock provenance when reusing that identity.
Git provenance, when explicitly available from import receipts, is informational
only and never authorizes fetching or an external filesystem lookup.

Invoking dependency install authorizes use of a supported nonstale lock's
`local-directory` locators only inside the approved canonical project root (including
frozen/offline install); every locator is revalidated with no-follow/escape checks.
It does not authorize lock-specified absolute/outside/Git/remote reads. Supplied
sources take precedence, but must still satisfy the locked identity/digest; absent
store bytes plus no supplied source or safe local locator is `missing-package`.
Frozen preflight validates source-map schema, locators and available supplied bytes
even when the store contains the identity; an unsafe/mismatched supplied source is
not ignored. Relative locators must name a directory, not the project root itself.

`installDependencies` validates all configuration, assignments, pins, package types,
and source permissions; selects exact versions only; verifies/reuses store artifacts
or imports explicitly supplied local directories; then atomically writes a complete
lock after rereading the unchanged configuration. Store source mapping keys are
structured name/version identities; multiple conflicting supplied sources fail.
It never edits assignments to make installation succeed. No download in this first
implementation, even when `--offline` is omitted; a remote-source request fails
`remote-acquisition-unsupported`. No implicit trusted-source/registry search.

`--frozen-lockfile` requires a supported, complete, nonstale lock. Preflight exact
coverage/config/resolver version and all accessible source digests before project
writes. Missing content is `missing-package`; different bytes `mismatched-package`;
missing/extra pin `lock-coverage`; config drift `stale-lock`. Never select a newer
version or regenerate a lock. Frozen install may add only verified exact immutable
objects from explicitly supplied local sources or authorized lock-local locators,
never change config/lock/host files.
With `--offline`, absent content without a permitted local source fails clearly.
On all frozen outcomes the lock bytes are unchanged. Concurrent config/lock changes
before finalization fail stale-input checks. Read-only resolve never imports content
or repairs locks. Version-1 projects and version-2 projects with zero declared package
pins need no lock for resolve/stamp; an unrelated leftover lock is not dependency
authority and is untouched. Explicit install on v2 with zero pins writes a canonical
empty pins/packages lock; frozen install still requires a supported nonstale complete
lock (empty coverage is valid). Version-1 resolve/init behavior remains unchanged.

### Resolver lock modes and store-root propagation

`resolveInstructions({...existingOptions, storeRoot, lockMode = "required"})` remains
synchronous and read-only. Public resolve/inspect/diagnostics/visualizer selection and
stamp creation use `required`: if v2 declares any package pin, a missing, malformed,
incomplete or stale lock fails before loading the selected package; verified store
identity/digest must match the lock. No acquisition, rewriting, or stale fallback.
Version 1 and v2 with no declared package pins return `lockState: "not-required"`.
Package-enabled required resolution returns `lockState: "valid"`. Returned selection
also explicitly records `lockMode: "required"|"validation"` and boolean
`installRequired` (false for valid/not-required, true for missing/stale/invalid);
unknown lockMode values reject. These operational fields are not snapshot fields.

Internal configure/preset preview AND prewrite/postwrite apply validation use
`lockMode: "validation"`. Validate the entire proposed/current config, assignments,
declared exact pin identities/types and verified store trees directly, not old lock
pins. Lock state is `valid`, `missing`, `stale`, or `invalid` (or `not-required`),
with `installRequired: true` except valid/not-required; malformed/coverage-invalid
lock is reported, not silently repaired. Invalid config/ambiguity/missing or corrupt
package bytes still fail. This mode is not a frozen/public selection or stamp input.
A legitimate description/list/preset edit therefore commits, returns install-needed,
and leaves old lock bytes stale and unchanged; later public required resolve fails
`stale-lock`. Existing stale-input checks and rollback for genuine validation/IO
failure remain. Every resolve inside applyRoleChange/applyPresetImport, including
postwrite callback and final returned resolution, uses this mode. Stamp capture
rejects a validation-mode selection even if its reported lockState happens to be valid.

Explicit storeRoot propagates unchanged through configure plans/apply, wizard and
preset-wizard plans/apply, preset preview/import/export validation, skills/inventory,
inspect, diagnostics, install doctor and CLI selectors, and startVisualizer's initial
and HTTP re-resolve calls in `src/visualize.ts`. It is an operational server option,
not a query-selectable store path. Materialization/stamp/verify/diff APIs and commands
also propagate it; wrappers must not discard it and fall back to environment/home.

## 7. Exact immutable stamps and reconstruction (C13–C17)

`createStamp` requires a verified selection (valid complete lock for version-2 package
bindings). It captures exact raw bytes independently of formatted resolver text.
A stamp directory contains canonical `snapshot.json`; identity is RECORD with stamp
domain. All raw local instructions and shared captured files are immutable blobs;
complete selected package trees remain immutable objects. No mutable path is backing.
All backing must be published and verified before snapshot publication. No garbage
collection in this issue; changing project files cannot change an existing stamp.

Normative schema (type notation, not runnable JSON):

```text
Snapshot = {
  stampVersion: 1,
  configurationVersion: 1|2,
  resolverContract: "agent-profiles/resolver/v1"|"agent-profiles/resolver/v2",
  selection: {host: HostID|null, identity: ExistingIdentity,
              family: String|null, familySource: String|null,
              profile: LogicalID, role: LogicalID, roleSource: String},
  requested: [LogicalSkillID],
  composition: [InstructionEntry],
  required: [SkillEntry],
  available: [SkillEntry],
  packages: [{name, version, sha256, behavior}],
  shared: [SharedEntry],
  hostReferences: [HostReference],
  inventory: {managed: "selected-required-and-available",
              host: "unobserved", exclusiveVisibility: "unverified"},
  coverage: {localResources: "declared-only", hostContext: "unobserved",
             runtimeModel: "unverified", renderedPrompt: "unverified"}
}
InstructionEntry = {kind: "profile"|"role"|"required-skill"|"requested-skill",
                    id: LogicalID, backing: Backing,
                    package: PackageSelection|null, resources: [ResourceEntry]}
BlobBacking = {type: "blob", sha256: Digest, bytes: SafeInteger,
               path: RelativeRepositoryPath}
PackageBacking = {type: "package", sha256: Digest, path: PortablePackagePath}
Backing = BlobBacking | PackageBacking
ResourceEntry = {binding: BindingID, backing: BlobBacking}
SkillEntry = {id, type: "instruction"|"host", delivery: "inject"|"invoke",
              name, nameSource, description: String|null,
              backing: Backing|null, package: PackageSelection|null,
              resources: [ResourceEntry], hostReference: String|null}
PackageSelection = {binding: BindingID, name: PackageName, version: ExactVersion,
                    sha256: Digest, selectedBy: "binding-default"|AssignmentID,
                    selectors: {model?: CanonicalModelID, role?: LogicalID,
                                profile?: LogicalID, host?: HostID}}
SharedEntry = {path, status: "captured"|"absent"|"unobserved",
               backing: Backing|null, delivery: "host-controlled"}
HostReference = {key, id, host, scope, hostId,
                 requirement: "required"|"available",
                 compatibility: true|false|null,
                 observation: "captured-file"|"host-provided-unverified",
                 backing: Backing|null, invocation: "unverified",
                 rendered: "unverified", supportedHosts: [HostID]}
```

For existing host references, `host` and `hostId` retain their existing values,
`scope` is project/user/plugin, and `supportedHosts` contains that host. For a native
package reference, `scope` is `package`, `hostId` is null (no host-visible name has
been assigned), `host` is the selected consuming host or null, `supportedHosts` is
the manifest hosts list, and backing references the retained package entrypoint.
Compatibility means the selected host belongs to that list (null when omitted),
not equality to a single host property. Package native references stay `type: host`
and `delivery: invoke`; the typed compatibility seam must not reuse the current
single-host equality check blindly. All manifest host order is retained as published.
Package skill metadata name fallback uses the package-relative entrypoint parent
or the package-name leaf for a root entrypoint, never a physical cache directory.

Fields shown are required (only selector keys marked `?` are optional); reject extra
fields. Package table members are strict `{name: PackageName, version: ExactVersion,
sha256: Digest, behavior: ManifestBehavior}`; no untyped extra provenance fields.
For profile/role entries, owning binding is `profiles.<id>`/`roles.<id>`; skill
entries use `skills.<id>`. Package backing requires nonnull PackageSelection with
that exact binding, matching digest, table identity and manifest entrypoint/type;
blob backing requires package null. Every selected package-backed profile, role,
required AND available skill retains its selected rule/selectors, not just its bytes.
Selectors must agree with snapshot selection; base selectors are `{}`. A selected
rule ID is immutable recorded provenance, not looked up in today's assignments.
ResourceEntry.binding must equal its owning entry's qualified binding; only local
blob-backed entries have resources. Resources cannot duplicate the instruction
path or one another, and the same physical asset used by different bindings retains
each qualified ownership. Skill composition entries repeat exactly the corresponding
SkillEntry backing/package/resources; disagreement fails relations verification.
Package and native-host resources are `[]`: package support files are retained via
full-tree backing, not manufactured blob resources. `ExistingIdentity` uses the existing
raw/canonical/source/matchedBy result including nulls; identity source is provenance,
not attestation. Per-package behaviors match verified manifests. Host reference keys
are qualified logical IDs, unique. Lists preserve their meaningful resolver order;
packages sort by name/version/digest; resources sort by path. Shared entries follow
the explicit caller order, reject duplicates, and never reorder instruction layers.
`composition` is profile, role, required injected skills in declaration order, then
requested injected available skills in deduplicated request order. Required/available
entries stay present even when not injected. `requested` is first-occurrence-deduped
API skill input, including explicitly requested required IDs; composition still
injects required IDs once, then requested available IDs only. Unknown/unpermitted
requests reject before capture. An available instruction skill's bytes
are retained even if never requested. Required native skills never enter composition.

Package backing contains full trees, not only entrypoints. Local profile/role/default
skill backing includes the file itself. Version 2 local bindings may optionally
include `resources: [<repository-relative-file>]` in profile, role, and file-skill
bindings; no resources on native-host or package bindings. Each is an explicitly
named regular file inside the repository under the portable path/link rules. No
recursive ambient scan, Markdown link crawler, user-home reads, or runtime includes.
Version 1 cannot gain these fields; its supporting references remain outside declared
coverage. Existing v1 resolution/path semantics are preserved; creating a portable
stamp additionally requires captured local member names and types to satisfy section
2's portable path/no-link policy. An otherwise-valid legacy resolution may therefore
fail portable stamp capture explicitly, without rewriting the project.
This explicit boundary permits local asset retention without claiming a
complete transitive closure of free-form instructions. A referenced declared resource
that is absent aborts stamp creation. Same bytes under different resource paths change
identity because path can affect reference meaning.

Default shared observation captures repository-root `AGENTS.md` if safely readable,
records `absent` if nonexistent, and records `unobserved` with no fake digest when
unreadable/unsafe. Other shared files require explicit ordered `sharedFiles` input
inside the repository; user/managed/hidden system prompts are never scanned. Captured
shared bytes are retained but not injected into composition or called proof of host
attachment. Caller-required shared captures must succeed or stamp creation fails.
Record unexpected host context only as unobserved; no runtime inventory requirement.
Project-scoped native entrypoint bytes, when observable, can be retained as a blob
in the host reference; they are observation, not a full native package/invocation pin.
User/plugin references retain identifiers and `host-provided-unverified`, not guessed
hashes. Cross-host incompatibility is retained and blocks native readiness, never
converted into an instruction.

Snapshot contains only the selected managed configuration, not unrelated assignments
or a complete config/lock digest: two projects selecting the same ordered content
and provenance can have the same stamp despite unrelated config. Local relative paths,
selection provenance, declared resources, observable shared status, and raw identity
input do affect identity. A different identity alias can therefore yield the same
package set but a different stamp. Store/cache roots, source acquisition paths,
timestamps, receipt IDs, and actual executing provider/model do not affect it.
An external eval record can reference the full stamp digest and separately record
suite/fixture/model/provider/host/environment/run identities. No evaluation runner.

### Verification, reconstruction, and diff

`verifyStamp` recomputes snapshot RECORD, checks strict schema and internal relations
(composition membership/order, complete package and backing closure, manifest types,
expected revisions/digests, unique IDs, request permission, qualified resource
ownership and all profile/role/skill selection-provenance relations). Closure includes
every composition resource and required/available resource blob, even if not injected;
package table is the exact distinct selected set with no foreign/omitted revision.
Then reads every backing
blob/tree, verifies lengths/digests and referenced paths. Corrupt canonical snapshot,
missing backing, and changed backing are separate findings, not generic success.
An unexpected file in a package tree is mismatched. Verify from immutable backing,
not today's project files; do not repair or restamp automatically.

Report independent fields `snapshotIntegrity`, `managedContent`, `managedReconstruction`,
`hostDependencies`, `hostInvocation`, `runtimeIdentity`, `renderedPrompt` with explicit
`verified`, `missing`, `mismatched`, `unverified`, or `unsupported` as applicable.
Host references also retain the label `host-provided-unverified`. Aggregate:
`managedReproducible` is true only when all managed backing is verified;
`declaredHostDependenciesSatisfied` is false when any required native reference is
incompatible or unverified; `completeRuntimeReproducible` is always false for this
reference implementation. No unqualified "fully reproducible" message. Optional
available host references remain individually unverified without making managed bytes
unreconstructable. Unknown host inventory is always visible in reports.

`reconstructStamp` requires verified managed backing and returns ordered instruction
Buffers with their full InstructionEntry metadata (including profile/role package
selection provenance), plus required/available metadata, qualified resource bytes,
full package trees, shared observations, and host references. It does **not** rerun
routing, reread live config,
or fetch content. It can reconstruct managed bytes while reporting unresolved native
references; an option requesting native-ready output must fail `unsupported-native`.

`diffStamps` verifies both manifests and managed backing before comparing; invalid
input yields findings and no claim of a complete content diff. Compare host/model/raw
and canonical identity/profile/role, ordered composition, byte digest/path of each
instruction/shared/resource, required and available lists (including reorder), selected
versions/hashes/rules/selectors for profiles, roles and skills, qualified resource
ownership, and native references/status. Resource reconstruction returns owning binding,
relative path and original Buffer, including profile/role assets after source deletion.
Report stable field paths and
before/after values; no quality score. Equal stamps yield no changes. Do not collapse
reorder into a set comparison or equate same version with same digest.

## 8. Abstract adapter and filesystem materializer (C18–C19)

An adapter consumes a verified reconstructed stamp, never a mutable resolved path.
Proposed interface:

```text
planMaterialization({stampDigest, storeRoot, adapterId, adapterContractVersion,
                     options = {}}) -> Plan
materialize({plan, storeRoot, destination, outputRoot}) -> Receipt
verifyMaterialization({destination, expectedStampDigest, storeRoot})
  -> independent integrity findings
Plan = {planVersion: 1, stampDigest: Digest, adapter: Adapter, options: Options,
        files: [{path: PortableOutputPath, backing: OutputBacking}],
        mappings: [Mapping], capabilities: Capabilities}
Adapter = {id: "filesystem-v1", contractVersion: 1}
Options = {}  # filesystem-v1 accepts exactly an empty plain object
OutputBacking = Backing | {type: "snapshot", sha256: Digest}
Mapping = {binding: BindingID|null, sourceKind: "blob"|"package"|"snapshot",
           sourceDigest: Digest, packageDigest: Digest|null,
           sourcePath: RelativePortablePath, outputPath: PortableOutputPath,
           hostName: null}
Capabilities = {bytePreservation: "verified", filesystemIsolation: "verified",
                nativeLayout: "unsupported", nativeInvocation: "unsupported",
                hostVisibilityIsolation: "unverified", runtimeRendering: "unverified"}
Receipt = {receiptVersion: 1, stampDigest: Digest, planDigest: Digest,
           adapter: Adapter, options: Options, outputDigest: Digest,
           mappings: [Mapping], capabilities: Capabilities, status: "committed"}
```

These are strict complete returned-record shapes; reject unknown fields/version/adapter
and nonempty or nonobject options. Omitted input options canonicalize to `{}`;
explicit null does not. No receipt metadata is emitted in this first schema. Future
supported options/adapters require a versioned strict contract and identity controls,
not permission for arbitrary fields now. All API storeRoot inputs follow section 4.
Snapshot backing's digest must equal plan stampDigest and resolves canonical snapshot
bytes, not a raw blob hash. Mapping packageDigest equals sourceDigest for package
sources and is null for blob/snapshot sources; sourcePath is that backing's relative
path (`snapshot.json` for snapshot). Binding is the qualified owner for instruction,
resource and skill outputs, null for snapshot/shared outputs. For full package-tree
output emit one mapping per selected owning binding/member, including all bindings
sharing a revision. Verify each mapping against files/backing and snapshot ownership.
File paths are destination-relative (`content/...`), distinct and portable; mappings
sort by outputPath, then binding (null first), sourcePath, sourceKind and sourceDigest
using byte order, with duplicate identical mappings rejected. Files sort by path.
No arbitrary callback or package-supplied renderer. `planDigest` is RECORD of canonical
Plan including required options, adapter/version, mappings and capabilities; destination
and storeRoot are excluded. materialize preflights destination denial first, then
strictly validates the supplied plan, verifies its stamp in the explicitly selected
store and recomputes the whole plan from that
stamp/adapter/options before staging. A caller's edited files or backing cannot direct
arbitrary reads/writes; mismatch fails `plan-mismatch`.
Capabilities explicitly name `bytePreservation`, `filesystemIsolation`,
`nativeLayout`, `nativeInvocation`, `hostVisibilityIsolation`, `runtimeRendering`.
Host-specific adapters can transform bytes only into separately hashed generated
outputs with source/output mappings; never rewrite the package. No native adapter is
implemented in this first delivery. Existing bootstrap adapters remain unchanged.

`filesystem-v1` emits exact captured content under a new destination:

```text
content/
  snapshot.json
  instructions/0000.md, 0001.md, ...   # composition positions, minimum four digits
  available/<E(logical-skill-id)>/entry.md
  resources/<E(qualified-binding-id)>/<repository-relative-resource-path>
  packages/sha256/<packageDigest>/<entire tree>
  shared/<repository-relative-shared-path>
receipt.json
```

Use the canonical snapshot bytes for `content/snapshot.json`. Available output contains
only instruction skills not already in composition. Package trees include all selected
required AND available package revisions, including inert native packages. Shared
output includes captured entries only. Package resources are in full tree output;
local resources use encoded qualified binding IDs, including profile/role resources.
Emit one file for each distinct owned resource path; repeated skill composition
metadata does not cause duplicate outputs. Mapping lists every exported package member
and instruction/resource backing, including the same bytes emitted in two locations.
No symlinks into the store. Files use ordinary nonexecutable creation modes; original
permissions are not promised. The reference adapter does not render shell tokens,
interpret host frontmatter, generate plugins, or assign host-visible names.

`outputDigest` is TREE over everything below `content/` (paths relative to content),
including snapshot bytes; `receipt.json` is outside that tree so no self-hash cycle.
Receipt has exactly the versioned schema above and is canonical J bytes. Verification
requires caller-supplied full `expectedStampDigest`, never inferred from receipt or
destination snapshot. Read and strictly validate receipt, require its stampDigest to
equal the caller expectation (`stamp-mismatch` otherwise), and verify that expected
stamp and all backing in storeRoot. Embedded snapshot bytes must equal that canonical
expected snapshot. Recompute the plan using receipt adapter/version/options, and
compare its digest, mappings and capabilities exactly; independently enumerate output
and compare every expected member/path/raw byte and TREE outputDigest. Extra files
inside content or outside content other than receipt.json mismatch. Unsupported
adapter/version/options fail schema/contract validation rather than being trusted.
A fully valid export of stamp B plus B's matching receipt cannot verify for caller
expectation A, even if both stamps and output digests are internally correct. Receipt
is not authentication; its claims cannot replace independent expected-store evidence.
Destination/time are operational caller context only, excluded from plan/output IDs.

Destination must be an absent child of an explicitly approved existing `outputRoot`.
Refuse any existing file/directory (even empty), link/reparse boundary or descendant
at/below canonical approved outputRoot (section 2), hard link,
escape, source/store overlap, or known project/user host skill/settings/plugin target.
Preflight destination denial before reading source backing so a missing source cannot
mask a forbidden destination. Use private sibling staging and exclusive sibling
publication lock, then same-filesystem atomic rename into an absent destination;
recheck paths/absence immediately before publication. Concurrent cooperating writers
to one target produce one success and one refusal; different targets never interfere.
The final directory rename is the output publication commit point. Before rename,
caught failure removes only own staging; termination leaves final absent and may
leave own clearly uncommitted staging/sibling lock. After rename, termination or
readback/lock-release failure may leave the complete committed output plus stale
lock, never a partial final directory; report committed-but-unacknowledged state if
the caller survives. Do not delete a committed target for rollback. Readback verifies
the committed export against expectedStampDigest before reporting success. Explicit
operator-confirmed recovery clears only own known uncommitted staging/stale lock,
preserves and verifies a committed target, and reports mismatches without repair.
Retry to the same committed-but-unacknowledged destination refuses `destination-exists`;
caller verifies it independently or explicitly chooses a new absent destination.
Use separate before/after-rename child kill barriers; catch-only rollback does not
prove termination behavior. Section 4's observed filesystem errors/support assumptions
also apply here. No automatic lock stealing/leases or shared host directory writes.

Capabilities for this adapter: byte preservation verified by output checking;
filesystem isolation verified for its new export subtree; native layout/invocation
unsupported; host visibility isolation unverified; runtime rendering unverified.
Even an approved ordinary output root might be watched by an unknown host: declare
that observation unknown, do not claim universal watcher exclusion or visibility.
Two exports prove independent managed files, not exclusive runtime skills.

## 9. API, CLI, presets, and all affected callers (C20–C23)

Public forms proposed in P1 and now implemented in the checkout (see the current package guide):

```text
agent-profiles add @example/security-review@2.0.0 --source ./packages/security-v2 --store <local-store>
agent-profiles install [--frozen-lockfile] [--offline] [--store <local-store>] [--source <name> <version> <directory>]...
agent-profiles stamp [existing resolve selectors] [--store <local-store>]
agent-profiles verify <full-stamp-digest> [--store <local-store>]
agent-profiles diff <full-stamp-a> <full-stamp-b> [--store <local-store>]
agent-profiles materialize <full-stamp-digest> --adapter filesystem-v1 --store <local-store> --output-root <root> --destination <new-child>
```

`add` only imports a verified local package into the store; it prints identity/digest
and does not guess a logical ID, role, or config edit. Maintainer may choose `package
import` instead (decision D5). `install` is dependency installation, not existing
`installPackage` in install.js (which installs the Agent Profiles npm executable for
`init --package`). Preserve existing `init --package` semantics and option isolation.
Use separately named API functions/modules. Full digests are required lookup inputs;
short display hashes never resolve ambiguously. Errors name rule/binding/identity and
repository-relative path; JSON emits independent states, text sanitizes controls.
CLI unsupported flags/extra positionals fail before mutation. No auto-initialization,
paid calls, plugin launch, or implicit dependency download.

### Compatibility audit / intended seams

| Existing consumer | Required change or explicit guard |
| --- | --- |
| resolve.js source union, profileFile, role validation, selected/available readers | Dispatch typed backing; keep localFile for repository files only; package selection lives within existing resolver after identity routing |
| skills.js configured non-host `.file`, local discovery | Represent package bindings without manufacturing a repository path; explicit package identity and verification status, no ambient cache scan |
| configure.js binding/targetOf/bind and role `.file` writer | Preserve package skill bindings on description/list edits; never alias by null path; block edits to package-backed role instructions pending explicit local conversion |
| wizard.js resourceOf/where/currentFile and initial selection | Package resource key is binding/name/version/digest, not `file\0null`; retain package selections; refuse file prompt for package-backed role rather than replacing it |
| presets.js import requires fallback `.file`, export `.path` copying, Markdown-only payload | Required package skills may be satisfied by existing validated bindings; never bundle entrypoint as if it were full package; reject unsupported identity-losing export |
| preset-wizard.js presentation and confirmation | Explain package references/unsupported export before any write; no silent drop |
| diagnostics.js loaded text, available measurement, Read-path output | Read Buffers via backing seam; preserve v1 text counts; package references display exact identity/digest, not inaccessible cache path; snapshots bypass trimmed formatting |
| inspect.js profile/role file inventory | Typed metadata with package states; bounded inspection does not acquire/repair; do not mark missing `.file` as invalid local metadata |
| install.js doctor legacy-file heuristic and role loops | Only local bindings enter legacy heuristic; missing package/lock is separate configuration/dependency finding; keep bootstrap/native checks independent |
| bin/agent-profiles.js | Add bounded commands/options without changing init/npm install; JSON/output must include package and host status separation |
| visualize.js / visualizer/app.js | Consume resolver provenance/typed backing; display package IDs and no second routing or host-invocation claim |
| scripts/package-smoke.js and existing tests | Preserve v1 `.path` outputs and inventory; add published-artifact package workflow only at authorized final smoke gate |

Smallest preset policy: keep preset schema version 1 unchanged. Importing a preset
that *requires* an existing package skill retains that binding and validates complete
coverage; importing/replacing definitions cannot erase assignments without explicit
conflict resolution. Export of selected package-backed roles/profiles/skills fails
`preset-package-unsupported` **before writing**, whether the user asks to include the
skill or leave it as a requirement: schema 1 cannot preserve its version assignments.
Unrelated local-only selections still export; normal version-1 workflows remain exact.
This is explicit compatibility, not package-aware portable preset support. A future
schema-2 preset is a maintainer-owned expansion, not required to avoid silent loss.
Configure description/skill-list edits on local roles preserve package bindings;
package-backed role file editing/conversion and creating new package bindings remain
manual validated config edits in v2. Deleting a role referenced by assignment selectors
fails with the exact assignment rather than secretly removing policy. A config edit
may make its lock stale; preview and apply use validation mode at every resolver
call, report install-required and leave lock bytes unchanged, never silently re-lock.

## 10. Decisions and parent gates

All detailed proposals above require parent assessment. **D1 and D2 are accepted**
within the scopes recorded above: v2 with documented adjacent-version migration guides
and AI prompts, and explicit conflict resolution through more-specific combined rules.
The initial D3 format limits (exact stable versions, ASCII paths, no links) are accepted
and exercised by P2. **D6 explicit recovery is now accepted:** interrupted imports leave
a clear busy/error state and require operator-confirmed recovery; do not automatically
delete a writer lock or touch published packages. Cooperative local publication is the
bounded implementation approach, not a claim about unqualified filesystems.
D4–D5 remain proposed; recommendations for those choices are **not approval**:

| Decision | Recommendation and smallest consequence | Alternative requiring revised contract/map |
| --- | --- | --- |
| D1 schema evolution — ACCEPTED, CLARIFIED | New config v2; preserve v1 behavior/tests; deliver v1 → v2 guide/prompt and a consistent vN → vN+1 migration-document pattern | A general automatic migration engine and broader config-document history interfaces remain outside this decision |
| D2 assignment priority — ACCEPTED | Strict selector dominance; explicit combined rules resolve otherwise conflicting assignments; deterministic routing-reachable per-binding validation remains subject to technical review | No implicit model/role/host priority or declaration-order tie breaking |
| D3 portability/execution policy | ASCII paths, no links, exact stable versions; declared native effects archived inert | Unicode/prerelease/link support or host sandbox/lint expansion needs separate policy/tests |
| D4 lock/stamp coverage | Lock all declared pins; snapshot selected managed bytes plus declared local resources/shared observations | Target-bounded lock or ambient capture needs explicit coverage and stale rules |
| D5 UX/preset boundary | add = local import only; preset v1 package export refuses clearly | Config-editing add or package-aware presets requires separately bounded schema/edit work |
| D6 publication/recovery — ACCEPTED | Cooperative serialized local writers; clear busy/error after interruption, explicit operator-confirmed stale-lock recovery preserving published packages | Automatic lease recovery or non-atomic/network store support is not included |

G0 (now): parent assesses these two documents, schema/example consistency, policy
choices, and requirement coverage. Return corrections or explicitly accept a frozen
contract/map. Only then release bounded RED cases. G1: parent accepts observed RED
and fixture/oracle sufficiency for one package before its GREEN. G2: parent verifies
final hashes, current mandatory cases, inherited preservation, and deferred exact case
inventory before the next package. G3: full offline two-revision workflow, fresh-root
reproduction, full regression/lint/typecheck, package smoke under separately permitted
dependency/network conditions, and supported-platform evidence. G4: fresh independent
whole-solution review; Git publication/closure and native qualification remain separate.

Original I20-P1-SOL allowed only this document and its companion. The separately
requested adjacent-documentation slice additionally permits exactly
`docs/migrations/README.md`, `docs/migrations/config-v1-to-v2.md`, and
`docs/migrations/prompts/config-v1-to-v2.md`, with minimal crosslink/migration-coverage
updates to this document pair. Future allowed seams/tests remain proposed, not
authorization. No production, test,
configuration, archive, index, HEAD, commit, remote, shared host, or successor changes
are allowed by I20-P1-SOL. Parent's recorded 226 baseline passes/lint/typecheck are
historical evidence, not rerun here or evidence of package behavior. No dependencies
are installed for this documentation slice.
