# MCP service

`agent-profiles mcp` serves Agent Profiles' read-only operations to any host
that speaks the [Model Context Protocol](https://modelcontextprotocol.io) over
stdio. It is optional: every tool has a CLI equivalent, and removing the server
changes nothing else. Tracking issues:
[#38 skill librarian](https://github.com/guisam/Agent-Profiles/issues/38) and
[#39 this service's first phase](https://github.com/guisam/Agent-Profiles/issues/39).

The server uses the official MCP TypeScript SDK v2
(`@modelcontextprotocol/server`). Only the `mcp` command loads it.

## Why use it

- **No shell permission for `resolve`.** The Bash bootstrap needs a permission
  rule, a trusted workspace and the right shell (see the
  [Claude Code compatibility record](hosts/claude-code.md)). A tool call does not.
- **One integration for every MCP host**, instead of a bootstrap block per host.
- **Session instructions.** Started with `--model` or `--role`, the server's MCP
  `instructions` carry the resolved profile for that session.

## Command

```
agent-profiles mcp [--root <directory>] [--store <directory>] [--host <id>]
                   [--model <id>] [--family <id>]
                   [--identity-source host|host-stated|user] [--role <id>]
                   [--record-sessions]
```

- stdout carries the protocol; diagnostics go to stderr.
- `--root`: project for every call. See [Choosing the project](#choosing-the-project)
  for the order used without it.
- `--store`: package and stamp store for `verify`, `diff` and `report`. Tools
  cannot choose a store.
- `--host`, `--model`, `--family`, `--identity-source`, `--role`: session
  defaults. Each tool call may override them.
- `--record-sessions`: write a machine-local [session record](sessions.md) of
  each resolution. Off by default.

## Choosing the project

`resolve` and `explain` choose the project in this order:

1. the call's `root` argument;
2. the server's `--root`;
3. the host's workspace roots, when the client offers them: the one root that
   contains `.agent-profiles/agents.yaml`. Several such roots are refused with a
   message asking for `root`; none moves on to the next step;
4. the repository containing the server's working directory.

A call that reaches step 4 outside any repository fails with a message naming
`--root`. Workspace roots are requested only when steps 1 and 2 do not apply, once
per call. On 2025-era connections the server sends `roots/list`; on the
2026-07-28 revision it returns an in-band input request that the client fulfils.
The 2026-07-28 revision deprecates roots (SEP-2577) in favor of tool arguments and
configuration, which steps 1 and 2 already cover. Bound instructions are rendered
at server start, before any roots exchange, so they use step 2 or 4.

## Tools

All tools are annotated read-only. None writes configuration, locks, packages,
stamps, evidence or host configuration.

| Tool | Arguments | Returns | CLI equivalent |
| --- | --- | --- | --- |
| `resolve` | `root`, `host`, `model`, `family`, `identitySource`, `role`, `skills` (all optional) | The instructions to follow, rendered for MCP: packaged skills and "run again" point to this tool instead of shell commands | `resolve` |
| `explain` | same as `resolve` | Structured resolution: model match, profile, role, loaded/required/available/unsatisfied skills, package identities | `resolve --json` |
| `verify` | `digest` (64 lowercase hex) | Stamp integrity and reproducibility labels | `verify <digest> --json` |
| `diff` | `before`, `after` | Structural changes between two stamps | `diff <a> <b> --json` |
| `report` | `resultId` | Retained paired-evaluation report | `migrate report <id> --json` |
| `library_list` | `type` (optional) | Every library package with its versions, newest first | `library list --json` |
| `library_search` | `text` | Packages whose name or description contains the text | `library search <text> --json` |
| `library_info` | `name`, `version`, `root` | Verified details and evidence per version; with a project, its pins | `library info <name>[@<version>] --json` |
| `library_read` | `name`, `version`, `path` | One file of a verified version: text, or base64 for binary. A tampered version is an error | `library read <name>@<version> <path> --json` |
| `library_evidence` | `name`, `version`, `model`, `role`, `host`, `root` | Retained evaluations per exact role × model × host; untested versions under a filter | `library evidence ... --json` |
| `outdated` | `model`, `role`, `host`, `root` | Every pin, the tuples it serves, newer versions and their evidence | `outdated --json` |
| `update_preview` | `binding`, `version`, `model`, `role`, `host`, `root` | Every `agents.yaml` edit (`edits`), the selections that would change, evidence, a content diff, a `previewDigest` and the complete `applyCommand` for the user. **Never applies** | `update ... --json` (preview) |

Errors are returned as tool errors with the same message the CLI prints. Each
librarian tool (#58) returns the CLI's JSON as structured content and its text
rendering as text.

`update_preview` is how an agent previews a pin move, since the
[deny rules](bootstrap.md#host-setup) refuse an agent's `update` command
outright. To apply, show the user the preview; the user runs
`agent-profiles update ... --apply --expect <previewDigest>` in a terminal.
`library_info` and `library_evidence` use a project only when `root`, `--root` or
a workspace root names one. `outdated` and `update_preview` always need one and
choose it like `resolve`.

## Resources

Every file of a verified library version is a resource:

```
agent-profiles://library/{@namespace}/{name}/{version}/{path}
agent-profiles://library/@example/security-review/2.0.0/SKILL.md
```

- **List:** the resource list offers each version's entrypoint.
- **Read:** any file of the version can be read. The object is verified first, so
  a tampered version is an error, never content.
- **Content types:** text files come back as text (`text/markdown`,
  `application/yaml`, `application/json` or `text/plain`), and other files as a
  base64 blob.
- **Same as `library_read`:** both read through the same verified path. Hosts
  surface tools more consistently than resources, so the server instructions name
  both, and tell agents not to open files in the store folder directly.

## Instructions

Server instructions never carry the profile, role or skill text (#80). Hosts
truncate them: Claude Code cut a bound payload partway through its first
required skill, and the agent carried on with the partial copy. They stay a short
bootstrap (under 2 KB, enforced by a test) however large the profile grows.

- **Unbound** (no `--model` or `--role`): tells the agent to call `resolve` with
  its exact model ID before any role work, and again after `/clear`, compaction or
  a model or role change.
- **Bound** (`--model` and/or `--role`): names the bound selection, tells the
  agent to call `resolve` without repeating the bound values, and carries the
  session's stamp digest:

  ```
  Stamp: sha256 <digest> (not retained; `agent-profiles stamp` with the same selectors records this digest).
  ```

  The digest is computed without writing to the store. It is the digest
  `agent-profiles stamp` records for the same selectors and unchanged inputs, so
  it identifies the exact profile state in reports. When that stamp is already in
  the store the line says so, and the `verify` tool can read it. If the stamp
  cannot be computed, the line says why.
  If resolution fails at start, the instructions say so and fall back to the
  unbound text; the server still starts.
- **Binding is authoritative:** a bound server refuses a `resolve` or `explain`
  call whose `host`, `model`, `family`, `identitySource` or `role` differs from
  its binding, naming the bound value. Repeating a bound value is accepted, and a
  selector the server is not bound to stays the agent's to supply. To change a
  bound role or model, start a server bound to the new one.

Both modes treat any failure as incomplete setup: when `resolve` is unavailable,
fails in any way, or returns output without its final line, the agent reports the
error and stops, and does no role work until a later `resolve` succeeds.
Reporting the error does not complete setup. A failed `resolve` tool result
repeats this rule after the error, as the CLI does on stderr; a live T3 test
showed an agent reporting an `ENOENT` and then reviewing anyway when the rule
only said to report the error.
Every `resolve` output (MCP and CLI) ends with
`End of Agent Profiles context: <n> section(s): <ids>.`, and says so at the top,
so a cut-off tool result is visible to the agent rather than silently partial.
Agent Profiles cannot check what the host actually put in the model's context;
the final line makes truncation detectable, not impossible.

**Subagents are not covered.** Delivery to subagents has not been validated.
Don't assume a subagent inherits the parent's resolved context, or that it should
take the parent's role. A subagent gets Agent Profiles instructions only if it
calls `resolve` itself, with a role explicitly assigned to it. Earlier
observations: custom Claude Code agents receive the `CLAUDE.md` bootstrap, and
the built-in Explore agent does not. Validation is tracked in
[#82](https://github.com/guisam/Agent-Profiles/issues/82).

The portable fixture in `test/fixtures/issue-80/` (two required skills sized
like the #80 report, each ending with a `FIXTURE-FINAL` line) backs the automated
check and documents the live test steps.

Whether a host keeps server instructions in context after compaction, `/clear`
or a new conversation is host behavior. It is recorded per host as it is
observed; see [Host status](#host-status).

## Managed block handoff

`init --mcp` writes a variant of the managed bootstrap block that adds one
paragraph: if an `agent-profiles` MCP server's `resolve` tool is available, call
it with the same values (`host`, `identitySource`, `model`, `role`), omitting any
the server is bound to. The server's instructions never contain the profile, so
the agent always calls it. If the tool is not available yet (no server, or one
still connecting, as T3 Code showed at the start of a turn), the agent runs the
shell command right away instead of waiting. The command stays in the block.

```sh
agent-profiles init --agent claude --mcp     # write the handoff block
agent-profiles init --agent claude           # keep whichever variant is installed
agent-profiles init --agent claude --no-mcp  # back to the shell-only block
```

- The flags apply to the agents named with `--agent`; other installed blocks keep
  their variant.
- `init --mcp` prints the host setup below for each selected agent. It does not
  write host MCP configuration.
- `doctor` reports `bootstrap installed with MCP handoff` and a note per handoff
  block: whether the project's host file names the server, or the snippet to
  add. User-scope configuration (`~/.claude.json`, `~/.codex/config.toml`,
  `~/.hermes/config.yaml`) is not read, so a server configured there is reported
  as not found in the project.
- Both variants are protocol 3, and doctor accepts either; neither is reported as
  stale. Protocol 2 blocks are reported stale: run `init` to refresh them. Keep the shell permission rules: they serve the fallback.

## Host setup

Install the package in the project first (`npm i -D @guisam/agent-profiles`),
or use `npx` with the published package. Check each host's MCP documentation
for its current configuration format. `init --mcp` prints the matching snippet
with `--host` set.

**Claude Code** (project scope writes `.mcp.json`):

```sh
claude mcp add --scope project agent-profiles -- npx --no agent-profiles mcp --host claude
```

Claude Code asks each user to approve project-scope servers from `.mcp.json`.

Per session, with a bound role and model:

```sh
claude --mcp-config '{"mcpServers":{"agent-profiles":{"command":"npx","args":["--no","agent-profiles","mcp","--host","claude","--model","<exact-model-id>","--role","reviewer"]}}}'
```

**Codex** (`~/.codex/config.toml`, or the project's `.codex/config.toml`, which
Codex reads only for a trusted project):

```toml
[mcp_servers.agent-profiles]
command = "npx"
args = ["--no", "agent-profiles", "mcp", "--host", "codex"]
```

**Hermes Agent** (`~/.hermes/config.yaml`; Hermes reads MCP servers from user
configuration only, so add `--root <repository>` to `args` if it starts the
server outside the repository):

```yaml
mcp_servers:
  agent-profiles:
    command: "npx"
    args: ["--no", "agent-profiles", "mcp", "--host", "hermes"]
```

**OpenCode** (`opencode.json`):

```json
{
  "mcp": {
    "agent-profiles": {
      "type": "local",
      "command": ["npx", "--no", "agent-profiles", "mcp", "--host", "opencode"]
    }
  }
}
```

The installer does not write host MCP configuration. Adding a server at user
scope changes every project for that user; choose that explicitly.

## Host status

| Behavior | Status |
| --- | --- |
| Protocol handshake, tool listing and calls over stdio (SDK client) | verified (automated tests) |
| Tool results match the CLI on fixtures | verified (automated tests) |
| No tool changes repository, store or home files | verified (automated tests) |
| Claude Code: `resolve` runs without Bash permission rules or a prompt, once the project server is approved | verified (live, Opus) |
| Claude Code: bound server instructions present after `/compact` and `/clear` | verified (live, Opus) |
| Managed block handoff: variants, `init` flags, `doctor` detection | verified (automated tests) |
| Claude Code: the agent follows the handoff instead of the shell command | verified (live, Opus); other models unverified |
| Codex, OpenCode, Hermes: live use | unverified |
| Workspace roots select the project (2025 and 2026-07-28 protocol) | verified (automated tests) |
| Bound stamp digest equals the CLI `stamp` digest; nothing is written | verified (automated tests) |
| Librarian tools equal their CLI JSON; resources verified; nothing written | verified (automated tests) |
| Claude Code: an agent uses `update_preview` instead of the denied `update` | verified (live, Opus, 0.13.0 and 0.13.1) |
| Claude Code: the agent relays the `applyCommand` as returned | verified (live, Opus, 0.13.2 and 0.13.3) |
| Claude Code: the agent relays every `agents.yaml` edit | failed in 0.13.1 and 0.13.2 (it reported the rule, not the model declaration); verified (live, Opus, 0.13.3) once `edits` was in the structured result |
| Claude Code: the agent reads package files through resources rather than the store folder | not guaranteed: in one check (0.13.1) it read the store file directly. verified (live, Opus, 0.14.0): the agent used `library_read` |
| Claude Code: offers workspace roots | verified (live) |
| Codex: offers workspace roots | unverified |

## Limits

- **Read-only, as an invariant (#55).** Installing, stamping, materializing,
  publishing, approving, promoting, updating and restoring stay CLI commands that a
  person runs. No write tool will be added to this server. Any future write tool
  would need a separate, off-by-default command, never the default server. A test
  checks that no tool changes the repository, the store or the home directory.
  The one opt-in exception is `--record-sessions` (#38 phase 7). It writes
  [session records](sessions.md), and only under `~/.agent-profiles/sessions/`;
  a test checks the repository, store and home stay unchanged with it on.
- Workspace roots are read only by `resolve` and `explain`, once per call; bound
  instructions do not use them.
- The bound stamp digest is not retained: the server never writes, so `verify`
  and `diff` can read that stamp only after `agent-profiles stamp` records it.
- The server selects instructions; it does not hide native host skills,
  disable plugins or isolate files.
