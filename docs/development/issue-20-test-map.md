# Issue 20: requirement-to-test map and bounded implementation packages

> Current checkout status (P9b): P2–P9a implementation and the finite P9b test
> contract were parent-accepted. Configuration v2 validation and the six public
> package/stamp commands are implemented; version 0.1.0 remains unpublished.
> [Current package workflow](../versioned-packages.md) and
> [migration guide/prompt](../migrations/README.md) supersede historical statements
> below that v2/tool validation is unavailable. This P1 proposal/decision history
> remains intact; historical permissions/gates are not current execution authority.
> Artifact/platform qualification and final whole-solution independent review
> remain pending. Documentation authorship is not parent acceptance of its result.

Status: **PROPOSED, no tests or production implementation authorized yet.**
Assignment I20-P1-SOL; baseline `f6ac1c4d7336bbb077d2ba089ffe6937ef6c0caa`.
Read the [proposed contract](issue-20-contract.md) first. C01–C23 below identify
requirements, not existing passing tests. Case names are proposed stable test titles;
future parent assignments freeze their exact file/fullName identities. This document
is a complete issue-level coverage plan, not a claim that downstream assertions ran.

- [Migration pattern](../migrations/README.md), [v1 → v2 guide](../migrations/config-v1-to-v2.md)
  and [AI-tool prompt](../migrations/prompts/config-v1-to-v2.md): C20/C22/C23/P9
  migration evidence was proposed below; v2 fixture validation is now implemented, with current native results recorded by the parent.

## 1. Acceptance demonstration and observable evidence

Use temporary offline repositories, explicitly supplied package directories, and
explicit store/output roots. No paid model, network, hosted registry, Git checkout
switch, host process, installation hook, or evaluation runner is necessary.

A final `offline two-revision managed workflow` case must actually:

1. Create two valid full-tree `@example/security-review` packages, versions `1.0.0`
   and `2.0.0`, with different SKILL.md and resource bytes. Import both and inspect
   both verified trees plus immutable identity records.
2. Configure two fictional exact models in the same reviewer role with base `1.0.0`
   and combined model+role override `2.0.0`. Generate a complete lock; resolve both
   through `resolveInstructions`; assert selected rule, version, digest, profile,
   required/available lists, and unchanged authoritative routing.
3. Stamp both, verify every managed backing object, reconstruct ordered Buffers, and
   compare their real manifest fields. Mutate/delete original local instructions and
   package source directories. Reconstruction still returns the original exact bytes.
4. Copy the portable configuration/lock and explicitly supply the same package bytes
   to a new project/store root; frozen offline install reproduces the exact declared
   dependency set. No absolute source/store paths occur in lock or stamp identity.
5. Materialize both stamps concurrently into two absent children of one approved
   output root. Compare every expected member/path/byte, recompute output digests,
   and show neither output or source/store tree changed because the other was written.
6. Reference the full stamp identity in an inert eval-record fixture, separately
   recording fictional runtime model/provider/suite/environment fields; demonstrate
   these external fields do not rewrite the stamp or claim equivalent executions.

Negative variants below are mandatory, not optional stress extras. A generic error or
nonzero exit is insufficient: assert the named finding/rule, identity, and protected
pre/post bytes. No stubbed store/resolver/materializer may replace the production path
in the final case. Parent reports baseline 226 tests plus lint/typecheck passed; these
were not rerun by I20-P1-SOL and validate no proposed feature.

## 2. Requirement and test ledger

Each row includes an otherwise-valid offline positive control and a one-change
negative control. Multiple titles separated by semicolons are separate assertions/
cases, not permission to hide downstream checks behind an early return. Packages P2
through P9 are defined in section 4. C20–C22 compatibility work is integrated into the
package that changes the applicable surface, not postponed until a broken resolver
has been released.

| ID / contract obligation | Positive cases and exact observable result | Negative/control cases and required observation | Owner |
| --- | --- | --- | --- |
| C01 package identity and strict manifest | `skill and instruction manifests parse`: structured name/version/type/entrypoint/behavior; skill and instruction share format; optional descriptive strings work | `manifest unknown duplicate and unsupported fields reject`: invalid namespace/name/version, nonstring pin, oversized version component, range/tag/prerelease, duplicate keys, unsupported schema/type, unknown lifecycle/script keys, YAML merge/tag/alias/multiple-document fail at exact field; no store publication | P2 |
| C02 entrypoint and passive/native policy | `declared native effects remain inert`: declared commands/config/substitution/references and inert script/binary resources retained without execution; instruction type can back role/profile | `native delivery does not inject`: instruction type with native delivery, empty/native host list, instruction nonempty hosts, unknown/duplicate effects, unsupported host, missing/invalid UTF-8 entrypoint, known undeclared effect all reject precisely; sentinel subprocess/network/hook counters remain zero | P2/P4 |
| C03 raw full-tree hashing and canonical records | `tree hash golden vectors`; `record encoder golden vectors`: manifest/hidden/binary/zero-byte resources included; sort by bytes; copied identical bytes at distinct roots and enumeration orders yield identical digest; JSON key order independent, array order significant | `resource manifest path and newline mutations change digest`; `framing is unambiguous`: different path/content splits cannot alias; CRLF vs LF differs; ignored-file tricks cannot omit content; duplicate JSON keys, floats, negative zero, invalid surrogates reject; independent expected digest not computed with SUT | P2 |
| C04 portability and local boundaries | `portable nested paths preserve bytes`: regular ASCII tree, upper/lower unique filenames, nested files, empty directories ignored; resulting member set exact; approved root canonicalization permits platform ancestor aliases above the boundary | `unsafe tree rejects without repair`: traversal, absolute/UNC/drive, slash/backslash aliases, alternate streams, dot/empty/control/Unicode/trailing-dot names, reserved device names with extensions, case-colliding parent components, file-directory prefixes, .git, symlink/junction/hardlink, pipe/device and linked members/root below canonical approval boundary reject; no outside read/write | P2 |
| C05 local acquisition/provenance | `import local directory and existing git package subtree`: observed local bytes imported; optional full observed commit/repository/subdir in receipt; store parameter/environment/home precedence works without home-layout assumptions | `source trust never fetches`: URL/archive/remote provenance cannot trigger acquisition; malformed expected digest, source mismatch, unsafe source, source mutation/membership change during copy abort; no source/config/Git changes; absolute source only in local receipt | P3 |
| C06 immutable coexistence/reuse/integrity | `two releases coexist and whole trees deduplicate`: both identity records point to matching full trees; repeated same identity/digest returns reused; reading bytes verifies exactly; changing manifest identity prevents body-only dedupe | `same version changed resource conflicts`; `corrupt reused object fails`: different digest cannot replace mapping/tree; altered/missing/extra store member or corrupt identity record never silently repaired; pre/post original bytes equal | P3 |
| C07 interruption/concurrent publication | `concurrent writers and readers see committed complete trees`: independent child processes same/different releases; same content ultimately one object; busy writer can explicit retry; readers never see staging; re-import verified orphan succeeds | `kill before and after publication points`: kill during copy, after object rename before mapping, after mapping commit; incomplete installed revision never visible; stale lock reports store-busy; explicit confirmed recovery preserves committed records; observed device mismatch/EXDEV/ENOTSUP/EOPNOTSUPP and known nonlocal roots report unsupported-filesystem, permission denial retains publication-denied plus code, no copying fallback | P3 |
| C08 unchanged routing/package selection | `exact alias supplied-family prefix and default remain authoritative`: all existing routes and independent role choice exercised, selected revision/rule/provenance asserted; profile/role instruction packages and required/available skill packages read through typed backing | `packages cannot create second routing`: canonical-only model selectors, invalid selectors/binding IDs, file/package or host/package union, wrong package type/delivery, ambiguous conventional file fail; unknown model cannot use a configured-model pin by guessing family identity | P4 |
| C09 assignment dominance/ambiguity | `combined selectors dominate subsets`: model+role over singles, role+profile over role, host+model over host, selector over empty default, binding base for no matches; permutations of mapping order equal; only rules mentioning dependency compete | `incomparable maxima reject`: role vs model, model+role vs host+profile, duplicate identical selectors (even same version) reject with conflicting IDs; a combined dominating rule removes lower ambiguity; hostless input does not match host selector | P4 |
| C10 lock generation/completeness | `lock covers all base and override pins`: unused roles/profile bindings, available-only skills, shadowed assignments and two versions appear; exact package set deduplicated; source provenance distinct from tree digest; canonical config key/assignment order independent | `lock omissions and additions reject`: drop unused override, available pin, base, package record; add foreign pin/package, duplicate identity/pin, inconsistent version/digest/type, absolute locator, unknown fields/versions fail exact coverage/schema; comments reorder does not stale but ordered skill changes do | P5 |
| C11 frozen resolution/integrity | `frozen install preserves lock bytes`: exact local artifacts reused or supplied offline imports; selected package and digest match every pin; read-only resolve has no acquisition writes | `frozen stale mismatch never substitutes`: missing/unsupported lock, changed config/routing/resolver version, missing content, mismatched source/tree, offered newer revision, concurrent config/lock edit fail distinct diagnostics; config/lock/host files unchanged | P5 |
| C12 offline/fresh-root/trust | `fresh root reproduces locked pins`: invocation-authorized safe lock-local locator or explicit name/version/directory source map populates fresh store and same content set; supplied in-root sources record relative locators, external supplied sources record provided; provided works when objects accessible | `offline unavailable and remote source fail clearly`: no implicit lookup/download; source URL, link/escape, duplicate/foreign map identity, identity/digest mismatch, unsafe locator and Git-only provenance without bytes fail; unsafe supplied source is not ignored on store reuse; network/native/npm dispatch counters zero; cache-only late failure may retain only verified immutable additions | P5 |
| C13 exact stamp capture/ordering | `stamp preserves all ordered managed bytes`: profile/role/required/requested order, first-request dedupe, available-unloaded body retained, full package resources, strict UTF-8 entrypoints and raw BOM/CRLF/trailing blank lines/binary assets byte-equal; snapshots published only after backing | `stamp cannot archive trimmed resolver presentation`: remove/change original inputs during capture, declared resource missing, incomplete package backing, invalid selected lock fail; swapped required/requested order differs; available body/resource mutation changes stamp though not injected | P6 |
| C14 stamp identity/machine stability | `same snapshot different roots equals digest`: time/store/source roots/receipt ignored; config unrelated assignments omitted; explicit schema/resolver identity participates | `managed and routing changes affect stamp`: profile, role, shared bytes, path, selected version/digest, identity alias/source, request order, coverage state change digest; runtime/provider fields stay external; stamp never equates package/output digest | P6 |
| C15 verify/reconstruct exact backing | `reconstruct after mutable project deleted`: exact ordered Buffers, required/available metadata, resources, shared bytes and package trees returned entirely from immutable store; all backing checked | `missing mismatched snapshot or closure fails`: missing blob/tree, wrong length, changed/extra resource, corrupted snapshot/domain, dangling reference, wrong revision, omitted available backing, duplicate IDs, impossible composition/order/request permission reject named finding; no live rerouting/repair | P7 |
| C16 honest native/shared/inventory states | `observable shared and project-native bytes retained`: default AGENTS.md capture/absence, explicit ordered shared resources, captured project-native entrypoint with invocation unverified; optional unavailable native reference leaves managed reconstruction true | `required unobserved never fully reproducible`: required user/plugin/native reference, incompatible host, required shared unreadable, unsafe shared path report accurate missing/unverified/unsupported; required capture fails; managed/native/rendered/runtime/complete-inventory claims remain independent; no fake digest | P6/P7 |
| C17 structural comparison | `diff reports exact fields`: equal stamps no change; host/model/profile/role/instruction/shared/resource/request/required/available/version/hash/selector/reference state differences and reorder have stable field paths, before/after; no ranking | `invalid diff input not complete`: missing/mismatched backing on either side yields findings; same version/different digest still reported if internally valid separate synthetic snapshots; set-only comparator cannot pass reorder cases | P7 |
| C18 abstract materialization and output identity | `filesystem plan binds snapshot adapter and files`: verified reconstructed inputs, complete mappings, declared capabilities, full required/available package trees, exact snapshot/raw bytes; independently recomputed plan/output digests stable across roots | `output and receipt independently verified`: mutated generated content, member addition/removal, wrong adapter/version/options, false mappings/capabilities, altered receipt binding reject; receipt excluded from tree avoids self-hash; transformed future adapter fixture cannot change package identity | P8 |
| C19 isolated concurrent filesystem output | `two stamps two destinations coexist`: actual concurrent child writes, exact versions/resources in each, source/store/first output unchanged; no store symlinks; final output readback verified | `destination guards before source access`: existing empty/nonempty directory/file, linked/hardlinked descendant boundary, escape/source/store/known-host target paired with missing source rejects destination first; same-target race one success/one refusal; before-rename kill leaves final absent, after-rename kill leaves complete committed output, never partial; confirmed recovery preserves target, retry refuses destination-exists; no shared host mutation | P8 |
| C20 v1/local/native/configure compatibility | `unchanged v1 local outputs and wizard edits`: all inherited v1 tests preserved; mapped/conventional/native selection unchanged; v2 local role description/lists retain package IDs/versions; inventory shows typed package state not null-file alias | `configure refuses identity-losing edits`: package-backed role file edits, assignment-referenced role deletion, duplicate package/local source, stale selection reject without writes; editing config makes lock stale explicitly, never silently regenerates | P4/P5 |
| C21 presets compatibility | `local-only preset workflows remain exact`; `preset requires bound package skill`: existing validated package binding retained; package unrelated to selected export does not block local-only export | `preset export cannot flatten packages`: selected package skill (included or requires), role/profile package, or identity-losing replace fails preset-package-unsupported before destination creation; unknown v1 package fields fail; conflicting assignments not silently dropped | P4/P5/P9 |
| C22 CLI/diagnostics/inventory/visualizer compatibility | `public commands expose exact provenance and states`: import/install/stamp/verify/diff/materialize CLI through real production APIs; package JSON/text and inventory/visualizer display typed references; v1 text counts unchanged | `command options and identities reject early`: unsupported flags/extra positionals/short or malformed digest/remote source fail; init --package still installs only executable under existing isolated tests; new dependency install never calls npm; no cache paths as portable identity or native claim | P4–P9 |
| C23 full delivery/docs/eval-consumer boundary | `offline two-revision managed workflow` executes section 1 end-to-end; user examples/schema/tutorial match implementation; npm artifact contains runtime/docs and works in permitted smoke environment | `integrity sabotage workflow variants`: changed supporting file/same-label conflict, stale/incomplete lock, missing backing, ambiguous rule, unresolved essential native ref, forbidden destination each stops exact stage without forbidden mutation; eval fixture proves no evaluation runner/runtime equivalence claim | P9 |

C17 names comparison while the contract describes comparison in section 7; C18–C19
cover materialization in section 8. Section ranges in the contract group related IDs;
the ledger here is the authoritative requirement ID meaning, not section numbering.

### Additional internal-relations oracles

- Validate that every package used by composition/required/available appears exactly
  once in snapshot packages, and that packages contains no foreign member. Compare a
  nonempty exact expected set before hashing: `every()` on an empty list is not enough.
- Validate all lock assignment rows, not just currently selected versions. Removing
  a currently unreachable/overridden pin must still fail coverage.
- Diff metadata equality cannot bypass byte backing verification. An intact manifest
  paired with a corrupt resource must fail even when comparing it with itself.
- Required native unverified and optional native unverified need paired controls:
  neither can become a content integrity mismatch; only required dependencies block
  declared native readiness, and neither permits complete runtime reproducibility.
- Package-backed role/profile and local-only version-1 controls are mandatory. Testing
  only skill packages can miss implicit profile files and role `.file` consumers.
- Store corruption tests keep identity/version valid and alter exactly one backing
  byte/member. Same-label/different-digest conflict is distinct from local corruption.
- Verify path checks against case collisions at directory components, not just equal
  full leaf paths. Portable path admission should run on synthetic path descriptors
  as well as native trees where the OS cannot create the invalid fixture.

### Correction controls: precise paired oracles (still proposed, not authored/run)

These supplement, rather than replace, C01–C23. Same underlying provenance and
plan/receipt schema fixes cover both reviewers' overlapping findings.

| Requirement / proposed stable titles | Valid positive control | One-change negative / exact assertion |
| --- | --- | --- |
| C01/C04/C06/C18 `reserved identities encode without narrowing IDs` | Portable trees named @con/review and @team/nul import with unchanged logical identity; store namespace con is x-636f6e and name nul is x-6e756c. Legacy logical skill con uses an explicit safe mapped local file and exports available/x-636f6e/entry.md; all full generated paths satisfy section 2, decode to exact identity, and do not collide with literal x-636f6e ID | An actual package tree member con.txt still rejects; uppercase/odd-length/nonhex encoded aliases reject on decoding; no unencoded device-name output or repaired logical ID is allowed |
| C08/C09 `reachable pairs only and per-binding competition` | example-large routes autonomous; model=example-large and profile=scaffolded rules on one skill are accepted and choose independently in their respective reachable contexts; equal selectors on two disjoint bindings accepted; null-model default/family pairs crossed with every role/host-or-null checked | Replace scaffolded selector with autonomous on the same binding: incomparable rules reject with exact IDs; same selectors repeated on that binding reject even if unreachable; a combined dominating rule is the positive repair, not declaration-order choice. Hostless excludes host-specific rules |
| C10/C12/C22 `source map and locator authorization are reproducible` | API sources [{name,version,directory}] and repeatable CLI source triples import the same exact identities; in-root source records relative locator, external source provided; copied in-root bytes and safe locked locator alone reproduce frozen/offline content under new root | Missing triple operand/duplicate or foreign identity/manifest mismatch, unsafe lock locator, external lock path or Git-only source cannot authorize reads; mismatched explicitly supplied bytes reject even with intact cached object; no network or cwd-relative lookup |
| C11/C20/C21 `config edit applies then required resolve is stale` | Valid locked v2 package project: configure local reviewer description edit and, separately, preset import retaining an existing required package skill both apply through validation mode; changed config survives postwrite validation; result reports lockState stale/installRequired true and old lock bytes remain exact | Subsequent public default-required resolve and createStamp fail stale-lock, no repair; validation-mode result cannot be stamped. Invalid pin/ambiguity/corrupt or missing store bytes still reject and rollback ordinary config writes. No stale old-lock pin substitution |
| C11/C13 `local-only v2 does not require a lock` | V1 preservation plus v2 zero-pin public resolve/stamp succeeds not-required with no lock; leftover stale lock is unchanged; explicit install creates empty coverage lock, frozen install accepts it | Frozen install with no lock still fails; adding any package pin restores required-lock missing/stale/coverage checks, even if pin is unused |
| C13/C14/C15/C17/C18 `profile resource survives deletion`; `role resource survives deletion` | Independent local-profile and local-role fixtures each declare a binary asset; strict composition entry resources contain owning profiles.ID/roles.ID plus blob path/length/digest. Mutate only that asset: stamp changes, diff names resources path/backing. Delete config/instruction/asset sources: reconstruct original Buffer with qualified provenance and export under resources/E(binding)/path | Omit asset from closure, change blob byte/length, spoof owning binding, duplicate path, or remove declared source before capture: precise relation/missing/mismatch rejection. Skill-only coverage cannot substitute for either fixture; package resources field remains [] while full tree includes asset |
| C08/C14/C15/C17 `profile rule provenance changes stamp`; `role rule provenance changes stamp` | Independently select identical profile/role package revision through rule pin-a versus pin-b with identical selectors; retained package selection matches binding/table/backing; bytes/tree remain equal but stamps differ and diff identifies composition package.selectedBy. Base-to-rule change likewise retained | Strip profile/role PackageSelection, mismatch binding/name/version/digest/table/entrypoint, or spoof selectors against selection rejects strict schema/relations; cannot recover provenance from deleted live assignments |
| C13/C14 `requested canonicalization preserves meaning` | Request [required-a, available-b, available-b] records [required-a, available-b]; composition injects required-a once then available-b. Reordering unique available requests changes identity; resource declarations in different order capture path-sorted resources | Unpermitted request fails; duplicate requested IDs in a synthetic strict snapshot or composition/SkillEntry resource disagreement fails relations; sorting requests into a set cannot pass order control |
| C18 `plan receipt schemas recompute from explicit store` | Omitted options and explicit {} produce the same plan/digest; returned Plan/Receipt include adapter/version/options and strict typed mappings. Local/shared mapping packageDigest null, package mapping equals sourceDigest. Recompute exact files/mappings/capabilities using explicit storeRoot despite misleading environment/home | Unknown options/nonobject/null, adapter/version, missing required options/receipt field, false blob packageDigest/mapping/capability or edited plan backing rejects before export; expectation never comes from output. Future supported option identity requires a separately versioned contract, not a fake current supported option |
| C18 `fully valid substituted export fails caller expectation` | Produce two genuinely valid distinct stamps A/B and exports; verify A with expectedStampDigest A and B with expected B using explicit store succeeds | Replace entire A destination with complete internally valid B export plus B receipt; verify with caller A fails stamp-mismatch, despite valid B hashes/mappings/receipt. Changing only receipt to A still fails embedded snapshot/plan/bytes checks |
| C19 `kill before output rename`; `kill after output rename` | Barrier-controlled independent children: before rename kill leaves final absent with uncommitted staging/lock; after rename before readback/release kill leaves exact complete committed content/receipt plus possibly stale lock; operator-confirmed recovery preserves/independently verifies output | No partially visible final on either barrier; recovery never deletes target; retry committed target fails destination-exists. Caught failure before commit cleans only own staging; observed postcommit failure reports committed-but-unacknowledged, never rolls back final |
| C07/C19 `observed filesystem failures remain bounded` | Real qualified local same-device rename publishes complete objects/output; injected descriptors/codes exercise only named observable errors | EXDEV/ENOTSUP/EOPNOTSUPP or device mismatch/nonlocal root yields unsupported-filesystem; EPERM/EACCES yields publication-denied with code, not invented atomicity evidence; no visible-copy fallback. Real OS qualification remains pending, not proven by injection |
| C22 `explicit store reaches every resolver caller` | Two stores with conflicting availability and misleading environment/home: explicit store determines configure/preset preview/apply, wizard/inventory/inspect/doctor, CLI and both startVisualizer resolves; materializer/stamp/verify/diff read only explicit store | Dropping storeRoot in any wrapper would fail exact selection/missing-package assertions; visualizer query cannot override server storeRoot; required public calls cannot accidentally enter validation mode |

### Adjacent migration coverage (C20/C22/C23, P9; proposed, not authored/run)

These are fixture-backed checks of the documented bounded procedure and real released
validators, not a requirement to build an automatic migration engine or new CLI command.

| Requirement / proposed stable titles | Valid positive control | Negative / protected-state observation |
| --- | --- | --- |
| C20 `v1 to v2 base migration preserves local native semantics`; `target validation is a byte-identical no-op` | Guide's plain local/native fixture changes only top-level version; actual v1/v2 resolvers preserve every routing route, independent roles, ordered required/available/requested composition, native metadata and raw instruction bytes; zero pins require no lock, leftover lock unchanged; repeat v2 validation performs no writes/backups | Invalid source, unknown/newer version, missing v2 validator or unclear mapping stops before writes; already-target package-enabled input still needs applicable valid lock/bytes; unavailable validation cannot count as successful no-op |
| C20/C22 `migration approval drift and rollback stay scoped` | Exact preview approval plus verified backup; pre-edit hashes unchanged; post-edit failure restores only own configuration result and verifies original bytes | Unapproved preview or drift refuses write; concurrent later edit prevents rollback, preserving current file and backup with recovery-conflict; no instruction/package/lock/host/Git writes; killed/unverified attempt stays incomplete |
| C22/C23 `migration docs prompt examples match released schema` | Resolve guide examples with actual schemas, verify relative links and eight-section/seven-stage pattern; prompt cites guide and waits for exact approval; reported tools/arguments/exits/hashes bind to real checks; future chain applies adjacent steps separately | Unsupported commands/release numbers, guessed mappings/pins, implied downloads/model calls/publication, package adoption mixed into base conversion, missing next-step guide or unreached validation cannot pass documentation/delivery acceptance |

## 3. Issue deliverables and acceptance traceability

| Literal issue deliverable / acceptance theme | Requirement IDs / final observable cases |
| --- | --- |
| Documented versioned package format; skill and instruction packages | C01–C02, C08; strict manifest and both instruction consumers |
| Deterministic hashing of full supporting trees on Windows/macOS/Linux | C03–C04; golden raw-byte vectors, portable path rejection, cross-platform final gate |
| Content-addressed store; multiple installed revisions; dedup/reuse | C05–C07; two-release byte inventory, identity conflict, corruption, killed-writer/concurrent-reader cases |
| Role/model-specific revisions without checkout switching | C08–C09; existing routes, dominance/ambiguity, same-role two-model selection |
| Portable complete project lockfile | C10, C12; exact all-pin coverage and fresh-root reproduction with accessible artifacts |
| Frozen install refuses mismatch/newer substitution; offline missing fails | C11–C12; unchanged lock bytes, precise missing/mismatch/stale failures and zero network calls |
| Immutable stable stamps with exact managed input identity | C13–C14; raw-byte capture, ordering, cross-root equality and changed-content inequality |
| Snapshot verification and reconstruction without live mutable inputs | C15–C16; deleted-source reconstruction and every missing/tampered backing failure |
| Basic comparison, not semantic quality assessment | C17; stable before/after fields, reorder and native-reference changes |
| Abstract host materialization contract | C18; plan/source/output bindings and independent supported/unverified/unsupported capabilities |
| One actual ordinary-filesystem reference materializer | C18–C19; full exact export, output verification, different-revision simultaneous destinations |
| No false native readiness, isolation, prompt, inventory, or runtime-model claim | C02, C16, C18–C19, C22; explicit independent states and no host invocation/native injection fallback |
| Backward local/configure/preset compatibility | C20–C22; existing v1 preservation, typed consumer audit, explicit unsupported package preset export |
| Automated tests and documentation | All IDs, P9; final source-bound inventory, guides/examples, full regressions and artifact smoke |
| Independent eval-suite reference without building runner | C14, C23; full managed stamp reference plus external runtime provenance fixture |

Every bullet in the issue's focused-test list is covered above: provenance (C05/C10),
safe paths/links (C04/C19), interruptions (C07/C19), concurrency (C07/C19), missing
native dependencies (C16), preset compatibility (C21), and simultaneous revisions
(C06/C08/C19/C23) are not deferred because the first adapter is host-neutral.

## 4. Proposed bounded RED/GREEN packages and path envelopes

**These envelopes are proposals for later parent assignments, not permission now.**
Current original P1 allowed only the two development documents. The separately approved
adjacent-documentation slice permits the three linked migration files and only minimal
crosslink/migration-coverage updates here and in the contract. New module/test names below are intended
seams; the parent must freeze actual filenames and inherited/current/deferred case
identities before each assignment. Keep one routing engine and existing YAML parser.
No new runtime dependency is proposed. No package manager install during P1.

| Package | Bounded result / requirements | Proposed RED paths | Proposed GREEN paths and exclusions |
| --- | --- | --- | --- |
| P2 format/tree/hash | Parsed strict manifest, portable member validation, byte framing, golden vectors (C01–C04) | new test/packages.test.js; test-only fixtures beneath test/fixtures/issue-20/packages/ if needed | new src/packages.js and src/package-hash.js; reuse parse helpers, no routing/CLI/store publication |
| P3 offline store | Verified local import, identity mapping, multi-release immutability, busy/recovery/crash/readers (C05–C07) | new test/package-store.test.js; test-only child-process helper if necessary | new src/package-store.js; P2 modules only for accepted integration fixes; no installer/init/npm/host writes |
| P4 package-aware resolver and caller preservation | v2 validation, role/profile/skill typed backing, dominance/provenance, read-only package selection (C08–C09/C20–C22 subset) | new test/package-resolution.test.js; additions to test/configure.test.js, test/presets.test.js, test/inspect.test.js, test/diagnostics.test.js, test/visualize.test.js, test/external-integration.test.js only as frozen | src/resolve.js, src/skills.js, src/configure.js, src/wizard.js, src/presets.js, src/preset-wizard.js, src/diagnostics.js, src/inspect.js, src/install.js doctor path, src/visualize.js, src/visualizer/app.js; optional new typed-backing helper; no second routing/native launch |
| P5 lock/frozen/offline | Complete pin coverage/config digest, local-only acquisition, immutable frozen lock, fresh-root install (C10–C12, stale-lock caller checks) | new test/package-lock.test.js; locked resolution/configure/preset cases in P4 tests | new src/package-lock.js; src/resolve.js lock consultation and preview semantics; guarded config/preset diagnostics where affected; no auto-config edit, network fetch, or npm dependency installation |
| P6 capture | Exact immutable snapshot/blob publication, selected closure/order/shared/resources/provenance (C13–C14/C16 capture) | new test/stamps.test.js capture cases, P3 store blob cases if needed | new src/stamps.js; src/package-store.js blob/stamp publication reuse; typed backing bridge, no formatted-text snapshot or live-host capture |
| P7 verification/reconstruction/diff | All backing/internal relations verified, exact Buffers and structural changes, honest native statuses (C15–C17) | additions to test/stamps.test.js; new test/stamp-diff.test.js if split | src/stamps.js; optionally new src/stamp-diff.js; no rerouting, source repair, materializer or semantic scoring |
| P8 materialization | Abstract verified adapter plan and actual isolated filesystem export/verify/concurrency (C18–C19) | new test/materialize.test.js; child-process fault helper | new src/materialize.js; immutable publication primitives reused without weakening P3; no bootstrap writes, Claude plugin generator, watcher/host process or shared directory |
| P9 CLI/integration/docs/qualification | Real public workflow, all command surfaces and C23, final preservation gate | new test/package-cli.test.js and test/package-workflow.test.js; scripts/package-smoke.js expectations only under explicit later authority | bin/agent-profiles.js; narrow diagnostics integration; docs/architecture.md, new package/stamp guides, docs/migrations/README.md, docs/migrations/config-v1-to-v2.md, docs/migrations/prompts/config-v1-to-v2.md (adjacent-format consistency, fixture-backed preservation/no-op/rollback and actual released-v2 validation), README.md, CHANGELOG.md, CONTRIBUTING.md as approved; package.json only if necessary artifact/test exposure, no dependency addition implied |

P4–P5 must integrate safety guards as they introduce unions, even if full UI/CLI polish
is P9. A bounded P4 resolver API may temporarily accept explicit preverified package
handles; once P5 exists, public required-mode v2 resolution with any declared package
pins requires a complete nonstale lock; v2 without pins resolves/stamps with
lockState not-required and does not touch leftover lock bytes. Explicit v2 install
can create an empty coverage lock; frozen install still requires that valid lock.
Parent freezes
that temporary seam and inventory; it must not become a parallel selection algorithm.
P4 configure/preset previews and EVERY prewrite/postwrite/apply-return resolver call
use read-only validation mode: schema/assignments and all exact pins verified directly
from store identities, not old lock pins. A legitimate edit applies and reports
installRequired with stale lock bytes unchanged; subsequent public required resolve
fails stale-lock. Validation mode cannot feed createStamp or masquerade as frozen
resolution. Invalid config, ambiguity, missing/corrupt package still fail and preserve
rollback; no imports/relock. Explicit storeRoot travels through plans/apply and all
callers, including both startVisualizer resolve calls; home defaults are not read.

Package-backed role wizard file editing is refused, not secretly converted. Existing
v1 configure remains active. Preset schema-1 rejection is a delivered compatibility
result; a future portable package preset extension is not bundled into P9 without
maintainer decision D5. Guard selected package-backed exports during P4, not after
P9. Final artifact smoke still exercises all newly shipped public commands.

### Intended API seams and fault injection

- Package/tree helpers receive explicit roots and Buffers; hashing never decodes
  resource bytes. Pure canonical framing can be checked without `yaml` installation
  only once production code/dependencies are authorized; P1 only examines documents.
- Store receives explicit root and local source; readers open verified immutable
  objects. Test fault points surround copy completion, object rename, mapping commit,
  and lock release. Fault hooks belong in test-injected filesystem adapters or child
  harnesses, not package manifests or publicly executable callbacks.
- Resolver owns routing and per-binding assignment selection. Lock helper enumerates
  declaration coverage and records resolved identities; it never picks profiles/roles.
- Stamp capture receives the resolver's ordered typed selection and verified backing;
  reconstruction receives only immutable objects and a manifest, never current root.
- Materializer receives verified reconstruction and an approved output boundary;
  planned output receipt is not allowed to supply arbitrary unverified file content.
- CLI depends on these APIs; tests invoke actual Node CLI in subprocesses and parse
  stdout JSON. Inventory/proof/visualizer use the same selection, never implement
  their own version-ranking rules.

## 5. RED evidence, GREEN acceptance, and offline fixture discipline

### RED, once parent accepts the contract

For each bounded package: freeze actual allowed test paths, cases, accepted policy
hashes, source HEAD, and predecessor artifacts. Validate fixture manifests with the
real existing validator where applicable and independent test-only oracles for new
formats. Run the repository's Node built-in runner against the exact current package
cases; capture actual arguments, exit, file/fullName, statuses, and stack frames.
Expected missing-interface errors may establish a seam, **not** prove all downstream
behavior. Report which assertions never executed. Do not add a dummy production module
or break correct v1 behavior merely to produce RED. All fixtures remain offline and
must not import init/npm/network side effects for collection.

Independent fixtures must expose common false passes:

- otherwise-valid resource mutation versus body-only hashing;
- complete nonempty exact membership versus an empty-array `every` check;
- differently ordered arrays versus set-only equality;
- stale/extra/unused lock pins versus only-current-model coverage;
- source-deleted reconstruction versus today's project rerouting;
- missing-source/forbidden-destination paired case versus incidental ENOENT;
- runtime-unverified native reference versus accidentally marked verified;
- actual child termination/concurrent read versus thrown-error-only rollback.

Golden hash/record expectations use an independently written test oracle or fixed
hand-reviewed bytes, not the production helper being tested. Compare raw Buffers,
including BOM/CRLF/blank lines; decoded text equality is not backing equality.

### GREEN and predecessor protection

After parent RED acceptance, freeze tests/fixtures. The GREEN developer edits only
that package's production envelope and cannot weaken or skip accepted assertions.
Required evidence: every inherited preservation case and all current mandatory
cases execute and pass at final source hashes. Later-package cases may remain RED
only when their exact identities/failure categories are enumerated and authorized.
No "N expected failures" totals without the identity set. Skips and unexecuted
business assertions do not count as passing. Rerun focused cases plus inherited safe
regressions; lint/typecheck/full suites apply as the parent assignment specifies.
Return one bounded report; parent reads exact bytes/evidence before releasing a
successor. Writing the plan does not authorize that succession.

### Filesystem and platform fixture policy

Use explicit temporary roots under the task's permitted scratch environment. Never
probe live host skill folders or mutate home defaults. Test home/environment precedence
with injected path inputs. Compare protected source/store/config/lock/output fingerprints
before/after; preserve failures' evidence. Real symlink/hardlink/junction tests require
safe disposable trees and host permission. Where a platform cannot create a special
file, exercise pure path/type validation with explicit descriptors and retain native
coverage as unverified rather than silently skipping qualification. Concurrent tests
use independent processes with barriers around publication points, not probabilistic
sleep races or mocks replacing filesystem behavior. Inject observed rename error codes
and device mismatch descriptors to check bounded diagnostic paths, not a fictitious
universal atomicity detector; qualify real supported local backends separately and
disclose undetectable non-atomic behavior as outside assumptions. Windows alone does not prove
macOS/Linux durability. Package source arrays/path order are randomized in pure tests;
identical byte fixtures copied across platform runners establish hash portability.

No cross-platform CI, dependencies, package smoke install, or host-native process is
launched under P1. Later supported-platform checks are required before claiming portable
publication/materialization; package smoke may require registry access for yaml as
[CONTRIBUTING](../../CONTRIBUTING.md) states and must be separately permitted.

## 6. Review gates, unresolved choices, and current completion boundary

| Gate | Evidence required | Stops progression on |
| --- | --- | --- |
| G0 parent schema/contract assessment | This final document pair's hashes, C01–C23 coverage, schemas/examples, D1–D6 decisions accepted or corrected | Unsettled maintainer policy; no tests/production authorized |
| G1 bounded RED acceptance | Real failures at frozen source hashes, fixture validity, exact case inventory, reached/unreached assertion ledger | Fixture/setup fault misclassified as behavior; missing oracle or decision |
| G2 bounded GREEN acceptance | Final hashes, all predecessor/current passes, exact permitted deferred set, untouched tests/protected files | Inherited regression, unsupported substitution, changed tests, stale evidence |
| G3 final qualification | C23 end-to-end/fresh-root demonstration, all IDs exercised, full regression/typecheck/lint, actual artifact smoke and platform evidence | Any missing required case, skips, claim stronger than platform evidence |
| G4 independent whole-solution review | Fresh reviewer, final exact source/test/docs artifacts and all finding dispositions | Unresolved correctness or evidence gap; Git publication and closure still separately reserved |

D1 is accepted with the maintainer's clarification: use config v2, preserve existing
v1 behavior/tests, and deliver a documented v1 → v2 migration guide plus a companion
AI-tool prompt. Every future configuration bump requires a consistent vN → vN+1
migration path, including prerequisites, preserved semantics, preview/approval,
validation, rollback, and incomplete outcomes. A general automatic migration engine
is not required. Add fixture-backed migration preservation/idempotence/rollback cases
and documentation/prompt consistency checks to C20/C22/C23 and P9 before final delivery;
new migration artifacts are not proof that v2 migration works before implementation.
Broader configuration-document history remains future work, not delivered by locks or
stamps. D2 is accepted: explicit more-specific combined rules resolve conflicts, never
implicit dimension priority or declaration order. Initial D3 format limits are accepted.
D6 explicit interrupted-import recovery is accepted: report busy/error and require
operator-confirmed recovery; no automatic lock deletion or published-package changes.
D4–D5 remain proposed in the contract.
Any changed choice requires updating affected schemas and
oracles before tests encode it: D1 affects C08/C20/C22; D2 C09/C10; D3 C01–C04/C16;
D4 C10/C13–C16; D5 C21/C22; D6 C07/C19. The two-revision materializer is a required
initial deliverable, not a deferred native-plugin project. Runtime/model attestation,
complete host inventory, watchers, and invocation remain unverified/unsupported unless
a later separately accepted adapter supplies evidence; they are not reasons to omit
the portable materializer or expand this issue into an eval runner.

P1 completion means proposed contracts and this full map exist, document checks are
reported at exact final hashes, and repository protection is verified. It does not
mean the proposal is accepted, RED exists, GREEN passed, or the issue is complete.
Original P1 authorized only docs/development/issue-20-contract.md and
docs/development/issue-20-test-map.md. The adjacent-documentation assignment additionally
authorizes docs/migrations/README.md, docs/migrations/config-v1-to-v2.md and
docs/migrations/prompts/config-v1-to-v2.md, with minimal development-doc updates only.
No executable tests, v2 implementation or real consuming-project migration are authorized.
Scratch checkpoint/report evidence is separate.
