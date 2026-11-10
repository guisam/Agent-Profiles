# Mixed-model reviewer case study

Agent Profiles delivered different pinned versions of the same skill to Sonnet
5.5 and Opus 5.5 reviewers delegated through T3 Code. Both resolved their own
model and assigned reviewer role before work. Sonnet received 2.0.0; Opus received
3.0.0. The parent was explicitly assigned coordinator.

Read the [case study](https://github.com/guisam/Agent-Profiles/blob/docs/105-mixed-model-case-study/docs/case-studies/mixed-model-reviewers.md)
for the setup, evidence and limits. Repository documentation is proposed as
0.23.2; the experiment ran source 0.23.1. No npm publication is implied.

One attempt per model establishes a bounded selection/delivery result, not
quality or token savings. Effort differed. Sonnet encountered coordinator text
through Graft's searchable cache after AP resolution; AP itself did not deliver
the coordinator role. The shell wrapper was a fixture-only adaptation, tested
by the coordinator but not used by either live child.

Upgrade: documentation only; no configuration, lock, store or bootstrap migration.
No live skill pins change. Remaining coverage is in
[#105](https://github.com/guisam/Agent-Profiles/issues/105); reported PowerShell
argument loss is investigated separately in
[#106](https://github.com/guisam/Agent-Profiles/issues/106).
