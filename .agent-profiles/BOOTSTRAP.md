<!-- agent-profiles:protocol 2. Managed reference: agent-profiles init replaces local edits. -->
# Agent Profiles routing

This file documents the protocol for people and host integrations. Agents do not
need to read it: the managed block in the host instruction file asks the agent to
run the resolver, which performs every routing decision in code.

## Terms

- **Resolve**: choose the profile, role, and skills from `agents.yaml` and the
  supplied identity. Only `agent-profiles resolve` or the resolver API resolves.
- **Inject**: add Agent Profiles instruction text to the agent's context.
- **Expose**: list a skill's ID and description without injecting or invoking it.
- **Invoke**: use the host's own skill mechanism for a host-native skill.

## Protocol

1. The agent runs `npx --no agent-profiles resolve --model "<exact model ID>"`,
   copying the model ID its host states for it. It omits `--model` when the host
   states none, and never uses a display name, another model's ID, or recollection.
   It adds `--role <id>` only when the user or its agent definition assigns one.
2. The resolver validates the whole configuration and resolves one profile:
   exact model key, then configured alias, then supplied family, then the longest
   configured family prefix, then `default_profile`. Matching is exact and
   case-sensitive. Roles resolve independently: the assigned role, else `default_role`.
3. The output injects the profile, the role, and required instruction skills; names
   required host skills to invoke; and exposes available skills.
4. **Required** skills apply to all work in the role. **Available** skills are used
   only when the current task falls within the skill's description; an instruction
   skill is then read from its path, a host skill invoked.
5. The agent runs `resolve` again after compaction, in a new agent context, after
   a model change, or to change role. Each output supersedes earlier Agent Profiles
   instructions in that context.
6. If `resolve` fails, the agent reports the error. It does not read
   `.agent-profiles/` to route by hand.

## What each mode can guarantee

In **bootstrap mode** (a managed block in `CLAUDE.md` or `AGENTS.md`), Agent
Profiles guarantees the configuration check, the resolution for a given identity
and role, and the generated instructions. Whether the agent runs the command,
copies the right identity, re-runs it on lifecycle events, or disregards
superseded text is agent and host behavior. Text already in context cannot be
removed, and the host may still expose skills a role does not list.

A **native integration** calls the resolver while the host builds context, so it
can supply identity and lifecycle events itself and replace context cleanly.

See `docs/architecture.md` in the Agent Profiles package for the full contract
and `docs/host-observations.md` for observed host behavior.
