# Evaluate and improve a role's skill with your coding assistant

If you are deciding whether agents can serve a basic or premium role, start with
[Qualify an agent](agent-qualification.md). It adds a small requirements intake
and a retained qualification report around the evaluation steps here.

Use this workflow to compare a skill change for one model and role, decide whether
to keep it, and repeat for a second model. Your coding assistant prepares the
artifacts and explains the results; you do not need to write migration or
evaluation JSON yourself.

Start by copying the [assistant prompt](#ask-your-coding-assistant). The sections
below explain the choices it will help you make. This is an assistant-assisted
workflow over the existing tools, not a new agent runner or an automatic tuner.

For a concrete first scenario, the [prepared Windows JobBench pilot](jobbench-pilot.md)
uses one technical-writing task and two models. Its native tool-access preflight
must pass before task execution; keep its deployment differences and ungraded
status separate from a full skill-improvement study.

## What you need

- A trusted Agent Profiles checkout with dependencies available and Node 24.
- Python 3.12+ and Harness² at commit
  `1cfe254e8d25b15f37048c3730134686abe60335`; follow the
  [credential-free setup guide](harness2.md) first.
- One supported host, an explicit role, and a skill whose captured entrypoint can
  be edited. Start with Codex or OpenCode; a file layout alone does not establish
  that a particular host/model combination works.
- For real runs, two exact model IDs supported by the chosen executor, provider
  access, a compatible external Harness² benchmark driver, and an execution
  budget you approve. Record executor/model versions and settings. OpenCode's
  [native host contract](hosts/opencode.md) and Harness² executor are separately
  versioned.

The Windows starter captures and exports instructions without model calls. The
full upstream search scheduler needs Linux/WSL and its benchmark dependencies.
Use Linux Node 24 and Python there; do not assume Windows paths work inside WSL.
The assistant must identify an actual runnable benchmark/driver before asking to
start a search. If none fits your tasks, stop at preparation and explain the gap.

## 1. Choose one job and inspect its context

Choose one role matching your job and one skill to improve, for example
`technical-writer` with a documentation skill or `reviewer` with a review skill. Choose
two installed models using their exact provider/model IDs, not names such as
"Opus" or "Qwen" alone. Choose one first; the second is a separate experiment.

Have the assistant inventory the project using [read-only inspection](setup.md),
then show the resolved profile, role, required/available skills, dependencies,
host prerequisites, and any unmapped content. Check [context proof](proof.md)
for what was actually selected and the limits of its measurement.

Required tools must be available in the executor. An unsatisfied requirement,
missing skill bytes, unsupported edit target, or oversized export blocks the
affected run. Do not substitute another skill silently. Role selection does not
enforce host permissions or tool isolation.

## 2. Agree on tasks and a budget

Choose examples of the selected role's real work. The review examples below
illustrate the split; use job-specific tasks for other roles. Begin with a small suite:

| Set | Example purpose | Who may see it |
| --- | --- | --- |
| Tuning | A past review missed a concrete defect; another produced an unsupported finding | The search/editor session |
| Held-out evaluation | Unseen changes requiring the same review responsibilities | The fixed-arm executor; answers/rubrics go only to the grader |
| Regression | Known issues the skill already catches and clean changes it should accept | The fixed-arm executor; answers/rubrics go only to the grader |

Use at least one held-out motivating case and one regression case. Prefer two of
each for the first small comparison. A case includes a unique task ID, a patch or
input, and a grading rule. Use executable checks when possible; otherwise pin a
judge and rubric. Include clean cases to expose false-positive findings.

Keep evaluation inputs and answers out of the tuning session, its files, memory,
and library. Start the search in a separate clean session/workspace containing
only the selected context and tuning tasks. The coordinating assistant may stage
evaluation assets but must not use them to edit the candidate. After evaluating,
freeze that result: edits informed by those outcomes require fresh held-out cases.
Public examples the optimizer has already read are not held-out evidence.

Before any paid execution, the assistant shows the actual search and evaluation
commands, task counts, trial counts, executor/models, judge, network/tool access,
output locations, expected calls, and a spend limit. Separate search cost,
fixed-arm execution cost, and judging cost. Use runner/provider controls for a
hard cap where available; a written budget is not enforcement. If the available
driver cannot enforce the requested limit, explain that before launch and obtain
an explicit decision. Unknown costs are not zero. Preparing a plan does not
authorize model calls.

## 3. Search and review one skill change

Keep experiment artifacts in a new durable directory outside the working project
and both source checkouts. Preserve the active configuration, lockfile, selected
context, and exact before bytes. Never modify the captured base in place.

The assistant uses the [Harness² bridge](hosts/harness2.md#adoption-capture-and-stamp-seeding)
to capture the chosen harness and `start_migration` to select the skill in an
isolated fork. Seed the external search with the **returned evaluation base**,
not the original available-only capture. Keep the exact exported before tree.

Run the approved external search on tuning tasks only. Convert adopted edits
with `proposal_batch`, supplying the saved before tree. Show the proposed diff
and every unsupported edit before accepting anything. Additions, deletions,
scripts, plugins, or edits to composed prompts cannot silently become a
skill-entrypoint candidate. Profile/role-only edits stop at workspace acceptance
under the current candidate contract.

You explicitly accept or reject a proposal. Acceptance edits only the isolated
workspace; it does not adopt a production configuration. The assistant derives
the [candidate manifest](skill-migrations.md#publish-one-advisory-task-only-candidate)
from retained identities, accepted history, and the Node `readPackage` hash,
rather than inventing digests or using a Harness² tree hash. It reserves a distinct
package release version. This skill-package version is separate from the Agent
Profiles application's version.

## 4. Compare frozen baseline and candidate

The assistant generates an `evaluation_plan` from the held-out/regression suite
and retains it with `migrate plan` **before either evaluation arm executes**.
Use the plan's exact base and candidate stamps. Include declared workflow or
collateral obligations; the guided path does not waive native validation.

Run the two external fixed-arm sweeps with separate output roots and run-ID
namespaces. Keep task subset, executor/model, settings, seed, trials, judge and
rubric the same within a comparison. Keep the wrappers' pre-execution sidecars.
Do not adapt the frozen arms while measuring them or use the search's selected
candidate score as this comparison.

Score the sweeps' base rollouts using `harness2-judge --bases` and convert their
`base_judged.json` files with `evaluation_results`. Retain results with
`migrate results`; inspect them with `migrate report`. The
[fixed-arm reference](hosts/harness2.md#convert-fixed-arm-evaluation-evidence-codex)
specifies the exact evidence fields and conditions.

Ask the assistant for a per-case table with baseline/candidate pass counts,
regressions, available cost and other measurements, trial counts, and retained
evidence references. Show unavailable values as **unknown**. The current Harness²
converter imports individual recorded rollout USD costs; tokens, latency, turns
and tool-call metrics remain unavailable through that converter. Do not allocate
task totals to individual rollouts or claim token savings from text length.

A per-case correctness drop blocks default promotion even if the aggregate score
or cost improved. A small trial count gives limited evidence, not a statistical
quality guarantee. Imported outcomes remain external claims.

## 5. Adopt, reject, and restore

You can reject the candidate after seeing its report. Leave the active project
unchanged and retain the candidate/evidence for inspection. Use the existing
abandon/reject operations where appropriate; do not delete immutable history.

For adoption, the assistant generates a decision bound to the exact candidate,
assignment, plan digest, result digest, and reported regressions. It first runs
`migrate preview`, explains the exact affected tuple and files, and obtains your
explicit adoption decision before `migrate promote`. Do not generate a
correctness override by default. Integrity and freshness failures cannot be waived.

Promotion in a captured isolated project changes that project only. To use the
result in your development repository, the assistant must preview a separate
installation/binding change using the existing package/preset/configuration
interfaces, verify the intended tuple there, and obtain approval for that change.
Do not copy a whole captured configuration over your active project.

Before changing an active project, save byte-exact copies of its configuration
and lockfile and record their locations. To restore, first check that the current
files still match the recorded post-change bytes. If they differ, stop and review
the intervening edits. Restore only the affected files from the saved before
copies, then run `doctor`, resolve the original tuple, and compare its pins and
managed context with the recorded baseline. Keep published packages and evidence.
Demonstrate restoration in the isolated example before relying on it in real work.

## 6. Repeat for the second model

Repeat preparation, search, evaluation, and explicit adoption for the second
exact model ID. Use fresh run IDs and output directories. Share the role's
responsibilities and unchanged skill sources; retain model-specific adjustments
only where the evidence justifies them. Do not borrow one model's scores for
another or compare quality across models with different test conditions.

Demonstrate resolving each model/role/host tuple to its intended version, and
check that adopting one tuple preserves the other's pins. Start fresh host
sessions when switching; an old session can retain context. A configuration that
has not been evaluated for the new model/host/version must be labeled untested.

## Ask your coding assistant

Copy this prompt into your coding assistant. Fill in what you know; the assistant
can help discover the remaining choices without running a model.

```text
Guide me through docs/guided-evaluation.md in this Agent Profiles checkout.
If that guide is not present, use the Guided skill evaluation wiki page at
https://github.com/guisam/Agent-Profiles/wiki/Guided-skill-evaluation
and the linked local Harness²/migration references as the workflow source.
Use its existing Node CLI and Harness² bridge; do not add a runner or wizard.

Project: <absolute path>
Agent Profiles checkout: <absolute path>
Harness² checkout: <absolute path>
Role: <the job's role or help me select one>
Skill to improve: <binding or help me select one>
Host: <Codex or OpenCode>
Models: <two exact provider/model IDs or help me select them>
Goal: <the job's quality requirements, existing coverage and unacceptable failures>

Read the guide and linked local references before preparing artifacts. Inspect
the project read-only. Show selected context, required tools, compatibility
failures and unsupported components. Never rewrite repository instructions,
change permissions, substitute another skill, or install runtime components
without an explicit approved change.

Help choose small tuning, held-out and regression sets. Keep held-out inputs
and answers out of the search/editor session, workspace, memory and library;
keep grading answers out of executor context. Pin the rubric and judge.

Find an actual compatible external Harness² driver and verify the pinned
source/executor versions. First run the credential-free setup starter. Show
the exact live commands, output roots, trial/call counts, search/execution/judge
costs, and enforceable budget controls before requesting execution approval.
Do not make model calls until I approve that concrete run and its spend limit.
If a compatible driver or enforceable limit is missing, explain the limitation.

Generate the internal JSON/Python glue for me using the existing APIs and
validators; I should not have to author migration/evaluation JSON. Retain each
generated artifact and native command result in a fresh durable experiment
directory. Use start_migration's returned base and save the exported before
tree before search. Propose one skill-entrypoint change, list unsupported
edits, and obtain my decision before workspace acceptance.

Freeze the candidate and retain its evaluation plan before both fixed-arm
runs. Import matching base-rollout evidence and report per-case outcomes,
regressions and available metrics, with missing measurements marked unknown.
Never fabricate scores, per-rollout costs, identities, or statistical certainty.

Generate and preview an exact promotion decision only if I want adoption.
Ask for explicit adoption approval; no automatic promotion or regression
override. Explain whether it affects an isolated captured project or my active
project. Separately preview/approve any installation into my active project.
Retain before/after config and lock bytes and rehearse guarded restoration.

Repeat independently for the second model, preserving the first tuple's pins.
Show both resolved selections, evidence locations, and restoration results.
Finish by distinguishing preparation, fixture checks and actual live results;
identify unsupported/untested combinations and any remaining steps.
```

## If a step cannot finish

| Problem | Next action |
| --- | --- |
| No compatible driver, model access, or approved budget | Keep the prepared artifacts; do not launch or claim evaluation succeeded. |
| Required skill is only available, not selected | Use the isolated `start_migration` preparation; do not mutate the original capture. |
| Search changes generated prompt text or companions | Review the unsupported-edit report; restrict a new search to the selected entrypoint. |
| Fixed-arm evidence has missing sidecars, mismatched conditions, or reused IDs | Collect fresh correctly attributed evidence; do not rewrite old claims. |
| Candidate loses a previously passing case | Reject or revise it; use fresh held-out cases after outcome-informed edits. |
| Preview says inputs are stale or reports a partial promotion | Preserve all artifacts; inspect status and use the native recovery/replay guidance before any further edit. |
| A restore would overwrite later work | Stop; reconcile the later changes with the saved before/after bytes. |

Track this workflow in [issue #33](https://github.com/guisam/Agent-Profiles/issues/33).
The guide provides the operator instructions; fixture checks and an integration
smoke do not establish that two real models improve at the selected role. Retain that
live qualification separately, with explicit models, tasks, settings and outcomes.
