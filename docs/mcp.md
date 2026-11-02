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
- `--root`: project for every call. Without it, each call uses its `root`
  argument, or the repository containing the server's working directory. A call
  with neither fails with a message naming `--root`.
- `--store`: package and stamp store for `verify`, `diff` and `report`. Tools
  cannot choose a store.
- `--host`, `--model`, `--family`, `--identity-source`, `--role`: session
  defaults. Each tool call may override them.

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
  `resolve` again unless the context was compacted or the model or role changed.
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
| Claude Code: tools callable without Bash permission rules | unverified |
| Claude Code: server instructions present after `/compact` and `/clear` | unverified |
| Managed block handoff: variants, `init` flags, `doctor` detection | verified (automated tests) |
| Agents follow the handoff instead of the shell command | unverified |
| Codex, OpenCode, Hermes: live use | unverified |

## Limits

- Read-only by design. Installing, stamping, materializing, publishing,
  approving, promoting and restoring stay CLI commands.
- MCP client workspace roots are not used yet; pass `--root` or a `root`
  argument when the server's working directory is not the project.
- Stamp digests are not included in bound instructions: capturing a stamp
  writes to the store, and this server never writes. Package identities and
  digests are included.
- The server selects instructions; it does not hide native host skills,
  disable plugins or isolate files.
