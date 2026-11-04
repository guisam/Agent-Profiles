# MCP service

`agent-profiles mcp` (source version 0.5.0; block handoff in 0.6.0; workspace roots and stamp digest in 0.7.0) serves Agent Profiles' read-only
operations to MCP hosts over stdio, alongside the CLI.

- **Tools:** `resolve`, `explain`, `verify`, `diff`, `report`. Each matches its
  CLI equivalent and none writes files.
- **No shell permission needed** for `resolve`, unlike the Bash bootstrap.
- **Session instructions:** started with `--model` or `--role`, the server's MCP
  instructions carry the resolved profile for that session.
- **Block handoff (0.6.0):** `init --mcp` makes the managed block call the
  server's `resolve` tool when it is connected, with the shell command as the
  fallback, and prints the host setup to add. `doctor` reports it.
- **Workspace roots and stamp digest (0.7.0):** without `--root`, the server uses
  the host's workspace root that holds Agent Profiles configuration. Bound
  instructions start with the session's stamp digest, computed without writing.
- **Live check (0.7.1):** on Claude Code 2.1.317 with Opus 5.5, the tool ran
  without shell permission rules, the agent followed the `init --mcp` handoff,
  Claude Code offered workspace roots, and bound instructions survived
  `/compact` and `/clear`. Other models and hosts are not yet checked.
- **Read-only, as an invariant (0.12.0):** no write tools will be added to this
  server. Publishing, updating and promoting stay commands a person runs.
- **Optional:** removing the server changes nothing else.

Setup per host, the tool reference and verified behavior are in
[docs/mcp.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/mcp.md).
This is phase 1 of the [skill librarian](https://github.com/guisam/Agent-Profiles/issues/38);
see [#39](https://github.com/guisam/Agent-Profiles/issues/39).

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).
