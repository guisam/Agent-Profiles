# Versioned packages, locks and managed snapshots

This checkout implements configuration v2 and opt-in v3; the walkthrough below
remains v2, including its existing snapshot1 behavior. These commands are included
in CLI package version **0.4.1**; verify the actual executable before use.
Use a trusted checkout with Node.js 24+ and its dependencies already available.
Preparing/installing the executable needs separate authorization. Dependency
`install` below is distinct from `init --package`, which installs the Agent
Profiles npm executable into a project.

For exact config3 metadata selection, workflow composition/readiness and lock2,
see [revision declarations](revisions.md) and the adjacent
[v2 → v3 conversion guide](migrations/config-v2-to-v3.md) with its approval-first
prompt. Base conversion preserves old selections; optional workflow adoption is
separate. Config3 opts into workflow-aware stamp2 reconstruction/materialization;
see the revision guide for retained metadata/peer evidence and runtime limits. A valid lock
checks integrity; it does not assert actor readiness or actual host invocation.

## Complete local walkthrough

Start PowerShell in that checkout. These steps create only a new owned temporary
directory; keep it for inspection. Fictional model IDs are routing inputs, never
requests to a provider. Expected outcomes below are instructions to reproduce,
not an observed live-host or published-artifact transcript. Stop on a nonzero exit.

```powershell
$Checkout = (Get-Location).Path
$Demo = Join-Path ([IO.Path]::GetTempPath()) ('agent-profiles-demo-' + [guid]::NewGuid().ToString('N'))
$Project = Join-Path $Demo 'project'
$Store = Join-Path $Demo 'store'
$Sources = Join-Path $Demo 'sources'
$V1 = Join-Path $Sources '1.0.0'
$V2 = Join-Path $Sources '2.0.0'
$Outputs = Join-Path $Demo 'exports'
$Utf8 = [Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Path $Project,$Store,$V1,$Outputs | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Project '.agent-profiles/profiles'),(Join-Path $Project '.agent-profiles/roles'),(Join-Path $V1 'support') | Out-Null
```

Save this complete manifest as `$V1/package.yaml`, using the actual value of
`$V1`, not a literal dollar-sign path:

```yaml
schema_version: 1
package:
  name: "@example/security-review"
  version: "1.0.0"
  type: skill
  description: Review fictional changes for security defects.
  license: Apache-2.0
entrypoint: SKILL.md
behavior:
  delivery: instruction
  hosts: []
  effects: []
```

Create every other required file and the second revision. All instruction text
and supporting bytes remain inert during acquisition/export:

```powershell
[IO.File]::WriteAllText((Join-Path $V1 'SKILL.md'), "---`ndescription: Review fictional security boundaries.`n---`nReview revision one.`r`n`r`n ", $Utf8)
[IO.File]::WriteAllText((Join-Path $V1 'support/note.txt'), "Support revision one.`r`n", $Utf8)
[IO.File]::WriteAllBytes((Join-Path $V1 'support/data.bin'), [byte[]](0,255,1,13,10))
Copy-Item -LiteralPath $V1 -Destination $V2 -Recurse
$Manifest2 = [IO.File]::ReadAllText((Join-Path $V2 'package.yaml')).Replace('version: "1.0.0"', 'version: "2.0.0"')
[IO.File]::WriteAllText((Join-Path $V2 'package.yaml'), $Manifest2, $Utf8)
[IO.File]::WriteAllText((Join-Path $V2 'SKILL.md'), "---`ndescription: Review fictional security boundaries.`n---`nReview revision two.`r`n`r`n ", $Utf8)
[IO.File]::WriteAllText((Join-Path $V2 'support/note.txt'), "Support revision two.`r`n", $Utf8)
[IO.File]::WriteAllBytes((Join-Path $V2 'support/data.bin'), [byte[]](0,255,2,13,10))
[IO.File]::WriteAllText((Join-Path $Project '.agent-profiles/profiles/base.md'), ([string][char]0xfeff + "# Profile`r`nCheck the evidence.`r`n`r`n "), $Utf8)
[IO.File]::WriteAllText((Join-Path $Project '.agent-profiles/roles/reviewer.md'), "# Reviewer`r`nReport concrete defects.`r`n", $Utf8)
[IO.File]::WriteAllText((Join-Path $Project 'AGENTS.md'), "# Shared rules`r`nPreserve review evidence.`r`n", $Utf8)
```

Save this complete configuration as `$Project/.agent-profiles/agents.yaml`:

```yaml
version: 2
default_profile: base
default_role: reviewer
models:
  fictional-small:
    profile: base
  fictional-large:
    profile: base
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
    when: {model: fictional-large, role: reviewer}
    versions: {skills.security-review: "2.0.0"}
```

Each package tree contains exactly `package.yaml`, `SKILL.md`, `support/note.txt`
and `support/data.bin`. The project has configuration, profile, role and shared
rules. Do not create a conventional `.agent-profiles/skills/security-review/SKILL.md`:
it conflicts with the package binding. No bootstrap/native skill/npm project is needed.

### Import, lock and select

Run from the same checkout directory. `add` imports without editing configuration.
`install` locks every base/override pin, including unselected and available declarations.

```powershell
node bin/agent-profiles.ts add '@example/security-review@1.0.0' --source $V1 --store $Store --json
if ($LASTEXITCODE -ne 0) { throw 'first import failed' }
node bin/agent-profiles.ts add '@example/security-review@2.0.0' --source $V2 --store $Store --json
if ($LASTEXITCODE -ne 0) { throw 'second import failed' }
node bin/agent-profiles.ts install --root $Project --store $Store --offline --source '@example/security-review' 1.0.0 $V1 --source '@example/security-review' 2.0.0 $V2 --json
if ($LASTEXITCODE -ne 0) { throw 'dependency lock failed' }
node bin/agent-profiles.ts resolve --root $Project --store $Store --host codex --model fictional-small --identity-source user --role reviewer --json --contents
if ($LASTEXITCODE -ne 0) { throw 'small resolution failed' }
node bin/agent-profiles.ts resolve --root $Project --store $Store --host codex --model fictional-large --identity-source user --role reviewer --json --contents
if ($LASTEXITCODE -ne 0) { throw 'large resolution failed' }
```

Expected: small selects `1.0.0`, `binding-default`; large selects `2.0.0`,
`large-review` with both selectors. Both use profile `base`, role `reviewer`,
required `[security-review]`, available `[]`. Full reported digests identify the
complete source bytes. Identical reimports reuse verified objects; changing a
supporting byte under the same name/version is `identity-conflict`, not an update.

Install's repeatable `--source` has **three operands: name version directory**;
add's `--source` has only the directory. This differs from `--sources <file>`,
the [machine-local native skill-roots JSON](hosts/external-skill-sources.md) used
by discovery, not acquisition. Relative install sources resolve against `--root`;
relative add sources use the invoking directory. Here every source path is absolute.

### Capture, verify and compare

Keep full observed stamp digests; short prefixes cannot resolve. Preserve explicit
root/store/selectors on reentry. CLI load/rerun commands include operational context
when resolution used `--store`; the default API formatter remains store-free.

```powershell
$RawA = node bin/agent-profiles.ts stamp --root $Project --store $Store --host codex --model fictional-small --identity-source user --role reviewer --json
if ($LASTEXITCODE -ne 0) { throw 'first capture failed' }
$A = ($RawA | ConvertFrom-Json).digest
$RawB = node bin/agent-profiles.ts stamp --root $Project --store $Store --host codex --model fictional-large --identity-source user --role reviewer --json
if ($LASTEXITCODE -ne 0) { throw 'second capture failed' }
$B = ($RawB | ConvertFrom-Json).digest
node bin/agent-profiles.ts verify $A --store $Store --json
if ($LASTEXITCODE -ne 0) { throw 'verification failed' }
node bin/agent-profiles.ts diff $A $B --store $Store --json
if ($LASTEXITCODE -ne 0) { throw 'comparison incomplete' }
```

Stamps retain ordered profile/role/skill raw bytes, unrequested available instruction
backing, full selected package trees and observed shared files. Reconstruction uses
immutable backing, not today's configuration/sources. BOMs, CRLF, trailing blanks
and binary resources survive. Decoded live [proof measurements](proof.md) are a
separate view. Diff compares structural fields/order/provenance, not quality or
semantic equivalence; both inputs and all backing verify even at equal digests.

Default shared capture observes root `AGENTS.md` best-effort: captured, absent or
unobserved. API `sharedFiles` **replaces** the default: `[]` captures none; an
explicit unavailable path fails. V2 local file-backed profiles/roles/skills can
declare repository-relative `resources`; free-form Markdown links are not crawled.

### Reproduce dependencies in a fresh root/store

Copy only this owned fixture. A portable lock is not a package archive: retain
and explicitly supply the same exact approved source bytes.

```powershell
$Fresh = Join-Path $Demo 'fresh-project'
$FreshStore = Join-Path $Demo 'fresh-store'
New-Item -ItemType Directory -Path $Fresh,$FreshStore | Out-Null
Copy-Item -LiteralPath (Join-Path $Project '.agent-profiles') -Destination (Join-Path $Fresh '.agent-profiles') -Recurse
Copy-Item -LiteralPath (Join-Path $Project 'AGENTS.md') -Destination (Join-Path $Fresh 'AGENTS.md')
$LockBefore = (Get-FileHash -LiteralPath (Join-Path $Fresh '.agent-profiles/agent-profiles.lock') -Algorithm SHA256).Hash
node bin/agent-profiles.ts install --root $Fresh --store $FreshStore --frozen-lockfile --offline --source '@example/security-review' 1.0.0 $V1 --source '@example/security-review' 2.0.0 $V2 --json
if ($LASTEXITCODE -ne 0) { throw 'fresh frozen install failed' }
if ((Get-FileHash -LiteralPath (Join-Path $Fresh '.agent-profiles/agent-profiles.lock') -Algorithm SHA256).Hash -ne $LockBefore) { throw 'frozen lock changed' }
node bin/agent-profiles.ts resolve --root $Fresh --store $FreshStore --host codex --model fictional-large --identity-source user --role reviewer --json --contents
if ($LASTEXITCODE -ne 0) { throw 'fresh resolution failed' }
```

Fresh large selection must retain the `2.0.0` digest/content. Frozen install requires
a complete nonstale lock and preserves its bytes, importing only exact local content.
Missing content, stale config, incomplete coverage or mismatched offered bytes
refuses. Verified immutable additions may remain after late acquisition failure.
Guarded in-root sources may have relative lock locators; external sources here are
`provided`, needing explicit local bytes when missing from store. Git provenance
never authorizes fetching. Package install does not transfer stamps/blobs; retain
the original verified store for the following export.

### Export to two absent destinations

The output root must exist; destination children must not, even as empty directories.
`filesystem-v1` accepts only empty options. Protect known external sources as well
as the automatically protected project/store boundaries.

```powershell
$OutA = Join-Path $Outputs 'small'
$OutB = Join-Path $Outputs 'large'
node bin/agent-profiles.ts materialize $A --root $Project --store $Store --adapter filesystem-v1 --output-root $Outputs --destination $OutA --protect-root $Sources --json
if ($LASTEXITCODE -ne 0) { throw 'first export failed' }
node bin/agent-profiles.ts materialize $B --root $Project --store $Store --adapter filesystem-v1 --output-root $Outputs --destination $OutB --protect-root $Sources --json
if ($LASTEXITCODE -ne 0) { throw 'second export failed' }
```

Outputs contain `content/snapshot.json`, ordered `content/instructions/*.md`, full
`content/packages/sha256/<digest>/` trees, captured shared files and `receipt.json`.
Unrequested available instructions and declared local resources have mapped outputs.
Readback checks exact members/bytes, plan/mappings/capabilities and output digest.
Distinct absent destinations can be written concurrently; the commands above run
sequentially. An existing committed destination refuses overwrite. Source/store and
the other output remain unchanged by a new export.

The CLI automatically protects its project root (including in-root source/project
host folders), the entire Claude config directory (`CLAUDE_CONFIG_DIR` when set,
otherwise `~/.claude`), and Codex user skills (`~/.agents/skills`); the materializer
independently protects the store. The Claude override uses discovery's validation:
an absolute path without NUL or `..` traversal, including refusal of an empty value.
Materialization additionally requires absolute local paths without `.` components;
relative, UNC or nonlocal roots fail closed rather than being ignored. Guards reject
overlap, escapes, links and existing targets **before backing reads**. Ordinary home
archive directories outside these protected roots remain valid outputs.
`--protect-root` adds per-run caller-known source/host boundaries, including custom
or plugin roots recorded in local discovery preferences that the CLI does not read
for export protection; it is not persistent config and cannot disable mandatory guards.
Portable stamps cannot discover original absolute source origins or every external
host root. API callers must pass nonempty `deniedRoots` containing
their known project/source/host boundaries. This protects a new ordinary filesystem
subtree, not runtime skill visibility, permissions or context isolation. Unknown
watchers/rendering remain unverified; native layout/invocation are unsupported.

## Read-only output verification and recovery

This read-only API check is part of the walkthrough. Use the caller's expected
stamp, not one inferred from a possibly substituted receipt:

```powershell
$env:AP_DEMO = $Demo
$env:AP_STAMP_A = $A
@"
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { verifyMaterialization } from './src/materialize.ts';
import { reconstructStamp } from './src/stamps.ts';
const storeRoot = path.join(process.env.AP_DEMO, 'store');
const digest = process.env.AP_STAMP_A;
assert.deepEqual(verifyMaterialization({ destination: path.join(process.env.AP_DEMO, 'exports/small'), expectedStampDigest: digest, storeRoot }), { verified: true, findings: [] });
const rebuilt = reconstructStamp({ digest, storeRoot });
assert.deepEqual(rebuilt.composition.map(entry => entry.kind), ['profile', 'role', 'required-skill']);
assert.deepEqual(rebuilt.composition.map(entry => entry.bytes), [
  fs.readFileSync(path.join(process.env.AP_DEMO, 'project/.agent-profiles/profiles/base.md')),
  fs.readFileSync(path.join(process.env.AP_DEMO, 'project/.agent-profiles/roles/reviewer.md')),
  fs.readFileSync(path.join(process.env.AP_DEMO, 'sources/1.0.0/SKILL.md')),
]);
assert.deepEqual(rebuilt.packages[0].files.find(file => file.path === 'support/data.bin').bytes, Buffer.from([0,255,1,13,10]));
assert.equal(rebuilt.packages[0].files.length, 4);
console.log('Owned export verified; reconstruction returned raw Buffers.');
"@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw 'reconstruction/output verification failed' }
```

Recovery is a separate manual operation, **not normal walkthrough execution**.
Only after independently confirming no writer is active, an authorized operator
may call `recoverStore({storeRoot, confirmNoActiveWriter: true})` from
`src/package-store.ts`. It removes recognized uncommitted staging/writer-lock state,
preserving published objects/identities. Old age/PID guesses never authorize lock deletion.
Output API `recoverMaterialization({destination, outputRoot, expectedStampDigest,
storeRoot, deniedRoots, confirmNoActiveWriter: true})` from `src/materialize.ts`
checks ownership, verifies committed output and clears only recognized leftovers.
Committed targets remain; mismatches are reported without repair or republication.
Verify committed-but-unacknowledged output independently: retry to its existing
name still refuses. Unknown/ambiguous leftovers need investigation. Read-only
`verifyStamp`/`verifyMaterialization` never recover. There is no public recovery command.

## Format, selection and trust limits

Manifests reject unknown/duplicate fields, lifecycle/dependency/hooks fields,
unsupported versions, YAML aliases/merge/custom tags and multiple documents.
The complete manifest shows every required field; only package description/license
are optional nonempty metadata strings. `effects` is a duplicate-free list from
`commands`, `substitution`, `external-references`, `host-configuration`; hosts use
supported integration IDs. See the [strict format/path contract](development/issue-20-contract.md#2-package-format-and-portable-tree-c01c04)
for exact limits.
Names use lowercase namespace/name; versions are exact stable three-component
strings, without ranges/tags/prereleases. Skill Markdown needs bounded frontmatter
with a nonempty description. Instruction packages can back roles/profiles without
skill frontmatter. Native delivery is skill-only, with supported nonempty hosts
and declared effects. Declarations and archived scripts are inert, not a safety
certificate: trust content before any independent consumer executes it.

Identity hashes every regular file, including hidden files, raw manifest and binary
support, in canonical path order. No ignores/text normalization. Portable ASCII
paths and no symlink/junction/hardlink members are deliberate limits. Digests prove
integrity, not publisher authenticity. Local directories, including a package subtree
in an existing Git checkout, are the only acquisition source. No remote/npm registry
or automatic download, even without `--offline`. Store precedence is explicit
`--store`/API `storeRoot`, then `AGENT_PROFILES_STORE`, then the home store.

Routing stays exact model → alias → supplied family → longest prefix → default;
roles remain independent. Per-binding assignments use strict selector containment:
a combined rule dominates its subsets. Incomparable maxima/duplicate selectors
refuse even at equal versions; no declaration-order tie breaking. Locks cover all
base/override pins. Public package resolution/capture requires a valid lock.
Read-only selection never installs or repairs. Internal configure/preset validation
can apply valid config edits, report `installRequired` and leave stale lock bytes
untouched; dependency install afterward needs its own authorization.

V1 source validation remains; dependency install requires v2 and refuses v1 with
actionable migration guidance without writes. Zero-pin v2 resolve/stamp needs no
lock and ignores an unrelated leftover lock. Explicit install can create an empty
coverage lock; frozen install still requires it. Use the separate
[scalar-only v1 → v2 migration](migrations/config-v1-to-v2.md) before optional adoption.

Managed reconstruction, host dependencies, native invocation, rendered prompt and
runtime identity are separate. `managedReproducible` can be true while native states
remain unverified; `completeRuntimeReproducible` remains false. API
`reconstructStamp({digest, storeRoot, nativeReady: true})` refuses `unsupported-native`.
Record actual model/provider/suite/environment separately in an inert external eval
record referencing the full stamp digest. Those fields do not rewrite the stamp
or prove equivalent execution. No eval runner or model runtime is included.

Cooperative locks/same-filesystem rename assume a supported local backend. Process
interruption may leave staging/locks or complete unacknowledged outputs. No automatic
lock stealing, visible-copy fallback, universal concurrent-edit or power-loss guarantee.
Source/offline tests do not qualify every OS/filesystem/browser/installed artifact/live
host. See [release gates](release.md) and [architecture](architecture.md).

## Store read caching

Each store command checks the store's directories for links and junctions and
verifies every package object it reads. By default it does that once per command:
within one operation, directories already checked and objects and revision records
already verified (all content-addressed) are reused. Between commands, an object is
reused only while every file's metadata (inode, size, timestamps, link count) still
matches what was hashed. `verify`, `diff` and `reconstruct` always re-read every byte
independently, with no caching.

The trade-off: if another process swaps a store directory for a link partway through
a single command, the store may not notice until the next command. Files are always
opened without following links and checked for identity, and every new command
re-verifies objects. If you ever cannot trust reads from your store (a shared
store another account can write to, or a writer you do not control), turn caching off:

```sh
AGENT_PROFILES_STORE_CACHE=off agent-profiles resolve --root /path/to/project
```

`off` makes every command re-check every path and re-read every object, like the
audit commands. Accepted values are `on` (default) and `off`; anything else is refused.
