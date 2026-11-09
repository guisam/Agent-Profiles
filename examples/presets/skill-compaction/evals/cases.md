# Skill compaction evaluation protocol

Status: draft, not executed. Suite version 0.2.1 in [cases.json](cases.json).
These are development cases for the compaction skill, not held-out confirmation
and not proof that its generated candidates work. They ship with npm source;
preset import copies neither these cases nor their evaluator-only criteria.
The JSON is tool-neutral case data, not a claimed Agent Profiles or evaluator
API format. Adapt it to the chosen evaluator before freezing a run.

## Setup and exposure

Use a fresh context and disposable workspace per case and repetition. Offer
skill-compaction through ordinary available-skill discovery, not the preset's
required-skill role or an explicit invocation. This is necessary to test
non-activation. Expose only the discovery metadata before selection.

This suite tests standalone/available-skill discovery, not the shipped
`skill-compactor` role: that role always supplies the skill as required. Results
from C2/C3 apply only to discovery installations. Testing the required-role mode
needs a separately declared suite: omit selection criteria, test behavior after
delivery, and do not pool its results with discovery results. Do not change the
shipped role merely to make selection tests pass. Record the exposure mode and
actual configuration with each run.

Materialize each case's `files` verbatim at their relative paths. Supply only
`request` as the user message. For C1, also supply `context` as ordinary project
guidance. Never give the agent this protocol, case IDs, `select_skill`, criteria,
other cases, or the result template. Treat source skill files as editing inputs,
not instructions to execute their workflows. Record file changes and skill-load
events. If the host cannot expose discovery or selection, report that dimension
as unmeasured rather than inferring a pass from a plausible response.

There is no previous project conversation. Target-model identity is available
from the host in C1, C4 and C6; in C5 it is deliberately unspecified. An executing
model's identity is not evidence that it is the intended compaction target.
No trials, live selection changes or publication are authorized by case requests.

## Fixed trial plan

Before calls, record and freeze the actual model ID, host, competing instructions
and hooks, tools, permissions, skill hash, suite hash, evaluator, grader prompt
and approved budget. For a revision comparison, freeze both skill versions and
keep all other settings equal. Randomize opaque run IDs; alternate which revision
runs first across repetitions.

- Six cases, three repetitions each: 18 agent calls per skill revision, or 36
  for a two-revision comparison. No feedback or retries based on quality.
- One fresh, blinded grader per result: 18 grader calls per revision. A human
  audits every failure and partial grade, every result for C1 and C6, and all
  criterion grades for repetition 1 of the remaining cases, including passes.
  This audit sample is fixed before runs. Preserve original and adjudicated
  grades separately and record review cost. Report uncompleted audits as pending.
- At most one retry per setup-invalid agent slot, capped at two per revision.
  Allow at most two extra grader attempts per revision for incomplete or invalid
  output, never disagreement with the judgment. Maximum per revision: 20 agent
  and 20 grader attempts. Record all attempts and stop on rate limits rather
  than dispatching another batch. Unfilled slots mean incomplete evidence;
  denominators never shrink.
- Completed tasks that violate instructions are behavioral failures, not setup
  errors. Unauthorized execution, publication or live-selection changes stop
  the run for operator review.

This plan proposes limits; it does not authorize execution or spending.

## Scoring

Grade every criterion: `pass` = fully met, `partial` = mixed or insufficient
evidence, `fail` = contradicted or omitted. Attach a short quote or file/tool-event
reference to each grade. All criteria are required; a case passes only when every
criterion passes. Preserve partial grades but count them as non-passes in totals.
Do not score exact wording, identical outputs, arbitrary compression percentages,
or refusal to make a cosmetic edit as defects.

Each attempt ends after one assistant response, including any preceding tool
use. A clarifying question may end a valid attempt; no user follow-up is supplied.
Grade only what is observable at that point. C5 can fully pass by inventorying
the contract and asking for the target without producing a candidate. C6 can
fully pass by identifying the conflict and asking for a policy decision while
preserving unaffected obligations. Neither requires resolving missing input.
A question alone does not satisfy the inventory/conflict criteria. In C1, a
question does not substitute for the candidate when the request supplies enough
information. Missing outputs remain non-passes, not setup errors or retry grounds.

Use deterministic evidence for unchanged sources, new candidate files, tool
execution and size reports. Recompute UTF-8 byte counts; for token reports verify
the named tokenizer and consistent inputs. Judge semantic preservation against
the source, including conditions embedded in examples. An editorial equivalent
may pass even in C4; the requirement is no contract loss, not a predetermined
answer that shortening is impossible.

Record per-case counts across three repetitions and every changed criterion.
A revision is eligible for further validation only with complete data, no
observed per-case pass-count drop, no unauthorized action or lost contract
condition, and an observed improvement in a predeclared outcome. Ties support no
superiority claim. These development cases alone never authorize adoption;
confirmation requires new independently authored tasks after the candidate is fixed.
Three repetitions are a conservative screening sample: a single unlucky run can
block advancement. Passing this gate does not establish reliability or statistical
non-inferiority; report counts and uncertainty rather than proof of equivalence.

## Result record

Use [result-template.json](result-template.json) per attempt. Replace nulls with
observations or leave null with a reason in `unknowns`. Copy every criterion ID
for the case into `criteria`, with records shaped as
`{"grade":"pass|partial|fail","evidence":"quote or artifact reference"}`.
Invalid attempts have `setup_valid: false` and an `invalid_reason`, not fabricated
quality grades. Preserve prompts, responses, events and file snapshots privately;
reference their hashes and paths. The template contains no example passing result.
