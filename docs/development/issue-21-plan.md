# Issue 21: skill migrations — initial implementation plan

Status: IN PROGRESS — workspace/proposal slices and A/B workflow foundation accepted
locally; C snapshot implementation is under coordinator qualification. Issue pending.
This records investigation and proposed sequencing, not an accepted whole-issue
contract. Later maintainer YAGNI direction and bounded parent dispositions supersede
the speculative second-hash design below: reuse existing immutable trees and hashes.
A/B accepted external legacy-adoption metadata, explicit opt-in config3/lock2 and
real workflow composition/checking. C adds opt-in stamp2 with its own record domain,
retained metadata/closure/peer-root evidence and filesystem export; stamp1 remains
unchanged for config1/2. No second evaluated-content hash or storage replacement,
automatic configuration migration, Git automation or release rebuild was accepted.

Current slices also include start/status/abandon, scoped sharing intent, immutable
base capture, editable copies, retained evidence-linked proposals and explicit
accept/reject. Actual fork publication/lineage, dirty/candidate publication,
external evaluations, promotion, session/host attribution and explain remain pending.
The historical proposals below are superseded where they conflict with these
accepted bounded contracts; they do not authorize additional implementation.
See [workspace/proposals](../skill-migrations.md) and
[revision/workflow/snapshot foundation](../revisions.md).

Source: GitHub issue #21, including its acceptance
criteria; no comments were present at inspection.

## Goal and boundaries

Provide local, scoped, evidence-linked changes to the instructions an assignment
(role, exact model identity, host) receives. A developer explicitly accepts
proposals, publishes an immutable candidate, supplies externally produced paired
evaluation results, and promotes or abandons that candidate. Preserve existing
stamps and all assignments outside the explicit scope/collateral set.

Do not build a model runner, grader, retrospective skill, hosted registry, UI,
automatic proposal acceptance, automatic promotion, or cross-project migrations.
No paid models or network-dependent tests are needed for the migration contract.

## Verified starting point

- Base commit: `60e26918c1bc8be65e1bb185057c9405038b5f34`, fetched from GitHub main.
- Work branch: `feat/21-skill-migrations` in a separate issue-21 worktree.
- Runtime observed: Node v24.20.0, npm 11.19.0.
- Dependencies installed from lockfile with `npm ci --ignore-scripts --no-audit --no-fund`.
- Typecheck: PASS. Lint: PASS.
- Full `node --test`: exit 0; 1,756 tests, 1,755 pass, 0 fail, 1 skipped.
  The skipped test is not represented as passing.
- Packed-artifact checks and native macOS/Linux checks were not run for this baseline.
- No production code or tests changed in this investigation.

Baseline logs are local, outside the repository, under Hermes scratch in
`agent-profiles-issue-21-baseline/`. They are temporary diagnostic evidence, not
published or permanent artifacts.

## Existing seams and constraints

- `src/packages.js:38-82`: strict manifest schema; release-only versions; no
  declared dependency or migration metadata fields.
- `src/packages.js:189-198`: complete package tree hashing includes raw manifest
  bytes, paths and resource bytes. Preserve the existing integrity contract.
- `src/package-store.js:220-231`: verification requires stored manifest identity
  to match the name/version being looked up. A release alias cannot simply point
  at an rc object without changing this invariant.
- `src/resolve.js:263-297`: assignment rules support version overrides on an
  existing binding, not assignment-local replacement of the package name or local
  file. Fork selection and scoped local role/profile edits need explicit design.
- `src/stamps.js:237-336`: reuse raw-byte capture and immutable backing, rather
  than treating current mutable sources as historical evidence. Current stamp
  shape has no migration/dirty-state attribution extension.

## First maintainer decision: evaluated content versus package identity

The issue requests prerelease candidates such as `1.2.0-rc.1`, then a final
revision with the same evaluated content hash and no rebuild. Today, `package.yaml`
contains the version and is included in the complete tree digest. Renaming the
version to `1.2.0` therefore changes the package digest even if every instruction
and resource byte remains identical. A direct runtime assertion confirmed this;
a separate assertion confirmed that current manifest parsing rejects prereleases.

Proposed direction, NOT accepted yet:

- Keep the complete package digest and all existing verification intact.
- Define a separate evaluated-content identity whose exact membership is frozen
  before evaluation. It must cover instruction/resource bytes and all behavior-
  relevant metadata, including dependency pins; it is not merely an entrypoint hash.
- Promotion copies no content from the mutable workspace. It uses the verified
  evaluated candidate, permits only explicitly defined release metadata changes,
  and proves evaluated-content identity is unchanged.
- Record both candidate and final package digests and their promotion lineage.

This interprets "same content hash" as the evaluated-content hash, not the old
complete-package digest. Obtain maintainer acceptance before implementing it or
changing the issue's normative wording. If literal complete-package hash equality
is required instead, design a version/identity metadata separation first; do not
silently weaken hashing, rewrite stored objects, or relabel rc bytes as a release.

## Proposed bounded stages

Each stage begins with a frozen requirement-to-test map and tests demonstrating
missing behavior. Parent verification follows implementation. Fresh independent
whole-solution review follows the completed stages; intermediate passes are not
whole-issue acceptance. Worker/model selection remains pending and must honor the
maintainer's role/model preferences and actual runtime availability.

1. **Contract and compatibility design.** Settle the first decision above, then
   define version/dependency metadata, assignment-local fork routing, migration
   records, attribution and dirty/candidate stamp behavior. Define any schema
   increment and adjacent-version migration guide plus companion AI prompt.
   Do not treat a schema bump as preapproved.
2. **Start, scope and evidence.** Base stamps, exclusive assignment ownership,
   shared-versus-fork selection with lineage, explicit unattributed-session binding,
   proposal validation/classification, accept/reject history and isolated overlays.
   Include model-specific/shared-package rejection and repository-only recommendations.
3. **Candidate publishing.** Immutable prereleases and candidate stamps for primary
   and collateral assignments, selected dependency closure, unchanged active
   configuration/lock, no implicit normal selection, iteration and dirty-state rules.
4. **External evaluation contract.** Plan motivating/regression/collateral cases
   under paired conditions; validate fixture-based result ingestion and report
   correctness, reliability and efficiency deltas. Freeze the meaning of missing,
   incomplete and reliable results before using them as promotion gates. No runner.
5. **Guarded promotion and closeout.** Verify candidate/results and stale-input
   guards; refuse regressions without a recorded override; update only the evaluated
   scope and lock; mint new stamps. Define interrupted-operation recovery rather
   than assuming multi-file writes are atomic. Abandon retains evidence/candidates;
   explain shows lineage and accepted evidence for each change.
6. **Host reference adapter and complete validation.** One documented attribution
   adapter with explicit limitations for other hosts; offline fixture tests,
   full regressions, typecheck/lint, packed-artifact check, documentation/changelog,
   fresh independent review and hosted platform checks. Verify current official
   host documentation before implementing hooks. Publication and merge remain
   separate maintainer gates.

## Workspace slice verification

Current local source adds `src/migrations.js`, the CLI integration, focused tests,
a packed-workflow extension, the workspace guide and README/changelog notes.

- Observed initial RED: missing implementation assertion failed, prerequisite
  fixture passed, eleven downstream behavioral bodies were explicitly blocked.
- Observed copy-readback regression RED: injected staged-byte corruption was
  incorrectly accepted. Added pre-publication raw-byte readback; regression passed.
- Initial focused run: 17 tests passed, no failures or skips.
- Initial whole default `node --test`: exit 0; 1,773 tests, 1,772 pass, 0 fail, 1 skipped.
- First independent full slice review found P2: an effective store under migration
  writer cleanup could lose newly captured backing, or a store under migration
  records could break subsequent discovery. No other slice blocker was established.
- Parent reproduced the missing refusal with eight additive equal/descendant tests
  through explicit/environment store selection; a permitted sibling control passed.
- Corrected the boundary before any capture/writes using the existing store selector,
  then passed that frozen store explicitly through resolution/capture/reconstruction.
- Corrected focused run: 26 tests passed, no failures or skips.
- Corrected whole default `node --test`: exit 0; 1,782 tests, 1,781 pass, 0 fail,
  1 skipped. Typecheck and lint also exit 0.
- Corrected `npm run test:package`: exit 0; all existing packed scenarios and the new
  start/edit/status/unchanged-active-content/abandon scenario passed offline.
- Independent targeted recheck: P2 CLOSED with 26 independently passing focused
  tests, no correction-specific reading gaps and no further concrete defect.
  Parent verified the returned module/test/guide hashes against both the delivered
  files and the final-validation manifest. Initial full coverage of unchanged
  boundaries is retained; targeted recheck is not a second full review.
- Parent disposition: workspace slice accepted locally, with the documented scope
  limits and the full issue still incomplete.
- No commits, pushes, PRs, issue updates, host activation or model calls performed
  for this slice. Native macOS/Linux verification remains unperformed locally.

## Proposal slice verification and handoff

The maintainer requested Codex for proposal work. Codex CLI 0.162.1 authored the
new tests, API, CLI, packed scenario and user documentation on verified
`gpt-6.1-sol` (provider openai), not the configured Astra default. Native metadata
confirmed the author session, approval `never`, `workspace-write`, and retained
history across each bounded assignment. Ponytail FULL was supplied verbatim in
binary-delivered prompts. The coordinator owns acceptance and execution evidence.

The author sandbox could start Node but could not spawn its test runner (`EPERM`),
before any assertions. That denial was retained, not called behavioral RED. The
maintainer then approved the explicit split: Codex authors inside the unchanged
sandbox; the coordinator runs inspected synthetic checks through normal tools.
The sandbox was not relaxed. Subsequent author checks are NOT RUN by author,
not retroactively attributed as author passes.

Implemented commands:

- `migrate propose <migration-id> <proposal-file>` imports strict JSON v1 as advice.
- `migrate proposals <migration-id>` lists retained documents/outcomes read-only.
- `migrate accept <migration-id> <proposal-id>` explicitly applies one selected
  instruction only after retained-base, classification and exact-before checks.
- `migrate reject <migration-id> <proposal-id> --reason <text>` retains evidence
  and the rejection reason without applying it.

Current limits remain explicit: one existing selected UTF-8 instruction, literal
before/after text rather than a patch engine, caller-claimed session/excerpt bound
to retained base rather than verified host attribution, no new resources/binaries
or package metadata, repo recommendations never applied, actual package fork
lineage and all publishing/evaluation/promotion stages still pending.

Coordinator verification:

- Observed API RED after admitted execution: three real fixture/validator controls
  passed, one missing-exports assertion failed, 24 behavioral cases blocked.
- Precisely corrected two test-only hard-link diagnostic expectations to the
  existing `unsafe store member` refusal; production validator was unchanged.
- GREEN exposed one invalid negative fixture: a binary resource's NUL-containing
  bytes failed schema validation before its intended classification guard. Parent
  released only otherwise-valid before text for that forbidden-target case,
  preserving all diagnostics and zero-write assertions; no test was removed.
- Observed CLI RED: real start/base fixture passed, five unknown-action cases
  failed at the current entry boundary; later assertions were not called reached.
- Final focused suites: proposal API 28, proposal CLI 6 and lifecycle 26 — all
  60 passed, zero failed/skipped.
- Whole default suite on final runtime/test bytes: 1,816 tests, 1,815 passed,
  zero failed/cancelled, one skipped, exit 0.
- Typecheck and lint passed, including the final smoke-only correction.
- Initial packed run failed before workflow execution: npm stripped the CR only
  from the installed CLI's CRLF shebang. Parent inspected installed npm `fix-bin`
  and independently reproduced that exact one-byte transformation on a scratch
  copy. The narrowly corrected executable expectation preserves all remaining
  bytes and every non-bin file exactly; immutable backing hashing was not changed.
- Complete packed-artifact rerun passed all existing scenarios and the installed
  migration proposal import/list/accept/reject/abandon scenario, including retained
  outcomes/reasons and unchanged active source/config/lock/store/base bytes.
- The full suite's result is reused at unchanged runtime/test hashes after this
  smoke-only correction, not represented as another full-suite execution.

A fresh independent Codex reviewer session (same model family, not the author)
completed the full scoped source/test/guide review with no mandatory reading gaps.
It found no production defect and independently identified the packed-byte oracle
P2. After the bounded author correction and passing coordinator rerun, the same
independent reviewer performed a targeted continuation and CLOSED that P2. Parent
verified final reviewed hashes, untouched non-smoke boundaries, native reviewer
identity, preserved history prefix and unchanged Git index.

Nonblocking advisory explicitly deferred: compensation branches after an outcome
publication failure have static review but no dedicated runtime regression in
this slice. The caught first-target-publication failure is tested. The documented
lack of atomic crash recovery and hostile same-user guarantees remains; no tests
or production changes were added merely to turn this advisory into another phase.

Task artifacts and raw evidence are in Hermes scratch under
`issue-21-codex-red/` and `issue-21-proposal-review/`, including exact prompts,
launch/runtime receipts, source hashes, parent results and independent reports.
Those temporary local evidence paths are not a permanent archive guarantee.
Two tooling files experienced CRLF-to-LF-only drift during earlier author retrieval.
After final review, parent preserved those observed bytes in scratch and restored
`.claude/settings.json` and `.trail/hook.cjs` to their exact pre-run saved bytes,
with guards refusing any substantive/concurrent change. They are not feature edits.

Parent disposition: proposal slice accepted locally. All code remains uncommitted
and unpublished on `feat/21-skill-migrations`; no issue update, PR, activation,
product-side evaluation/provider call or consumer configuration edit was performed.
Native macOS/Linux qualification is not supplied by these Windows-local runs.
Issue #21 is incomplete.

## Progress

- [x] Read live issue scope and acceptance criteria.
- [x] Create isolated feature worktree from current GitHub main.
- [x] Establish local automated baseline.
- [x] Reproduce candidate/release digest constraint without changing production code.
- [x] Implement and independently review the workspace lifecycle slice.
- [x] Implement proposals and explicit acceptance/rejection through Codex TDD.
- [x] Verify API/CLI/default-suite and installed-artifact workflow; close scoped review finding.
- [ ] Accept candidate/release identity semantics.
- [ ] Freeze schemas, API/CLI contract and requirement-to-test map.
- [ ] Implement bounded RED/GREEN stages and assess their evidence.
- [ ] Fresh independent final review and complete validation.
- [ ] Separately authorized commit, push, PR and merge.
