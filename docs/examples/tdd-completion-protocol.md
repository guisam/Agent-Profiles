# Proposed TDD completion protocol for issue #33

**Status: proposed, not accepted, not run.** This document prepares the
remaining live work for [issue #33](https://github.com/guisam/Agent-Profiles/issues/33).
It makes no model calls and authorizes no spending, adoption, package
publication or release. Every live step below needs a separate, explicit
maintainer approval of its concrete run and budget.

It proposes a **revision** of the example in the issue's plan, step 1. The
currently planned example is the `technical-writer` role on Codex with
`gpt-6-luna` and `gpt-6.1-sol`. This document proposes replacing it with the
`implementer` role on Claude Code with `claude-opus-5-5` and
`claude-sonnet-5-5`, tuning the `test-driven-development` skill. Until the
maintainer accepts that revision, the Luna/Sol example remains the plan of
record. The [Luna/Sol report](luna-sol-qualification.md) and its evidence stay
unchanged either way.

## 1. Where #33 stands after PR #109

[PR #109](https://github.com/guisam/Agent-Profiles/pull/109), merged as
`f2f30237ad9671ea3271a0f46604fe7d108e44d6` (version 0.23.4), added
[`test/guided-replay.test.js`](../../test/guided-replay.test.js). It replays,
through existing public interfaces and with fixture evidence: selection, an
unknown-host refusal, retained report readback, a refused decision for an
unevaluated model, a read-only preview, an explicit fixture adoption, unchanged
pins for the other models and unchanged unrelated instructions and settings, a
guarded restore that refuses an intervening edit, and restoration to the
baseline stamp. Its Node 24 CI passed.

| Criterion | State after #109 | What is still missing |
| --- | --- | --- |
| 9 — automated checks | **Mechanics covered.** Selection, compatibility failure, retained evidence, adoption and restoration are checked in one connected test. Fixture outcomes are labeled `opaque:caller-claim/…`. | Nothing for the mechanics. Fixture evidence is not live observation; any later live run is labeled separately. |
| 1 — novice entry point | Open | An observed novice walkthrough from the single documented prompt (§7). |
| 4 — reproducible two-model example | Open | A separately approved live run with exact identities and recorded conditions (§3–§6). |
| 7 — explicit adoption, restoration, model switch | Open | A demonstration in a disposable project with a real (not fixture) candidate and an explicit human decision (§7). |

The replay performs the guide's **manual** guarded-restore procedure. There is
no restore command. Fixture checks say nothing about how well a real model
performs, and this document does not repeat the replay.

## 2. Why propose Opus/Sonnet and TDD

The [companion repository](https://github.com/guisam/agent-profiles-superpowers)
already has, at commit `005b1b987810c657079e5299d59fd1417da2adc3`:

- an immutable baseline, `@apsp/test-driven-development-upstream@7.0.2`, made
  from Superpowers `v7.0.2` (`22f0b463e7a5e579904dd6211a520321035526f7`);
- two frozen, contract-checked candidates, one per exact model;
- deterministic checkers for test-first order, attributable RED, mutation
  checks, hidden tests, full-suite runs, scope and approval, plus an isolation
  preflight that checks the delivered context on every run;
- development evidence from two bounded campaigns.

| Development evidence (not held-out) | Result | What it does **not** show |
| --- | --- | --- |
| [`apsp-tdd-001`](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-compaction/CLOSEOUT.md), Sonnet 5.5 screening, 7 cases × 2 arms × 3 reps | 18/21 vs 18/21 under the operator-accepted interpretation (official frozen scores 12/21 vs 14/21); no observed regression; 9.31% lower total execution tokens. Decision PROCEED, meaning "held-out confirmation warranted". | Held-out performance, equivalence, adoption. Stage 2 was designed but not run. |
| [`apsp-tdd-002`](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/smoke/RESULTS.md), Opus 5.5 smoke, 5 cases × 2 arms × 2 reps | Official 4/10 vs 5/10; agent-proposed capture correction 6/10 vs 6/10; no candidate-only failure under either reading; +0.7% total tokens (no execution saving). | Anything beyond development cases. The operator audit is **pending**; the proposed correction is not accepted. |

**Neither candidate is adopted. Neither has held-out confirmation.** The results
are for one model, Claude Code headless, and AP-resolved required delivery
appended to the system prompt; they do not transfer to other models, hosts or
delivery routes.

Tradeoffs of the revision, for the maintainer's decision:

- **For:** frozen candidates, deterministic grading with no model grader,
  measured per-run usage, small per-run cost, and a held-out design
  ([stage 2](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-compaction/stage2/PROPOSAL.md))
  ready to reuse.
- **Against:** the candidates came from the
  [skill-compaction preset](../../examples/presets/skill-compaction/), not from
  a Harness² search. The guide's "improve" step for this example is therefore
  a contract-first edit imported through AP's proposal contract (§5), not the
  external search in the guide's section 3. Harness²'s fixed-arm converter is
  Codex-only, so its evidence path does not apply to Claude Code.
- **Provider:** the Luna/Sol choice of OpenAI was made on 2026-10-23 because the
  Anthropic allowance was temporarily exhausted. Using Anthropic models now
  needs the maintainer to confirm current access and the billing route
  (subscription allowance, no API-key fallback) before approval.

## 3. Frozen identities (recheck before approval)

Record each value again at freeze time. Any mismatch stops preparation (§8).

| Item | Proposed value | Recheck |
| --- | --- | --- |
| Agent Profiles | the merge commit of this protocol's PR (base `f2f30237ad9671ea3271a0f46604fe7d108e44d6`), package version from `package.json` | `git rev-parse HEAD`; `node bin/agent-profiles.ts --version` |
| Companion | `005b1b987810c657079e5299d59fd1417da2adc3` plus any accepted correction commit (§9) | `git -C <companion> rev-parse HEAD` |
| Node | 24.x (24.20.0 observed while preparing) | `node -v` |
| Python | 3.12+ for companion tools (3.14.7 observed) | `python --version` |
| Host | Claude Code headless; 2.1.322 observed while preparing. The companion runs used 2.1.319 (`apsp-tdd-001`). | `claude --version`; a different version is a different campaign |
| Role | `implementer`, the companion consumer role | resolved by `resolve` |
| Models | `claude-opus-5-5` and `claude-sonnet-5-5`, exact IDs, effort `medium` | the `init` event's `model` on every run; no substitution |
| Delivery | AP `resolve --host claude --identity-source host-stated --model <id> --role implementer`, delivered with `--append-system-prompt-file`; required skill, not native discovery | preflight `--arm-skill` equals the materialized arm's `SKILL.md` (§5) |
| Baseline | `@apsp/test-driven-development-upstream@7.0.2`; `SKILL.md` sha256 `64b03fce4aee5a97a93160cea8111f3ba13a17b7c001db4bd5836d67fd10705d` | `readPackage` hash at the frozen AP revision |
| Opus candidate content | `@apsp/test-driven-development-opus-5-5@0.1.0` `SKILL.md` sha256 `4685820f8a2c44cee4d7ff9ac1b190c379dfe7fba9eea6043603e7b0bac35e14` | the native candidate label is decision D-3 |
| Sonnet candidate content | `@apsp/test-driven-development-sonnet-5-5@0.1.0` `SKILL.md` sha256 `4117a24ece8a96e14c2f286dd39ebba79fd98104e551ac28328159229af98fd4` | as above |
| Shared resource | `writing-good-tests.md` sha256 `51471c853306ff92ca8bb41dcaea05f31c0e46b03651f8f3c99754b7172f4ae1`, identical in all three packages | byte comparison |
| Unpackaged dependency | `superpowers:writing-skills`, named by `writing-good-tests.md`, is not packaged | reported, not substituted |

Candidates stay byte-identical to the frozen companion packages. If anyone edits
a candidate, it becomes a new version and must repeat the development checks on
development cases only.

## 4. Cases, grading and repetitions

**Sets.** The companion's R1–R6, N1 and D1–D4 cases are **development** cases:
they shaped the candidates and are spent. They are not held-out evidence.
Fresh held-out and regression cases are authored independently, under the
companion's stage-2
[authoring brief](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-compaction/stage2/AUTHORING-BRIEF.md):
the author sees only the contract, the **baseline** `SKILL.md`,
`writing-good-tests.md` and the brief, never candidates, rationale, development
fixtures, results or audits. The author is the operator, or one fresh agent
session (a model call that needs approval). The same suite serves both models.

| Case | Native `kind` | Purpose |
| --- | --- | --- |
| H1 bug fix, Python | `motivating` | The regression cycle without the removed worked example (hypothesis H3) |
| H2 small feature with an invitation to add options "later" | `motivating` | Minimal GREEN without the removed YAGNI example (H2) |
| H5 real vs mock | `regression` | A behavior both arms should keep: a real in-memory collaborator exists |
| N2 docs-only edit | `regression` | Negative control: no tests created |

Excluded from graded cases until §6 is decided: the configuration exception
(stage-2 H4) and the competing-instruction case (an explicit "just run this
file" vs the full-suite rule). No graded result can depend on an unsettled rule.

**Fixture acceptance before freeze (no model calls):** every hidden assertion
maps to a clause of the request; each fixture has a good, a bad and an
**alternative-valid** reference solution, and the alternative-valid one passes;
the operator or a second reviewer signs off.

**Grading.** Deterministic checkers only, at the companion harness version
recorded in the freeze. One run is **correct** when every M criterion of its case
passes under the frozen rubric. An `unknown` outcome counts as **not correct**
in the native result; the human audit may propose a correction, which is
reported beside the official result and never replaces it. No model grader
(the claims-match-evidence check Gr1 is not measured in this tier; report it as
unmeasured).

**Repetitions.** Three trials per arm per case, with a seeded case order per
trial and counterbalanced arm order. Three trials are screening strength:
roughly ±20 points on the pooled difference. With three trials, a single failed
candidate run in a case where the baseline passes all three is a per-case
correctness drop, and AP blocks default promotion. That is intended.

A confirmation-strength campaign (the stage-2 design: 10 cases × 12 trials per
arm) is a separate, larger proposal and is not requested here.

## 5. Connecting companion evidence to native AP contracts

`apsp-results/1` is the companion's sanitized sharing format. It is **not** AP
native evidence and is never relabeled as such. AP's native path is the
migration candidate, plan, results, report and promotion contracts in
[skill migrations](../skill-migrations.md). Native evidence appears in
`library evidence` only through those readbacks; AP has no evidence import or
export yet.

| Native step | How this example fills it | Gap or condition |
| --- | --- | --- |
| `migrate start` | Disposable consumer (config v3, fresh lock2) with the companion's `implementer` role and the baseline pinned for all models. `--role implementer --model <id> --host claude --sharing fork`, one migration per model. | Host `claude` is supported by `migrate`. The consumer is outside both repositories. |
| `migrate propose` / `accept` | One `package` proposal for the workspace copy of the baseline `SKILL.md`: `before` = baseline bytes, `after` = the frozen candidate bytes. Evidence entry: a caller claim naming the development campaign and the migration's own base stamp. | Proposals edit one existing instruction. `package.yaml`, `writing-good-tests.md` and `LICENSE` stay unchanged, so only `SKILL.md` differs. |
| `migrate candidate` | Task-only candidate with `expectedTreeSha256` from `readPackage`. | **D-3:** the planned release must be a new version of the **baseline package name**, not `@apsp/test-driven-development-<model>`. The companion's variant package and the native candidate are therefore different identities with the same `SKILL.md` bytes. |
| `materialize` | Export the base and candidate stamps with `filesystem-v1` into fresh absent destinations. | The companion harness must deliver the materialized `SKILL.md` bytes. Preflight `--arm-skill` points at the materialized file; any difference stops the run. |
| `migrate plan` | Retained **before** either arm runs. Cases H1, H2 (`motivating`), H5, N2 (`regression`) with literal `input` and `expected` text; `trials: 3`. Conditions: harness `{id: "apsp-tdd-harness", version: <frozen>, settings: {host, hostVersion, effort, flags, delivery}}`, judge `{id: "deterministic-checkers", version: <frozen>, settings: {graders: 0}}`, rubric `{id: <campaign>-rubric, version: <frozen>, settings: {freezeSha256}}`. | `expected` holds the request-level expectation only; hidden test code stays with the grader. |
| `migrate results` | One row per case × trial × side. `correct` = official all-M. Metrics from the CLI `result` event: `costUsd` = reported cost, `tokens` = input + cache creation + cache read + output, `turns` = `num_turns`, `toolCalls` = counted tool uses, `latencyMs` = duration. Missing values are `null`, never 0. `evidenceRef` = opaque `<campaign>/<slot-id>#sha256:<stream hash>`, no paths. | Needs a small **converter** from the companion's private per-run ledger to native result JSON, generated by the assistant or added to the companion (§9). It is glue, not a runner, and it never reads `apsp-results/1` as its source. `costUsd` is API-equivalent reporting for runs paid from a subscription allowance; the result's conditions say so. |
| `migrate report` | Per-case table, regressions and metric coverage. | Correctness stays an external claim; runtime stays unverified. |
| `migrate preview` / `promote` | Only after an explicit human decision, in the disposable project (§7). | Promotion pins the native candidate label (D-3), not the companion's variant package. |

The alternative is the companion's existing route: `update` moves one tuple to
the variant package (#89/#91) with trust approval. That route has **no native
evidence**: `library evidence` shows the variant as untested for every model.
It is valid for opt-in delivery, but it does not satisfy criteria 4 or 7.

## 6. Two separate treatments; one policy decision first

Keep these apart:

1. **Compaction** (the frozen candidates): meaning-preserving by design. Every
   rule, rebuttal, red flag and checklist item is unchanged. This protocol
   evaluates only compaction.
2. **Clarification** of shared failures: a behavioral change to the base text,
   evaluated as its own candidate against the baseline, with its own fresh
   cases. Never folded into a compaction candidate or into these arms.

The shared failures, observed with **identical text in both arms**:

- **Configuration exception.** Upstream lists configuration files under
  "Exceptions (ask your human partner)". No run in either campaign asked. Sonnet
  edited config without a behavior test (0/3 vs 0/3); Opus baseline edited
  silently and the Opus candidate wrote value-only tests (0/2 vs 0/2).
- **Competing instruction.** Asked to "just run test/discount.test.js", all four
  Opus runs followed the user over the skill's full-suite rule and disclosed it.

Identical failures in both arms are not evidence that a policy works or that
compaction preserved it.

**Decision D-1 (configuration rule).** The `apsp-tdd-001` gate fixed a **scoring**
reading: ask before the edit, or write a failing behavior test first; a
value-only test fails. Before any clarification treatment, decide whether that
reading is the intended **policy** to write into a skill, or whether asking is
the only compliant path.

**Decision D-2 (explicit-instruction precedence).** Gate item 4 accepted the
permission reading for an explicit "skip the tests": follow it and disclose.
Decide whether the same precedence applies to an explicit narrower test command
against the full-suite rule, or whether the rule stands unless the user
explicitly waives it.

Until D-1 and D-2 are recorded, the configuration and competing-instruction
cases stay out of every graded case set, and no clarification candidate is
graded.

## 7. Novice entry point and demonstration

The entry point stays [the guided workflow](../guided-evaluation.md) and its
copyable prompt. The novice fills in: project = a disposable consumer, role
`implementer`, skill `test-driven-development`, host Claude Code, models
`claude-opus-5-5` and `claude-sonnet-5-5`, goal "keep test-first behavior while
reducing instruction size". The assistant generates every internal JSON file
with the native validators; the novice supplies requirements and approvals
only.

Record a transcript, the commands and their outputs, and these readbacks in a
fresh durable experiment directory outside both repositories:

1. **Inspection.** `resolve` for each model shows the baseline package and the
   required skill. A near-miss ID (`claude-opus-5`) and an unknown model resolve
   to the baseline and are labeled untested.
2. **Approval of the concrete run** (§10). Without it, stop here: the
   preparation is the result.
3. **Report.** `migrate report` per model, with per-case outcomes, regressions
   and metric coverage, unknowns shown as unknown.
4. **Explicit decision per model.** Adopt or reject, in the novice's words.
   A rejection leaves the project unchanged and is a valid result. A blocked
   report is never adopted to complete the demonstration, and no correctness
   override is generated by default.
5. **Preview and promotion** (adopted tuples only), in the disposable project:
   save byte-exact copies of `agents.yaml` and the lock, record their SHA-256,
   run `migrate preview`, then `migrate promote` after approval. Record the
   after-hashes.
6. **Model switch.** `resolve` for each exact model shows its evaluated
   selection; the other model's pins and all unrelated instructions and
   permissions are byte-identical; `library evidence --model <id>` shows each
   model's own rows and every other model as untested. Start fresh host sessions
   when switching.
7. **Guarded restoration** (the manual procedure in the guide's section 5):
   make an intervening edit, show the restore check refusing it, reconcile,
   then restore the affected files from the saved before-bytes. `doctor`
   reports no new errors, and the baseline stamp digest and selections read
   back. Packages, evidence and promotion history remain in the store.

If neither candidate earns adoption, steps 5–7 are demonstrated with whatever
the novice explicitly adopts in the disposable project, or the demonstration
stays incomplete and is reported that way. Nothing is adopted only to close
the issue.

## 8. Stop conditions

Stop and report, without retrying or substituting, when:

- a recheck in §3 differs (revision, host version, model ID in `init`, digest);
- preflight finds a global instruction, hook, duplicate skill, other-arm text or
  repository access, or the `init` probe shows an unexpected skill, plugin, MCP
  server, hook event or deny-listed term;
- the materialized arm `SKILL.md` differs from the delivered context;
- a proposal, candidate, plan or result command refuses (unsupported edit,
  stale configuration or lock, wrong stamp, foreign evidence);
- the plan is not retained before the first arm run;
- an unmatched approval or scope failure occurs (the candidate fails where the
  baseline passed in the same case) — pause for operator review;
- setup-invalid runs exceed the retry cap, or a usage limit is hit (record,
  wait, resume from the ledger with identical settings);
- a per-run budget cap ends a run (recorded as a failed run, never retried);
- coordinator usage reaches the reported stop threshold (§10).

Retries are only for collector-computed setup faults, at most one per slot.

## 9. Companion record corrections (handoff)

The companion records disagree about the Opus smoke. These are proposed
corrections for the companion maintainer, not edits made here. No human
decision is inferred.

| Source (commit `005b1b9`) | Says | Conflicts with | Proposed correction |
| --- | --- | --- | --- |
| [`experiments/tdd-opus-compaction/README.md` L1–L3](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/README.md#L1-L3) | "prepared, unvalidated"; "**No model has seen this candidate.**" | the completed smoke in [`smoke/RESULTS.md`](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/smoke/RESULTS.md) and [`EXECUTION-LOG.md`](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/EXECUTION-LOG.md) | The file is listed in [`smoke/FREEZE-1.1.0.sha256` L6](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/smoke/FREEZE-1.1.0.sha256#L6). Either keep it frozen and add an unfrozen status note linked from the top-level README, or edit it with a numbered post-run documentation amendment stating that FREEZE-1.1.0 verifies at `005b1b9`. State: smoke completed 2026-11-08, operator audit pending, unvalidated, not adopted. |
| [`packages/test-driven-development-opus-5-5/STATUS.md` L12](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/packages/test-driven-development-opus-5-5/STATUS.md#L12) | "**Evidence:** none for Opus." | the same smoke | Frozen ([FREEZE-1.1.0 L71](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/smoke/FREEZE-1.1.0.sha256#L71)); [`SMOKE-STATUS.md`](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/packages/test-driven-development-opus-5-5/SMOKE-STATUS.md) supplements it but nothing in STATUS points there. Add the pointer through the same amendment, or name SMOKE-STATUS as current wherever STATUS is linked. |
| [`FOR-MAINTAINERS.md` L67–L68](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/FOR-MAINTAINERS.md#L67-L68) | "every pair of runs had the same outcome under the **accepted** scoring" | [`smoke/RESULTS.md` "Operator audit"](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/smoke/RESULTS.md#operator-audit-rubric-required-before-the-final-statement): "The operator decides. Until then, the official scores stand"; [`EXECUTION-LOG.md`](https://github.com/guisam/agent-profiles-superpowers/blob/005b1b987810c657079e5299d59fd1417da2adc3/experiments/tdd-opus-compaction/EXECUTION-LOG.md) and `run-state.json`: "operator audit of 3 items pending" | Replace with: "No candidate-only failure under either reading. Official scores 4/10 vs 5/10 (9/10 paired ties); the agent-proposed capture correction, pending operator audit, gives 6/10 vs 6/10 (10/10 ties)." Keep "accepted" for `apsp-tdd-001`, whose gate was closed. |

After the operator audit, record its verdicts as a separate record beside the
official scores, as `apsp-tdd-001` did. Whatever the verdict, the smoke stays
development evidence.

Proposed companion additions that this protocol depends on: the ledger-to-native
results converter (§5), the held-out fixtures and their freeze, and a
campaign definition for each model. All stay in the companion; AP adds no runner,
dashboard or artifact format.

## 10. Approval-ready budget

Estimates are API-equivalent, from the companion's measured rates: Sonnet about
$0.034 per run (`apsp-tdd-001`, 42 runs), Opus about $0.057 per run
(`apsp-tdd-002`, $1.14 for 20 runs). Held-out tasks may be larger; estimates use
1.5×. List rates were not re-verified. Runs are expected to use subscription
allowance; no API-key fallback without a separate decision.

| Item | Runs (max) | Estimate | Hard limit |
| --- | --- | --- | --- |
| Held-out authoring, fresh agent (optional; operator authoring costs nothing) | 1–2 | $1–3 | stop at $5 |
| Setup smoke, 1 case × 2 arms per model | 4 | ≈ $0.30 | `--max-budget-usd 0.50` per run → $2 |
| Sonnet fixed arms, 4 cases × 2 arms × 3 trials | 24 + ≤ 2 retries | ≈ $1.30 | $0.50 per run → $13 |
| Opus fixed arms, 4 cases × 2 arms × 3 trials | 24 + ≤ 2 retries | ≈ $2.20 | $0.50 per run → $13 |
| Graders | 0 | $0 | none |
| Coordinator (fixtures, converter, dispatch, audit, walkthrough) | — | measured from transcripts | not enforceable; report, and stop at 30M tokens |
| **Total model runs** | **≤ 58** | **≈ $5–7** | **≤ $33** plus coordinator |

The issue's minimum is 16 fixed-arm sessions (2 models × 2 arms × 2 cases × 2
trials). This proposal uses 48 fixed-arm sessions for 4 cases and 3 trials. The
per-run cap is enforced by the CLI; the totals are arithmetic over capped runs,
not a provider-side limit.

## 11. Decisions needed before any live step

- **D-0:** accept or decline this revision of the planned Luna/Sol example, and
  confirm Anthropic access and the billing route.
- **D-1, D-2:** the configuration rule and explicit-instruction precedence (§6).
- **D-3:** the native candidate label. AP's candidate contract publishes a new
  version of the baseline package name. Choose one:
  - accept a distinct, clearly non-upstream version label under
    `@apsp/test-driven-development-upstream` for the evaluation only (no
    prerelease convention is introduced without the maintainer's choice);
  - or open a separate issue to let a candidate publish under a variant package
    name, and wait for it.
- **D-4:** the held-out author: the operator, or one fresh agent session.
- **D-5:** the operator audit of `apsp-tdd-002`'s three items, recorded in the
  companion (does not change official scores).
- **Approval** of the concrete run in §10, its per-run caps and its stop rules.
