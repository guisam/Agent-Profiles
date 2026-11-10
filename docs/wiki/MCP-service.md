# MCP service

`agent-profiles mcp` (source version 0.5.0; block handoff in 0.6.0; workspace roots and stamp digest in 0.7.0) serves Agent Profiles' read-only
operations to MCP hosts over stdio, alongside the CLI.

For current installation, security choices and verification, follow the
[setup guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/setup.md).
Install the npm package and run `init --agent claude --mcp`, then register the
server separately. Keep the protocol-3 project bootstrap and local shell resolver:
if the MCP tool is not available when work starts, the bootstrap uses the shell.
Inspect and preserve existing server entries and host permissions. A connected
server or valid configuration alone does not establish complete instruction delivery.

- **Tools:** `resolve`, `explain`, `verify`, `diff`, `report`. Each matches its
  CLI equivalent and none writes files.
- **No shell permission needed** for `resolve`, unlike the Bash bootstrap.
- **Session instructions:** started with `--model` or `--role`, the server's MCP
  instructions name the bound selection and stamp. Since 0.19.3 they never carry
  the profile itself; the agent must call `resolve` (#80).
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
- **Truncation-safe delivery (0.19.3, #80):** hosts truncated large bound
  instructions, so they became a short bootstrap. Every `resolve` output ends
  with an `End of Agent Profiles context:` line that the agent checks; bound
  servers refuse conflicting selectors; the managed block is protocol 3, so run
  `init` after upgrading.
- **Subagent delivery observed (0.23.1, #82):** in headless Claude Code CLI and in
  T3 Code with Opus 5.5, custom agents, the built-in `general-purpose` agent and
  T3 `delegate_task` children resolved their own role before any other tool.
  None took the parent's role, and a child whose `resolve` failed stopped. The
  built-in `Explore` agent gets no bootstrap; don't use it for role work. Bind a
  shared server to the host only. Interactive CLI, other models and repeated
  trials are still open in [#82](https://github.com/guisam/Agent-Profiles/issues/82).
- **Librarian tools (0.13.0):** `library_list`, `library_search`, `library_info`,
  `library_evidence`, `outdated` and `update_preview` let an agent browse the
  library, check evidence and preview an update without a shell. Package files
  are resources at `agent-profiles://library/@ns/name/version/path`.
  `update_preview` never applies; you run the apply command yourself.
- **Verified file reads (0.14.0):** `library_read` returns one package file after
  verifying the version. Agents are told to use it (or the resources) instead of
  opening files in the store folder, where nothing verifies them.
- **Read-only, as an invariant (0.12.0):** no write tools will be added to this
  server. Publishing, updating and promoting stay commands a person runs.
- **Session records (0.18.0):** with `--record-sessions`, the server records each
  resolution (stamp digest, model, role, client, package versions, withheld
  skills) under `~/.agent-profiles/sessions/` only. `agent-profiles sessions`
  lists them. Off by default.
- **Optional:** removing the server changes nothing else.

Setup per host, the tool reference and verified behavior are in
[docs/mcp.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/mcp.md).
This is phase 1 of the [skill librarian](https://github.com/guisam/Agent-Profiles/issues/38);
see [#39](https://github.com/guisam/Agent-Profiles/issues/39).

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).
