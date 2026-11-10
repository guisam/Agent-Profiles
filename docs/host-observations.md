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
| Bootstrap block in built-in Explore subagent | **Absent** (re-observed with protocol 3 in Claude Code 2.1.322 and T3 Code, #82) |
| Bootstrap block in built-in general-purpose subagent | Present (Claude Code 2.1.322 and T3 Code, #82) |
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

## MCP service on Claude Code (Windows 11, 2026-11-03)

Claude Code 2.1.317, interactive sessions, Opus 5.5 (`claude-opus-5-5`), Agent
Profiles 0.7.0 packed from source and installed in a throwaway repository with
`init --agent claude --mcp`. The checks follow `docs/mcp.md`; answers are the
operator's observations of the sessions.

| Check | Setup | Observation |
| --- | --- | --- |
| Connection | `claude mcp add --scope project agent-profiles -- npx --no agent-profiles mcp --host claude`; server approved at startup | `/mcp` shows the server connected |
| Tool without shell rules | Both `npx --no agent-profiles resolve` allow rules removed from `.claude/settings.json`; asked "What Agent Profiles profile and role are you using?" | The agent called the `resolve` tool with `host: claude` and its exact ID; no shell command and no permission prompt. Resolution: `constrained` (default profile), `implementer` (default role), `testing` available |
| Workspace roots | User-scope server started with `cmd /c "cd /d C:\ && node .../agent-profiles.ts mcp --host claude"`, no `--root`; asked to call `resolve` with no `root` | Resolved the throwaway repository. Its working directory was not a repository, so only the roots Claude Code sent could select it |
| Bound instructions | `claude --mcp-config bound.json` with `--model claude-opus-5-5 --role reviewer`; asked to quote the stamp line | The same `Stamp: sha256 af06a096…6d2a86 (not retained; …)` line quoted at start, after `/compact`, and after `/clear`. After `/clear` the agent said the profile came from the server's instructions and did not call `resolve` |
| Bound payload truncation (#80, 0.19.2) | Bound server, `--model claude-opus-5-5 --role reviewer`, two required packages of 4,940 and 3,986 bytes; Claude Code CLI and T3 Code | The instructions reached the agent with a literal `[truncated]` marker inside the first skill; the second skill was absent. After `/clear` a neutral review task proceeded on the partial copy. In T3 the server was still connecting at the start of the turn. The truncating component and exact limit were not identified. 0.19.3 stops embedding the profile |
| Neutral task after the #80 fix (0.19.3, PR #81 at `95b8594`) | Same bound selectors and packages; protocol 3 `init --mcp` block in `CLAUDE.md`; native Ponytail disabled, Superpowers present; one fresh, `/clear` and `/compact` sequence each in T3 Code and Claude Code CLI with Opus 5.5; task: review removing the `0` initial value from a JavaScript `reduce`, with no setup reminder | All six runs loaded `resolve` through `ToolSearch` and called it before reviewing, retrieved both skill bodies, and showed `End of Agent Profiles context: 4 section(s): base, reviewer, ponytail-review, shared-technical-language.` After `/compact` the agent retrieved again instead of relying on the summary. Without the `CLAUDE.md` block, T3 reviewed before the server finished connecting. Evidence is operator-observed output and agent-reported tool histories from one sequence per host, not a protocol trace. Not covered: shell fallback while MCP is delayed or unavailable, Superpowers disabled, subagents, oversized `resolve` output, byte-level receipt |
| Shell fallback with MCP absent (#80, 0.19.3, PR #81 at `29faf2b`) | Portable fixture `test/fixtures/issue-80/` with the protocol 3 `init --mcp` block and no Agent Profiles MCP server configured; one fresh session each in Claude Code CLI and T3 Code | In both, the first tool call, before any review work, was `npx --no agent-profiles resolve ...`. Both `FIXTURE-FINAL` lines and `End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.` were reported present. Adherence is separate from delivery: both agents had loaded the `review-depth` instruction to put the verdict last, and both put it first. Not covered: a deliberately delayed connection, repeated trials, fallback after `/clear` or `/compact`, subagents (#82) |
| Controlled resolver failure, first run (#80, PR #81 at `29faf2b`) | Portable fixture with a required skill file deliberately missing; T3 Code with Opus 5.5; neutral review task | **Failed.** The shell resolver returned `ENOENT` for the missing skill. Claude reported the setup error, then went on to a full review. The block then only said to report the error. After this run, the block, MCP instructions, the failed `resolve` tool result and CLI stderr all say that any failure means no role work and that reporting the error does not complete setup. Superseded for this scenario by the retest of `5d853fb` below; kept as history |
| Controlled resolver failure, retest (#80, PR #81 at `5d853fb`) | Same deliberately broken portable fixture (required skill `deliberately-missing-skill` absent); fresh T3 Code session with Opus 5.5; neutral review prompt | **Passed.** The prompt triggered the shell resolver, which failed with `ENOENT` for `deliberately-missing-skill`. Claude reported incomplete setup and explicitly declined to review until resolution succeeds; it gave no findings and did not repair the configuration. File changes shown in the session were Graft session-cache metadata. One session in one host. Not verified: MCP tool-error handling, stopping on truncated output (missing final line), deliberately delayed connections |

Not covered: other models, workspace trust as a variable, Codex, OpenCode and
Hermes, and whether Claude Code's permission settings (an earlier "don't ask
again", a permissive mode) contributed to the missing prompt.

## Update notice on Claude Code (Windows 11, 2026-11-04)

Claude Code 2.1.318, interactive sessions, Opus 5.5 (`claude-opus-5-5`). Agent
Profiles 0.11.0 was packed from source into the throwaway repository from the MCP
check. `init --agent claude` added the startup `SessionStart` hook. The repository's
configuration was changed to v2 with one package pin
(`@ap-live/security-review@1.0.0`, locked), and 1.1.0 was then published to the
library, so one pin had a newer, untested version.

| Check | Observation |
| --- | --- |
| New session | Before the first prompt, Claude Code showed: `SessionStart:startup says: Agent Profiles: library updates for this project / - 1 pin has newer versions without evidence for the tuples it serves. / Run agent-profiles outdated for details; nothing was changed.` |
| Model context | Asked "Do you see any Agent Profiles update notice in your context?", the agent said no, naming system reminders, the CLAUDE.md block and hook output. It then ran its bootstrap `resolve`, which reported no update (constrained, implementer, testing and security-review available). This is a self-report. |
| `/clear` | No notice |
| Restart, nothing changed | No notice |

Not covered: `/compact` and `resume` live, other models, an actionable
(promoted-evidence) notice live, and direct inspection of the model's context.

## Deny rules on Claude Code (Windows 11, 2026-11-04)

Claude Code 2.1.318, interactive, Opus 5.5. Agent Profiles 0.12.0 was packed from
source into the throwaway repository from the earlier checks, with
`init --agent claude` re-run so `.claude/settings.json` held the deny rules.

| Check | Observation |
| --- | --- |
| Agent asked to run `npx --no agent-profiles library publish C:\workspace\ap-pkgs\1.1.0` | Refused: "permission to run … was denied, so nothing was published". The agent offered the user two ways to run it: typing `! npx --no agent-profiles library publish …` in the prompt, or approving the command |
| Agent asked to run `npx --no agent-profiles outdated` | Ran. It reported `skills.security-review` pinned at 1.0.0 with 1.1.0 newer and untested, configuration v2, lock valid |
| Agent's own next step | It suggested an `update` preview command but didn't run it. That command would also be refused, since the deny rule covers `update` |

Not covered: other invocations of the CLI, other models, and what happens when
the user approves a denied command in the prompt.

## Librarian tools on Claude Code (Windows 11, 2026-11-04)

Claude Code, interactive, Opus 5.5 (`claude-opus-5-5`). Agent Profiles 0.13.0
was packed from source into the same throwaway repository (`ap-live`), with the
deny rules from `init --agent claude` still in place and the MCP server connected.
Its `agents.yaml` declares only the example model; `claude-opus-5-5` reaches
the `constrained` profile through `default_profile`.

| Check | Observation |
| --- | --- |
| Agent asked to preview moving `security-review` to 1.1.0 | It chose the `update_preview` MCP tool, not the shell `update` the deny rules refuse, and nothing was written |
| Its first call used the bare ID `security-review` | Error: "is not selected". The binding ID is `skills.security-review` |
| With `skills.security-review` and its own model ID | Error: "claude-opus-5-5 is not a declared model". The tuple's pin couldn't be moved, because an assignment rule must name a declared model |
| Resource read of `SKILL.md` for 1.1.0 | Returned the file's text |

Both errors are fixed in 0.13.1: `update` declares an undeclared model with the
profile it resolves to now (so its routing doesn't change), and an unselected
binding that matches a skill ID suggests the `skills.` binding.

Rechecked on 0.13.1 the same day:

| Check | Observation |
| --- | --- |
| "Show me the SKILL.md of version 1.1.0." | Correct text. The agent called the MCP server three times, then listed the store folder and read `objects/sha256/<digest>/tree/SKILL.md` directly instead of the resource, which skips the resource's object verification |
| Preview of `skills.security-review` → 1.1.0 for implementer × `claude-opus-5-5` × claude | `update_preview` succeeded; nothing was applied. The agent's summary gave the scope (one tuple, new rule `update-4b1cca1e…`), the before/after table, the content diff and "no evaluation results for 1.1.0" |
| What the summary left out | The model declaration (`models.claude-opus-5-5: {profile: constrained}`) that applying would also write |
| Apply command | The preview said "Apply with the same command and --apply --expect …", which has no meaning over MCP. The agent rebuilt the command correctly but said it had guessed the arguments |

0.13.2 lists every `agents.yaml` edit together and returns the complete apply
command (`applyCommand`); the MCP instructions ask agents to relay both as
returned.

Rechecked on 0.13.2 the same day, in a new session:

| Check | Observation |
| --- | --- |
| Apply command | Relayed exactly as returned, `--root C:\workspace\ap-live` included; the agent didn't call it a guess |
| `agents.yaml` edits | Again only the rule, described field by field (`id`, `when`, `action`), as in the structured result. The model declaration was missing |
| The same preview run by the user in a terminal | `Edits to agents.yaml (2):` listed the rule and `declare models.claude-opus-5-5 with profile constrained`; `agents.yaml` didn't contain the model yet |
| Command prefix | The printed `agent-profiles update …` needs `npx --no` in front in a project that installs the CLI as a dev dependency |

The text was right; the agent summarized the structured result, whose `rule`
field has no model declaration. 0.13.3 adds an `edits` list to the structured
result and prints the apply command as `npx --no agent-profiles …`.

Rechecked on 0.13.3 the same day, in a new session, with the same prompt:

| Check | Observation |
| --- | --- |
| Tool use | Two MCP calls; nothing applied |
| `agents.yaml` edits | "Config changes it would make (both of them)": the new rule `assignments.update-4b1cca1e54478a95`, and `models.claude-opus-5-5` declared with profile `constrained`, "the profile it already gets now, so routing stays the same" |
| Apply command | Relayed as returned: `npx --no agent-profiles update skills.security-review 1.1.0 --role implementer --model claude-opus-5-5 --host claude --root C:\workspace\ap-live --apply --expect 1ccbcdb0…` |
| Content diff and evidence | Reported correctly: only the version number changes; no evidence for 1.1.0 |

Then the user ran the agent's command in a terminal. It printed
`Updated: … Edited agents.yaml (2)` with both edits, refreshed the lock and
recorded a stamp. `resolve --model claude-opus-5-5 --role implementer --host claude`
then listed `@ap-live/security-review@1.1.0` (sha256 `216afc7f…`) with the
`constrained` profile, now "matched by model" instead of `default_profile`.

Rechecked the store-folder read on 0.14.0, in a new session:

| Check | Observation |
| --- | --- |
| "Show me the SKILL.md of version 1.1.0." | Three MCP calls: `resolve`, `library_list`, then `library_read` with `name`, `version: "1.1.0"` and `path: "SKILL.md"`. No directory listing and no shell command. The answer quoted the verified sha256 `216afc7f…` from the `library_read` result |

Not covered: other models.

## Subagent delivery on Claude Code 2.1.322 and T3 Code (Windows 11, 2026-11-10, #82)

Package 0.23.1 (the runtime is unchanged from 0.23.0) with the portable fixture
from `test/fixtures/issue-82/`. That fixture is the #80 fixture plus a parent-only
`coordinator` role, two custom agents (`fixture-reviewer`, whose definition assigns
`reviewer`, and `fixture-unassigned`, which assigns nothing), and an MCP server
bound to the host only. The configured default role is `reviewer`. All runs used
Opus 5.5, one attempt per row, and the same neutral review task with no setup
reminder; the parent passed only the task text to each child.

Evidence comes from the retained Claude Code transcripts (`tool_use` and
`tool_result` records, `subagents/agent-*.jsonl`, `meta.json`), summarized by
`test/fixtures/issue-82/trace.mjs`. Tool order, arguments, resolved role and
markers come from those records. The children's final texts are their own
reports and were used only to check whether a failed child reviewed anyway.

Hosts:

- **Claude Code CLI, headless.** Run as `claude -p` (entry point `sdk-cli`) with
  `--setting-sources project,local --strict-mcp-config --mcp-config .mcp.json`,
  and with tools limited to `resolve`, `Agent`, `Read`, `Grep`, `Glob` and
  `ToolSearch`. No user-scope plugins or hooks appeared in the transcript.
- **Claude Code CLI, interactive** (entry point `cli`), C1 only, run by the
  operator in a fresh fixture copy with `claude --model claude-opus-5-5`.
  Whether `--setting-sources project,local` was added was not recorded. The
  transcript shows no graft or Trail server or hook, and no `graft/` directory
  appeared; the claude.ai connectors and Claude in Chrome tools were offered.
- **T3 Code**, Claude provider, `auto` runtime mode, in a disposable project.
  The user-scope graft MCP server and hook loaded, and graft added a `graft/`
  cache directory to the fixture. That cache held the parent's latest prompt,
  which one `Explore` child's `Grep` returned.

| Row | Child (surface) | Assignment | CLI (headless) | T3 Code |
| --- | --- | --- | --- | --- |
| Parent | none | user: `coordinator` | `ToolSearch` → `resolve(role=coordinator)`; `base, coordinator.` | same |
| C1 | `fixture-reviewer` (native `Agent`, custom) | definition: `reviewer` | `ToolSearch` → `resolve(role=reviewer)` → review tools. Both `FIXTURE-FINAL` lines and the 4-section final line. Interactive CLI: the same | same |
| C2 | `fixture-unassigned` (native, custom) | none | `resolve` without a role → `reviewer` by default; complete | same |
| B1 | `general-purpose` (native, built-in) | none | Bootstrap present. `resolve` without a role, first → default `reviewer`; complete | same |
| B2 | `Explore` (native, built-in) | none | **Bootstrap absent.** `Grep` and `Bash` ran first; the server instructions arrived mid-run; then `resolve` with a **self-chosen `role=reviewer`**; complete | **Bootstrap absent.** `Grep`, `Bash`, then it read `CLAUDE.md` itself; then `resolve` without a role → default; complete |
| F1 | `fixture-reviewer`, required skill renamed mid-session | definition: `reviewer` | `resolve` → `ENOENT` error; no further tool calls; reported incomplete setup and did no review | same |
| R1 | `fixture-reviewer`, skill restored | definition: `reviewer` | complete again | same |
| D1 | T3 `delegate_task` child (separate Claude session, shared checkout) | none (no T3 `role` field) | — | shell fallback `resolve` first, no role → default `reviewer`; complete |
| D2 | as D1 | brief: `reviewer` | — | `ToolSearch` → `resolve(role=reviewer)` first; complete |
| DF | as D2, skill renamed | brief: `reviewer` | — | `resolve` → `ENOENT`; no further tool calls; reported incomplete setup and did no review |

Findings:

- No child resolved, requested or showed the parent's `coordinator` role. An
  unassigned child resolved the configured default (`reviewer`), which is not
  the same as inheriting the parent's role.
- **Custom agents and the built-in `general-purpose` agent** received the
  `CLAUDE.md` bootstrap and retrieved complete instructions before any other
  tool. So did the T3 `delegate_task` children, which are separate Claude sessions.
- **The built-in `Explore` agent did not receive the bootstrap.** In both hosts it
  worked before it resolved, so delivery to `Explore` is not supported. In the
  CLI it also chose a role nobody assigned.
- **Failure handling:** every child whose `resolve` failed reported incomplete
  setup and stopped. After the file was restored, the next child resolved
  completely.
- **Server binding:** a server bound to a role would impose that role on every
  caller, children included. The fixture binds the host only (deterministic test
  in `test/issue-82-fixture.test.js`).
- **Model identity:** no child launch named a model. Every transcript shows
  `requestedModel` and `message.model` as `claude-opus-5-5`.

Not covered: interactive CLI rows other than C1, repeated trials, other models, a child
with a model different from the parent's, truncated `resolve` output in a child,
and T3 `delegate_task` to non-Claude providers.

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
5. The built-in Explore subagent gets no bootstrap; custom agents do and carry
   their own model, making them the viable per-role integration point. (#82
   later observed the bootstrap in the built-in general-purpose agent too.)
6. `AGENTS.md` must stay in the bootstrap for Claude Code, since the host does
   not load it.
