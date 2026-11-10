# Issue #82 subagent-delivery protocol

A disposable test of whether subagents receive complete required instructions
when they should, and only then. It reuses the [#80 fixture](../issue-80/README.md)
unchanged: two required skills ending with lines starting `FIXTURE-FINAL
review-depth:` and `FIXTURE-FINAL shared-language:`, followed by
`End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.`

`prepare.mjs` adds only what the matrix needs:

- a parent-only `coordinator` role with no required skills. Its body has
  a line starting `FIXTURE-ROLE coordinator:` and its output ends with
  `End of Agent Profiles context: 2 section(s): base, coordinator.`
- `.claude/agents/fixture-reviewer.md`: a custom agent whose definition assigns
  role `reviewer`, with no setup reminder.
- `.claude/agents/fixture-unassigned.md`: a custom agent with no role.
- `.mcp.json` registering `agent-profiles mcp --host claude`, bound to the host
  only. A server bound to a role or model imposes it on every caller, children
  included, and refuses a child's own assignment (`test/issue-82-fixture.test.js`).

The configured `default_role` stays `reviewer`, so an unassigned child should
resolve `reviewer` **by default**. That is not the same as inheriting the parent's
role: a child that inherited it would resolve `coordinator`, pass `--role
coordinator`, or show the `FIXTURE-ROLE coordinator` line.

`trace.mjs` summarizes a retained Claude Code transcript and its native subagent
files. Its output gives the entry point, tool order, requested and host-reported
model IDs, resolve arguments, resolved role and the markers in each resolve tool result.

Results of the first runs, including one interactive C1 replication (2026-11-10): `docs/host-observations.md`, section
"Subagent delivery on Claude Code 2.1.322 and T3 Code".

## Setup (deterministic, no model calls)

From this repository, on the branch under test:

```sh
npm ci && npm run build && npm pack            # → guisam-agent-profiles-<version>.tgz
node test/fixtures/issue-82/prepare.mjs <new-dir-outside-any-repo> --package <tgz>
cd <new-dir>
npx --no agent-profiles init --agent claude --mcp
npx --no agent-profiles doctor                  # must report a runnable bootstrap
npx --no agent-profiles resolve --host claude --role coordinator   # last line: base, coordinator.
npx --no agent-profiles resolve --host claude --role reviewer      # last line: 4 section(s) …
```

Use a new directory for each host so transcripts do not mix. Never point the
fixture at a live configuration. To make the failure disposable, rename the skill
file inside the fixture copy, then rename it back:

```sh
mv .agent-profiles/skills/review-depth/SKILL.md .agent-profiles/skills/review-depth/SKILL.md.disabled
mv .agent-profiles/skills/review-depth/SKILL.md.disabled .agent-profiles/skills/review-depth/SKILL.md
```

The MCP server reads the configuration on every call. A server that started
healthy then fails the next `resolve` with `ENOENT` and the incomplete-setup rule,
and works again after the rename back (tested).

## Matrix

| Row | Surface | Child | Assignment | Expected |
| --- | --- | --- | --- | --- |
| P | parent session | none | user assigns `coordinator` | resolve before work; `base, coordinator.` |
| C1 | native subagent | custom `fixture-reviewer` | agent definition: `reviewer` | own resolve with role `reviewer` before other tools; both `FIXTURE-FINAL` lines; 4-section line |
| C2 | native subagent | custom `fixture-unassigned` | none | resolve without a role → default `reviewer`; never `coordinator` |
| B1 | native subagent | built-in `general-purpose` | none | observe: resolves or not; if it resolves, default role, never `coordinator` |
| B2 | native subagent | built-in `Explore` | none | observe (the earlier record says no bootstrap) |
| F1 | native subagent | custom `fixture-reviewer`, skill renamed | definition: `reviewer` | resolve fails; child reports incomplete setup and does no review |
| R1 | native subagent | custom `fixture-reviewer`, skill restored | definition: `reviewer` | succeeds again (recovery) |
| D1 | T3 `delegate_task` child | separate Claude session in the same checkout | none in the brief | resolves with no role → default `reviewer`; never `coordinator` |
| D2 | T3 `delegate_task` child | as D1 | brief assigns `reviewer` | resolves `reviewer` with complete markers |
| DF | T3 `delegate_task` child, skill renamed | as D2 | brief assigns `reviewer` | reports incomplete setup; no review |

Run P–R1 once in Claude Code CLI and once in a T3 Code thread (Claude provider,
`claude-opus-5-5`). D1–DF exist only in T3. A native subagent and a
`delegate_task` child are different surfaces: the first is the host's `Agent`
tool inside one session (`subagents/agent-*.jsonl`); the second is a separate T3
thread and provider session. T3's `delegate_task` `role` field
(`review`, `implementation`, …) is T3 metadata, not an Agent Profiles role; omit it.

## Prompts

Send each prompt to the parent as written, in order, in one parent session. The
task text is neutral: it never mentions setup, Agent Profiles, `resolve` or the
fixture markers.

TASK = ``Review removing the `0` initial value from `items.reduce((sum, item) => sum + item.price, 0)`.``

1. P: `Your assigned Agent Profiles role is coordinator. Reply "ready" once you are set up.`
2. C1: `Use the fixture-reviewer agent. Pass it exactly this text and nothing else: "TASK". Then relay its answer.`
3. C2: the same with `fixture-unassigned`.
4. B1: the same with the built-in `general-purpose` agent.
5. B2: the same with the built-in `Explore` agent.
6. F1: rename the skill (Setup), then the C1 prompt again.
7. R1: rename it back, then the C1 prompt again.

T3 only, in the same parent after step 7:

8. D1: `Use T3 delegate_task (not the Agent tool), isolation shared, Claude provider, model claude-opus-5-5, no role field. Task text exactly: "TASK". Wait for the result and relay it.`
9. D2: the same, task text exactly: `Your assigned Agent Profiles role is reviewer. TASK`
10. DF: rename the skill, repeat the D2 prompt, then rename it back.

## Observation record

One record per row. Fill in only what was observed. A field without evidence is
`unknown`, and a row whose evidence is missing is `unverified`, never a pass.

```yaml
row: C1
host: claude-code-cli | t3-code          # transcript entrypoint: cli, sdk-cli or t3-code
surface: native-subagent | t3-delegate | parent
parent_session: <session id>              # and T3 thread id / child task id for D rows
child: <agent id or child thread id>
agent_type: fixture-reviewer              # meta.json agentType; isBuiltIn
assignment: definition | brief | user | none
requested_model: <Agent tool input model, definition frontmatter, T3 target, or unknown>
host_reported_model: <assistant message.model from the transcript, or unknown>
tool_order: [ToolSearch, resolve(mcp, role=reviewer), ...]
resolve_channel: mcp | shell | none
resolved_role: reviewer                   # "Role:" line of the resolve result
role_source: assigned | default | inherited-parent | none
retrieval_before_role_work: yes | no | unverified
fixture_finals: [true, true]
end_line: "End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language."
failure_behavior: reported-incomplete-and-stopped | proceeded | n/a
evidence: transcript | t3-thread | operator-observed | child-self-report
notes: ""
```

`trace.mjs <parent-session.jsonl>` fills most fields for native subagents. For D
rows, read the child thread (T3 thread view, or the child's own transcript) and
apply the same fields. Record child self-reports only as `child-self-report`.

## Stop conditions

- **Before any child run:** P must pass, with resolve before work and the
  coordinator line present. Otherwise stop and fix the setup; children would
  measure the setup, not delivery.
- **C1 fails** (no resolve, wrong role, missing markers): stop the matrix and
  record it. Only then is a minimal `SubagentStart` reminder through the existing
  `ManagedHook` path in scope. It may only say to call `resolve` with the
  assigned role. It must not contain a guessed model or a role body, and it needs
  a separate decision.
- **A run asks for approval** to change anything outside the fixture copy (host
  registration, user settings, trust, pins, signing keys, the live
  configuration): deny it and stop.
- **Any child edits or writes files** during F1 or DF: record `proceeded` and
  stop the failure rows.
- **The transcript or child thread can't be read:** record `unverified` for the
  affected fields and continue. Don't rerun to fill gaps without a new decision.
- One attempt per row. Repeated trials are out of scope.

## Interactive CLI replication (C1)

Headless `claude -p` evidence counts only as headless. To repeat C1 in an
interactive session, use a fresh fixture copy prepared as in Setup:

1. In a terminal, `cd` to the copy and run `claude --model claude-opus-5-5`.
   To keep user-scope plugins and hooks out, as in the headless run, add
   `--setting-sources project,local`. If you add it, record that you did.
2. If Claude Code asks you to trust the folder or to approve the project
   `agent-profiles` server, approve both for this disposable folder only. Both
   approvals apply only to that folder's path.
3. Send prompt 1 (P), wait for "ready", then send prompt 2 (C1).
4. Run `/exit`. Then run
   `node test/fixtures/issue-82/trace.mjs <newest ~/.claude/projects/<folder-slug>/<session>.jsonl>`
   from this repository, or send the session ID to whoever is recording.
   C1 passes when the `fixture-reviewer` child shows `resolve(mcp|shell, role=reviewer)`
   before any other tool except `ToolSearch`, both `FIXTURE-FINAL` lines are
   `true`, and the final line has 4 sections.

## Limits

- In T3 Code, user-scope MCP servers and hooks load into the fixture session.
  On 2026-11-10 graft wrote a `graft/` cache into the fixture. The cache held the
  parent's latest prompt, and a child's `Grep` returned it. Use neutral parent
  prompts and record what loaded.

- Transcripts show tool calls and tool results as the host recorded them, not the
  model's full context. They contain no hidden reasoning, and none is requested.
- Hooks can't see the model ID; the transcript's `message.model` is the host's
  report, not a resolver input.
- User-scope plugins, hooks and instructions also load into the fixture session
  unless the run excludes them. Record what was loaded.
