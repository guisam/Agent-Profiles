---
name: skill-compaction
description: Use when shortening skill instructions or comparing a compacted skill with its baseline, including when the target model is not yet selected. Not for ordinary summaries or workflow redesign.
license: Apache-2.0
---

# Skill compaction

Remove teaching the target model does not need; preserve direction it still
needs. Optimize for minimum sufficient instruction, not a word-count target.
A model knowing how to act does not establish that it will choose to act.

## Establish the contract

Read the source skill, referenced resources and workflows that use it. Record
the source revision or digest, target model ID, and intended host, tools
and instruction environment. Do not assume the compactor is the target model.
If the target is unspecified, inventory the contract first and ask for the
target before making capability-dependent cuts.

Identify activation and non-activation conditions, required outcomes, decision
rules, ordering, exceptions, permissions, failure handling and completion checks.
Distinguish requirements from recommendations and examples. Extract conditions
hidden in rationale or examples before shortening them. Flag contradictions;
do not silently resolve them or introduce a new approval policy.

Classify passages by function, allowing more than one function per passage:

- Decision guidance: when to act and which action to choose.
- Execution explanation: how to perform the selected action.
- Local knowledge: exact commands, schemas, paths, conventions and tool limits.
- Constraints and verification: what must remain true and what proves success.

Execution explanation is the primary compression target. Keep unique local
knowledge and the complete behavioral contract even when the model can recite it.

## Assess capability

Label capability evidence demonstrated, knowledge-probe-only, or unknown; cite
its source, exact model and environment. Verbal answers and confidence do not
establish execution or spontaneous selection. Qualify any transfer across models.

Distinguish two kinds of edits:

- Editorial: remove duplication or tighten equivalent wording while preserving
  meaning and reminders at the point of action. No capability evidence is needed.
- Capability-dependent: replace teaching with an instruction to use a familiar
  procedure. Support the cut with evidence or mark it as an assumption in an
  unvalidated candidate. Familiar-looking content alone is not proof.

Editorial example: "Record the exit code. Include the exit code in the report."
can become "Record the exit code in the report." Keep repeated checks when they
apply at different action points; those are not equivalent restatements.

Retain uncertain contractual or fragile detail, inline or in an accessible
reference. Missing capability evidence need not block drafting; adoption needs
behavioral evidence. Run probes only within authorized scope and budget, using
existing evaluation tools; otherwise propose them.

## Compact the instructions

Work in this order:

1. Remove redundant sentences, checklist items and headings before trimming
   words. Ask what decision, action or interpretation each changes. A presumed
   model default is a capability assumption, not proven redundancy.
2. Remove explanation that merely justifies an already clear instruction. Keep
   rationale and examples that supply conditions or prevent a plausible mistake.
3. Replace familiar mechanics with a precise procedural term only when its
   meaning matches the source. This is a capability-dependent cut: record the
   evidence label. Keep local choices, exceptions and checks. For example,
   "red-green-refactor" would add a step to a source that only requires a failing
   regression test and a fix; do not introduce that policy through shorthand.
4. Express the remaining direction as trigger, required state and action if
   needed, retaining constraints and verification. Use natural sentences and
   decision rules, not forced pipelines or telegraphic arrow shorthand.

Example source:

> Before fixing a bug, check whether a regression test demonstrates it. A
> regression test exercises the failing behavior and asserts the expected
> result. If none exists, create one using the project's test framework. Run
> it and verify it fails because of the bug. Then fix the bug and rerun the
> test to confirm it passes.

Compacted candidate:

> Before changing behavior, ensure a regression test demonstrates the bug. If
> none exists, write one with the project's test framework and verify it fails
> for the expected reason. Then fix the bug and confirm the test passes.

This removes the definition of regression testing and assumes competence with
the project's test framework. It preserves the trigger, order and checks. Test
that assumption; do not impose this policy on a source that does not require it.

Before deleting, check incoming references: an apparent restatement may be the
only definition another file uses. Preserve an authoritative home and valid
pointers; do not renumber cited rules. Preserve logical force, negation,
quantities, exceptions, sequence, exact interfaces, filenames, formats and licenses.

Keep descriptions focused on selection: distinguishing purpose, triggers and
non-triggers. Remove body-level procedure or explicit-caller narration only when
selection meaning is unchanged. Treat uncertain selection changes separately.

Keep scripts and templates intact; inspection does not authorize execution.
Move occasional detail only with a read condition, verified access and an import
mechanism that preserves the resources. Keep references to other skills valid.

Prepare a separate candidate using the project's existing package or candidate
directory convention; if none exists, use a separate copy of the skill folder.
Keep the baseline and unrelated model selections unchanged. Policy changes or
source defects belong in separate proposals, not hidden compaction edits.

## Audit and hand off

Use a compact change map, grouping related edits:

| Source passage / requirement | Candidate location | Edit kind | Evidence or assumption | Evaluation needed |
| --- | --- | --- | --- | --- |
| Regression-test explanation | Bug-fix instruction | Capability-dependent | unknown: target can use this test framework | Reproduce bug without a technique hint; verify meaningful failing test |

For editorial edits, give the meaning-preservation rationale rather than
inventing capability evidence. Rewrites published by other skill authors suggest
edits; they do not establish effectiveness for the target model.

Before handing off, check:

- Triggers, decisions, exceptions, ordering and logical force survive.
- Permissions and approval requirements are neither weakened nor expanded.
- Exact contracts, resource access and skill-selection behavior are preserved.
- Every capability-dependent cut has evidence or an explicit assumption.

A candidate that changes the contract is not an equivalent compaction.

Report source and candidate size using the same measurement. Name the tokenizer
when reporting tokens; otherwise report bytes. Separate entrypoint reduction
from deferred reference content and total task usage. Do not infer cost savings
from file size alone.

Deliver the candidate, change map, assumptions and proposed evaluation cases in
the project's format. Cover unprompted activation, non-activation, selection,
exceptions, execution, verification and competing instructions. For each case,
state its context, observable outcome and failure condition; grade behavior,
not wording similarity.

Mark the candidate unvalidated until behavioral comparison with the baseline
supports it for the target environment. Do not adopt, publish, or change active
selections merely because the text is shorter or knowledge probes pass. If no
supported reduction remains after contract review, report that outcome instead
of forcing a rewrite.

## Compare with Agent Profiles and an evaluation tool

Apply this section only when trials are authorized.

Agent Profiles selects and delivers instructions; an evaluation tool runs tasks,
captures evidence and scores outcomes. Reuse the project's integration. If no
evaluator is selected, report that choice as unresolved and hand off the candidate
and cases. Packaging and delivery do not prove quality.

For authorized A/B trials, hold model ID, host, tools, permissions, task,
instruction environment and delivery method fixed within each pair; change only
the intended skill content. Verify which text each run received. Record active
plugins and hooks. Preserve the baseline and use isolated trial selections.
Freeze cases, grading criteria, repetition counts, budget and adoption rules
before runs; retain failures and distinguish setup errors from behavioral ones.
Use fresh contexts, alternate arm order and keep graders blind to arm labels.
Include held-out tasks for confirmation after candidate development.

Measure instruction size, task outcomes, constraint compliance and total usage
separately against the acceptance criteria. Keep artifacts, evidence and the
adoption decision distinct. Changing live selections requires authorization.

