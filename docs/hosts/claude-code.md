# Claude Code compatibility record

Observed during issue #10 on **Claude Code 2.1.283, Windows 11, 2026-09-30**,
with Claude Haiku 4.5, Sonnet 5, and Opus 5.5 driven through `claude -p`. This is
a record of what was seen, not a promise about other Claude Code versions.
Method and raw results are in [host-observations.md](../host-observations.md).

| Status | Meaning |
| --- | --- |
| **verified** | Observed directly, from transcripts or tool calls, not model self-reports |
| **limited** | Works only under the stated conditions, or not reliably across models |
| **host-dependent** | Decided by Claude Code state or settings that Agent Profiles cannot observe |
| **unverified** | Not tested |

## Identity

| Behavior | Status |
| --- | --- |
| Every session states `The exact model ID is <id>.`, including the Explore subagent, custom agents, and after resuming with another model | verified |
| Launching with an alias (`--model haiku`) exposes the dated ID `claude-haiku-4-5-20251001` | verified |
| The same prompt lists other models' IDs as distractors | verified |
| Hooks (`SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreCompact`) and their environment carry no model | verified |
| Bedrock or Vertex model IDs | unverified |

## Routing with the resolver bootstrap

| Behavior | Status |
| --- | --- |
| **Opus** copies its exact ID into `resolve`, routes by exact model, and reads no configuration itself, in every run | verified |
| **Opus** reports a denied `resolve` and does not route by hand | verified |
| **Haiku** copies its dated ID and routes by family prefix, after two wording fixes (no `cd` prefix; a direct `AGENTS.md` instruction) | verified |
| **Haiku** falls back to reading `agents.yaml` by hand when `resolve` is denied, contrary to the block | limited |
| **Sonnet** routes correctly with the resolver bootstrap (1 run, before `--host` and `--identity-source` were added) | limited |
| With the earlier model-side protocol, Haiku fuzzy-matched IDs and misrouted in 3 of 3 runs | verified (historical) |
| Claude Code does not load `AGENTS.md`; agents read it when `resolve` output tells them to | verified |
| With Claude and Codex blocks both installed, each model resolves once per context | verified |

## Skills

| Behavior | Status |
| --- | --- |
| A project skill without frontmatter `name` is listed under its directory name | verified |
| Claude Code lists every project, user, and account skill to every session, whatever the role | verified |
| A required host skill is invoked through Claude Code's Skill tool when `resolve` names it | unverified |

## Permissions and workspace trust

| Behavior | Status |
| --- | --- |
| `Bash(npx --no agent-profiles resolve:*)` and `PowerShell(npx --no agent-profiles resolve:*)` allow the full bootstrap command | verified (supplied with `--allowedTools`) |
| A `cd … &&` prefix falls outside the rule and is denied | verified |
| On Windows, models often choose the PowerShell tool first | verified |
| Rules in `.claude/settings.json` are ignored until the workspace is trusted ("this workspace has not been trusted") | verified, host-dependent |
| After the workspace is trusted, the same rules apply | unverified (stated by Claude Code's message; not tested) |

`doctor` checks that the rules are present on disk. It cannot see workspace
trust. Until the workspace is trusted, each session asks for approval of `resolve`.

## Lifecycle

| Behavior | Status |
| --- | --- |
| Resuming with another model updates the stated ID | verified |
| After a model switch, the agent re-runs `resolve` when asked about its profile | limited: Haiku did **not** re-run on an unrelated task |
| Manual `/compact` re-injects `CLAUDE.md` and re-attaches recently read files verbatim, including a previous model's profile | verified |
| After compaction, the agent re-runs `resolve` when asked about its profile | limited |
| Interactive `/model` and automatic compaction | unverified |

## Subagents and custom agents

| Behavior | Status |
| --- | --- |
| The built-in Explore subagent does not receive the `CLAUDE.md` block, so it gets no profile | verified |
| A custom agent (`.claude/agents/*.md`) receives the block | verified |
| A custom agent whose definition only names a role does not run `resolve` (Haiku) | verified |
| A custom agent whose definition contains the exact `resolve --role` command runs it with its own ID (Haiku) | verified |

## Not covered

macOS and Linux hosts, other Claude Code versions, Sonnet on the final protocol-2
block, provider identities, a trusted workspace end to end, and host skill
invocation were not tested. Re-run the [live-host checklist](../release.md#live-host-checks)
before relying on any of them.
