# MCP service

`agent-profiles mcp` (source version 0.5.0; block handoff in 0.6.0) serves Agent Profiles' read-only
operations to MCP hosts over stdio, alongside the CLI.

- **Tools:** `resolve`, `explain`, `verify`, `diff`, `report`. Each matches its
  CLI equivalent and none writes files.
- **No shell permission needed** for `resolve`, unlike the Bash bootstrap.
- **Session instructions:** started with `--model` or `--role`, the server's MCP
  instructions carry the resolved profile for that session.
- **Block handoff (0.6.0):** `init --mcp` makes the managed block call the
  server's `resolve` tool when it is connected, with the shell command as the
  fallback, and prints the host setup to add. `doctor` reports it.
- **Optional:** removing the server changes nothing else.

Setup per host, the tool reference and verified behavior are in
[docs/mcp.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/mcp.md).
This is phase 1 of the [skill librarian](https://github.com/guisam/Agent-Profiles/issues/38);
see [#39](https://github.com/guisam/Agent-Profiles/issues/39).

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).
