# Live-host observations

Phase 1 of issue #10: observed host behavior, recorded before protocol and schema
decisions. These are observations of one host version, not Agent Profiles
guarantees. Re-run them when the host changes.

## Claude Code 2.1.283 (Windows 11, 2026-09-30)

Method: a disposable Git repository initialized with `agent-profiles init`, driven
through `claude -p --setting-sources project` so user-level hooks and instructions
did not interfere. Hooks logged their stdin and environment. Tool calls were read
from `--output-format stream-json`, and compaction effects from the session
transcript. Each result below is a single run unless noted; model behavior is
sampled, not proven.

Fixture routing: `claude-opus-5-5 → autonomous`, `claude-haiku-4-5 → scaffolded`
(deliberately undated), default `constrained`, default role `implementer`
(available: `testing`). The resolver routes Haiku's real ID to `constrained`.

### Identity

| Observation | Result |
| --- | --- |
| Identity visible to the model | `You are powered by the model named <display>. The exact model ID is <id>.` |
| Alias launch (`--model haiku`) | Model sees the dated ID `claude-haiku-4-5-20251001` |
| Distractor IDs in context | The same prompt lists IDs of *other* Claude models (`Opus 5.5: 'claude-opus-5-5'`, …) |
| Identity after model switch (resume with another `--model`) | The exact-ID sentence updates to the new model |
| Identity in built-in Explore subagent | Present, subagent's own model |
| Identity in custom agent (`.claude/agents/*.md`, `model: haiku`) | Present, the agent's configured model |
| Model in hook stdin (`SessionStart`, `SubagentStart`, `UserPromptSubmit`, `PreCompact`) | **Absent** |
| Model in hook environment | **Absent** (`CLAUDE_EFFORT`, `CLAUDE_CODE_SESSION_ID`, … only) |

### Bootstrap compliance by model

| Model | Profile chosen | Expected (resolver) | Files read beyond the selection |
| --- | --- | --- | --- |
| Haiku 4.5 (3 runs) | `scaffolded` every run | `constrained` | Run 1: every profile and `researcher.md`; run 3: skipped the role file |
| Sonnet 5 | `constrained` | `constrained` | Full body of available `testing`; attempted a `find` outside the repository |
| Opus 5.5 (3 runs) | `autonomous` | `autonomous` | `testing` frontmatter only (`limit: 6`) or a `Glob` existence check |

Haiku treated `claude-haiku-4-5-20251001` as matching the key `claude-haiku-4-5`
(a prefix match the protocol forbids), and its self-reported "files loaded" list
omitted the extra profiles it had read. Sonnet reported loading only metadata
for `testing` after reading its full body. Self-reports are not reliable
evidence of what entered context.

### Instruction surfaces

| Observation | Result |
| --- | --- |
| `CLAUDE.md` in main session | Loaded |
| `AGENTS.md` in main session | **Not loaded**; every model read it only because `BOOTSTRAP.md` says to |
| Bootstrap block in built-in Explore subagent | **Absent** |
| Bootstrap block in custom agent | Present |
| Claude + Codex blocks both installed | Haiku and Opus each bootstrapped once; the `AGENTS.md` block did not cause a second run |

### Lifecycle

| Event | Hook signal | Observed |
| --- | --- | --- |
| Session start | `SessionStart` `source: startup` | — |
| Resume | `SessionStart` `source: resume` | — |
| Model switch (resume Opus session as Haiku) | none specific | Haiku did not re-read configuration; re-routed from memory (to the wrong profile) while Opus's `autonomous.md` stayed in context |
| Manual compaction | `PreCompact` `trigger: manual`, then `SessionStart` `source: compact` | Bootstrap block re-injected via `CLAUDE.md`. Claude Code **re-attached recently read files verbatim**: `BOOTSTRAP.md`, `AGENTS.md`, `roles/implementer.md`, the stale `profiles/autonomous.md`, and the available `testing/SKILL.md` |
| Re-bootstrap after compaction (Haiku) | — | Declined: "its managed block appears in CLAUDE.md, so re-running is not needed" — the ambiguity predicted for `BOOTSTRAP.md`'s run-once line |

Compaction therefore does not remove Agent Profiles context; it can restore a
previous model's profile and an available skill's body as file attachments.

### Skills

| Observation | Result |
| --- | --- |
| `.claude/skills/<id>/SKILL.md` without `name` | Listed by the host as `<id>` (directory name) |
| Host skill listing scope | Project skills plus user/account skills outside the repository, independent of any role |

### Not verified

- Provider-specific identities (Bedrock, Vertex): no provider access in this run.
- Interactive `/model` (approximated by resuming with a different `--model`).
- Automatic (non-manual) compaction.
- Plugin-namespaced skill identifiers (`plugin:skill`) in the listing.

## Resolver bootstrap on Claude Code 2.1.283 (2026-09-30)

After the protocol revision, the same setup was repeated with the packed package
installed as a dev dependency and the managed block asking only for
`npx --no agent-profiles resolve --model "<exact model ID>"`. Allowed tools:
`Bash(npx --no agent-profiles resolve:*)` and
`PowerShell(npx --no agent-profiles resolve:*)`. Fixture routing:
`claude-opus-5-5 → autonomous` (alias `claude-opus-5-5[1m]`), family prefix
`claude-haiku- → scaffolded`, default `constrained`.

| Check | Haiku 4.5 | Sonnet 5 | Opus 5.5 |
| --- | --- | --- | --- |
| Identity passed to `resolve` | `claude-haiku-4-5-20251001` | `claude-sonnet-5` | `claude-opus-5-5` |
| Profile | `scaffolded` (family prefix) ✔ | `constrained` ✔ | `autonomous` ✔ |
| Read `agents.yaml` or profile files itself | No | No | No |
| Read an available skill body | No | No | No |

| Scenario | Observed |
| --- | --- |
| Block said "run from the repository root" | Haiku prefixed `cd /d <root> &&`, which fell outside the allow rule and was denied. Wording changed to "exact command (no `cd` or other prefix)"; later runs used the bare command |
| Windows shell | Haiku and Opus often chose the PowerShell tool first; a Bash-only allow rule was denied there |
| `AGENTS.md` line phrased as a condition | Haiku skipped it and missed the repository rule. Rephrased as a direct instruction when the file exists; Haiku then read it |
| Model switch (Opus → Haiku), prompt about the profile | Haiku re-ran `resolve` with its new ID and reported `scaffolded` |
| Model switch, unrelated task | Haiku did **not** re-run `resolve` |
| Compaction, prompt about the profile | Haiku re-ran `resolve` after compaction |
| Custom agent whose definition only names the role | Haiku agent never ran `resolve` |
| Custom agent whose definition contains the exact `resolve --role reviewer` command | Haiku agent ran it with its own dated ID and the reviewer role |
| `init` over the previous managed block | Replaced the block in place; a second `init` made no changes |
| Claude and Codex blocks both installed | Haiku and Opus each ran `resolve` once, then read `AGENTS.md` without running it again |
| Alias `claude-opus-5-5[1m]` in a YAML flow list | YAML error until quoted: `aliases: ["claude-opus-5-5[1m]"]` |

### Protocol 2 block (host-specific, with provenance)

The block later gained `--host claude --identity-source host-stated`, and `init`
started writing the two allow rules to `.claude/settings.json`.

| Check | Observed |
| --- | --- |
| Rules written by `init`, in a workspace never opened interactively | Claude Code ignored them: "Ignoring 2 permissions.allow entries from .claude/settings.json: this workspace has not been trusted." Both models were denied |
| The same rule strings passed with `--allowedTools` | Haiku and Opus each ran the full command with their own ID and routed correctly |
| Command denied, Opus | Reported the failure and did not route by hand |
| Command denied, Haiku | Read `agents.yaml` and profile files and routed by hand, contrary to the block |
| `init --package` over a copy with the same version string | Skipped the install before the fix; an explicit `--package` now always installs |

A file-level permission check cannot show whether the host applies the rules.
Workspace trust is host state, so doctor reports the rules as present and lists
the trust requirement among Claude Code's capabilities.

Model-side identity copying was reliable in every run. Re-resolution after a
model change without a related prompt was not, so it remains a bootstrap
expectation rather than a guarantee.

## Implications for Phase 2

1. Model-side matching is the dominant failure: the only incorrect routes came
   from a model comparing strings. Aliases and prefixes do not help if the model
   still performs the match; the match must move into code.
2. Claude Code hooks can observe lifecycle events (`startup`, `resume`,
   `compact`, `SubagentStart` with `agent_type`) but not the model. A hook alone
   cannot resolve a profile at session start.
3. The exact-ID sentence is reliable in every observed context, including
   subagents and after a model switch. Copying one string is a far smaller ask
   than interpreting routing rules.
4. Role replacement, model replacement, and "available, not loaded" are not
   achievable in a continuing Claude Code session: compaction re-attaches read
   files. Clean transitions need a new session or agent.
5. Built-in subagents get no bootstrap; custom agents do and carry their own
   model, making them the viable per-role integration point.
6. `AGENTS.md` must stay in the bootstrap for Claude Code, since the host does
   not load it.
