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
```

- stdout carries the protocol; diagnostics go to stderr.
- `--root`: project for every call. See [Choosing the project](#choosing-the-project)
  for the order used without it.
- `--store`: package and stamp store for `verify`, `diff` and `report`. Tools
  cannot choose a store.
- `--host`, `--model`, `--family`, `--identity-source`, `--role`: session
  defaults. Each tool call may override them.

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

Errors are returned as tool errors with the same message the CLI prints.

## Instructions

- **Unbound** (no `--model` or `--role`): a short pointer telling the agent to
  call `resolve` with its exact model ID before starting work, and again after
  compaction or a model or role change.
- **Bound** (`--model` and/or `--role`): the full resolved profile for that
  session, rendered once at server start, preceded by a note not to call
  `resolve` again unless the context was compacted or the model or role changed,
  and by the session's stamp digest:

  ```
  Stamp: sha256 <digest> (not retained; `agent-profiles stamp` with the same selectors records this digest).
  ```

  The digest is computed without writing to the store. It is the digest
  `agent-profiles stamp` records for the same selectors and unchanged inputs, so
  it identifies the exact profile state in reports. When that stamp is already in
  the store the line says so, and the `verify` tool can read it. If the stamp
  cannot be computed, the line says why; the profile is still rendered.
  If resolution fails at start, the instructions say so and fall back to the
  unbound text; the server still starts.

Whether a host keeps server instructions in context after compaction, `/clear`
or a new conversation is host behavior. It is recorded per host as it is
observed; see [Host status](#host-status).

## Managed block handoff

`init --mcp` writes a variant of the managed bootstrap block that adds one
paragraph: if an `agent-profiles` MCP server is connected, call its `resolve`
tool with the same values (`host`, `identitySource`, `model`, `role`), or follow
the server's instructions when they already carry the session's profile. The
shell command stays in the block, so the block still works where no server is
connected.

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
- Both variants are protocol 2, and doctor accepts either; neither is reported as
  stale. Keep the shell permission rules: they serve the fallback.

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
| Claude Code: offers workspace roots | verified (live) |
| Codex: offers workspace roots | unverified |

## Limits

- Read-only by design. Installing, stamping, materializing, publishing,
  approving, promoting and restoring stay CLI commands.
- Workspace roots are read only by `resolve` and `explain`, once per call; bound
  instructions do not use them.
- The bound stamp digest is not retained: the server never writes, so `verify`
  and `diff` can read that stamp only after `agent-profiles stamp` records it.
- The server selects instructions; it does not hide native host skills,
  disable plugins or isolate files.
