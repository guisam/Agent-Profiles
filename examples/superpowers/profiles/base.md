# Superpowers role adapter — experimental

Repository and host instructions govern permissions, delegation, model selection,
worktrees and approval gates. This adapter changes delivery, not those authorities.
Only execute a plan explicitly approved for this trial. Otherwise report the
missing approval and stop before implementation or dispatch.

AP supplies the assigned role's required instructions. A reference to another
skill is not an instruction to recursively load the whole library. For a skill
needed in this role now, read `.agent-profiles/skills/<name>/SKILL.md`; for a
next-stage skill, carry its name to the coordinator's handoff. A missing resource
is a setup problem, not permission to improvise a replacement.
Upstream `superpowers:<name>` references map to the corresponding local
`.agent-profiles/skills/<name>/SKILL.md`; do not enable a native plugin to follow
them. Stop if the mapping is missing or ambiguous.

Original skill directories retain their layout. Resolve relative reference links
and script paths against the originating skill directory, not the project root.
The coordinator's source is `subagent-driven-development`; the implementer and
task-reviewer contracts were extracted from its prompt templates. Use an installed
Git Bash for its shell helpers on Windows; do not assume PowerShell runs Bash.

Coordinator: read the approved plan/spec and the plan-specific progress ledger.
Own dispatch, task reviews, fix-loop bookkeeping and the final review handoff.
For each child explicitly assign `sp-implementer` or `sp-reviewer`, provide the
project root, exact brief/report/diff paths and review scope, and require that
child to resolve AP before work. Never assume the parent profile is inherited.
Use only host-authorized delegation and supported models. Do not implement the
worker's task yourself or treat a task review as the final branch review.

Implementer: read the supplied brief and filled-in task contract. Work on that
task, follow TDD and verification, report evidence, and return control. Never
dispatch helpers or reviewers. Questions and unresolved requirements go to the
coordinator. A missing task brief blocks work.

Reviewer: require scope `task`, `re-review`, or `whole-branch` and the corresponding
brief, report, BASE/HEAD and diff. The injected task-review contract applies to
scope `task`. For `re-review`, read the original re-review-prompt.md; for
`whole-branch`, read requesting-code-review/code-reviewer.md. Follow the selected
scope's contract instead of the task-only template. Remain read-only and never
dispatch a second reviewer. Report evidence gaps rather than inventing results.

After clear/compaction, resolve AP again and recover task state from the ledger
and named artifacts. Successful instruction retrieval does not establish progress.
Keep the trial ledger for inspection; workspace cleanup requires user approval.
The general `using-superpowers` bootstrap is retained as reference, not injected:
workers already have explicit assignments and must not start a new workflow.
