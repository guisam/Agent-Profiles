# Superpowers role experiment

The [experimental example](https://github.com/guisam/Agent-Profiles/tree/main/examples/superpowers)
separates approved-plan execution into coordinator, implementer and reviewer roles.
It includes configuration, a role adapter, MIT-attributed worker contracts,
resource-preserving setup instructions and a volunteer report template.

Required skills arrive in full on resolve; available skills and supporting files
load when needed. Every child resolves its own role. After clear or compaction,
resolve instructions again and recover task state from the persisted ledger.
AP supplies instructions, not host permissions or autonomous approval authority.

One Claude trial demonstrated child delivery and coordinator recovery. Cost,
accuracy, unrelated-project isolation and live Sol 6.1 remain open questions.
Volunteers can contribute one small setup, recovery, script or isolation test;
existing subscriptions are sufficient. Read the example's findings and redact
private material before submitting an issue.

This is a repository example, not a Markdown preset or a published library
package. Supporting scripts/templates must remain alongside the upstream skills.
Version 0.19.6 adds documentation only; existing configurations need no migration.

## Follow-up: companion project

The per-model variant work continued in the public
[agent-profiles-superpowers](https://github.com/guisam/agent-profiles-superpowers)
companion: a plugin-free workflow for selecting, delivering and evaluating
model-specific skill variants, with a closed TDD compaction screening for Sonnet 5.5
(no observed regression in the screening suite; not adopted).
