# Agent qualification report: <job / scope>

<!-- Assistant: derive this readable view from the accepted intake and validated
native records. Preserve those records. Replace placeholders; use unknown for
missing values. This file is neither native results nor promotion authorization. -->

Date / author: <value>
Status: <blocked / does not meet requirements / needs evidence / ready for adoption review>
Recommendation and reason: <decision and exact gates supporting it>
Accepted intake: <path and digest; decisions still missing>
Application/executor/driver versions: <exact versions and deviations>
Scope: <role, task population, tools, exclusions and intended deployment>

## Per-agent decision

| Service label | Exact model / role / host | Candidate identity / stamp | Decision | Unresolved or failed gates |
| --- | --- | --- | --- | --- |
| <value> | <value> | <value or unknown> | <value> | <value> |

## Requirements and evidence

| Agent | Gate | Accepted requirement | Observation / method | Evidence reference | Pass / fail / unknown |
| --- | --- | --- | --- | --- | --- |
| <value> | Quality, including critical failures | <value> | <value> | <value> | <value> |
| <value> | Regression coverage | <value> | <value> | <value> | <value> |
| <value> | Repeated held-out coverage | <cases × trials> | <covered / planned, failures/timeouts included> | <value> | <value> |
| <value> | Turnaround and boundary | <value> | <execution / queue / retry / review times and coverage> | <value> | <value> |
| <value> | Cost and boundary | <value or explicitly optional> | <measured charges/resources/retries/review; unknowns> | <value> | <value> |

## Native evidence and per-case outcomes

Per model retain: exact assignment, baseline stamp, candidate ID/revision/stamp,
skill/package versions, accepted diff, native plan/result IDs and digests,
`migrate report` output, executor/model settings, tasks/seed/trials, judge/rubric
versions, rollout roots/sidecars, failures and measurement attachments. Mark
missing records unknown; never manufacture them from output text.

| Model | Case / kind | Base passed / trials | Candidate passed / trials | Regression | Evidence |
| --- | --- | --- | --- | --- | --- |
| <value> | <value> | <value or unknown> | <value or unknown> | <value or unknown> | <value> |

Native eligibility: <per model; separate from service decision>
Evidence labels: <integrity, correctness, runtime, promotion; preserve native labels>
Conditions match: <within each pair; cross-model differences and budget changes>
Held-out separation / contamination checks: <method and limitations>
Measurement gaps: <unknown values, missing attempts, excluded work>
Confidence limits: <sample size, observed scope, statistical limits, untested environments>

## Adoption choice and proposed routing

User choice: <pending / reject / revise / gather evidence / explicitly approve>
Native preview / decision / promotion references: <values or not performed>
Active-project installation preview/approval: <values or not performed>
Before/after config and lock backups; guarded restoration result: <references>
Resolved deployment stamps / pins / managed context: <references or not deployed>
Second tuple preserved: <verification or unknown>

| Proposed service | Model / role / host | Deployment identity | Limits | Escalation owner/policy | Enabled? |
| --- | --- | --- | --- | --- | --- |
| <value> | <value> | <not deployed or verified identity> | <accepted limits> | <client/orchestrator responsibility> | No until explicitly adopted and verified |

Qualification is scoped to the recorded evidence, not a general model guarantee.
Record requalification triggers and the next concrete action: <value>.
