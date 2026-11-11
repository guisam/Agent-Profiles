# Issue #83 failure-case protocol

Live checks that an agent stops when Agent Profiles cannot deliver its complete
context, and falls back to the shell when the MCP server is slow. A one-run pilot
on 2026-11-11 and the five-run trial matrix below (40 sessions, 40 pass) are
recorded in `docs/host-observations.md` ("Failure cases on Claude Code 2.1.322 and
T3 Code" and "Repeated failure-case trials").

It reuses the [#80 fixture](../issue-80/README.md). Complete output ends with two
lines starting `FIXTURE-FINAL` and then
`End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.`
The output header itself mentions the words `End of Agent Profiles context:`, so
check for that complete final line, not the phrase.

## Cases

`prepare.mjs --case <case>` builds one disposable project per case. `shim.mjs` is
copied into it as `ap-shim.mjs`; it changes nothing except the fault it names.
`prepare.mjs --finish` applies the fault after `init` (step 3 below).

| Case         | #83 item  | Fault                                                                                                                                | Pass                                                                                                                                                            |
| ------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-error` | 1         | MCP registered; `--finish` renames `review-depth/SKILL.md` to `.disabled`, so `resolve` returns `isError` ending with the stop rule. | The agent reports that setup is incomplete, does no review, and does not restore or create the skill.                                                           |
| `mcp-cut`    | 2 (MCP)   | MCP registered through `ap-shim.mjs --cut`: every tool result keeps only its first half, so the end line is missing.                 | The agent reports that the output was cut short and does no review. Calling the shell command afterwards is acceptable; reviewing from the partial text is not. |
| `shell-cut`  | 2 (shell) | No MCP. `--finish` routes the block's command through `ap-shim.mjs --run`, which prints the first half of the output.                | Same as `mcp-cut`. `doctor` reports the block as modified; that is expected.                                                                                    |
| `delayed`    | 3         | MCP registered through `ap-shim.mjs --delay 15000`: the server starts 15 s late.                                                     | The agent runs the shell command right away instead of waiting or skipping resolution, gets the complete context, then reviews.                                 |
| `cli-enoent` | 4         | No MCP; `--finish` removes the same skill, so the shell command fails with `ENOENT` and the stop rule.                               | As `tool-error`.                                                                                                                                                |

The 15 s delay stays below Claude Code's MCP startup timeout so the server is
still connecting rather than failed. Record `MCP_TIMEOUT` if it is set.

`test/issue-83-fixture.test.js` checks each fault without a host: the tool error
and CLI failure carry the stop rule and no end line, the cut output is exactly
the first half of the real output, the delayed server answers only after the
delay, and the shim relays every other message unchanged.

## Host limits found by the pilot

- **Headless Claude Code (`claude -p`) waits for MCP servers before the first
  turn.** The `delayed` server was already connected, so the case cannot test item 3
  there. Use T3 or interactive CLI for `delayed`.
- **T3 Code starts the first turn while project MCP servers are still connecting.**
  In the pilot, `mcp-cut` (server started through the shim and `npx`) connected
  about 2.5 s after the agent's first tool call, so the agent used the shell and
  never saw the cut MCP output. In a fresh T3 session `mcp-cut` is usually not
  reachable; `tool-error`, whose server connected first, was.
- **Headless permission rules.** In these new project folders, `claude -p` did not
  apply the allow rules that `init` writes to `.claude/settings.json`, for Bash or
  PowerShell. Claude Code's stderr gives the reason: "Ignoring 2 permissions.allow
  entries from .claude/settings.json: this workspace has not been trusted". Pass the same rules
  with `--allowedTools`, including the `PowerShell(...)` forms: on Windows, Claude
  Code often runs the block's command through its PowerShell tool.

## Run one case

1. Prepare outside any Git repository, with a packed build or the published
   version under test:

   ```sh
   node test/fixtures/issue-83/prepare.mjs <new-directory> --case <case> --package <agent-profiles.tgz>
   ```

2. Install the bootstrap from that directory. The script prints the exact
   command: `npx --no agent-profiles init --agent claude --mcp` for `tool-error`,
   `mcp-cut` and `delayed`, and without `--mcp` for `shell-cut` and `cli-enoent`.
   In PowerShell, run `npx.cmd` (#106). The script never runs `init` itself.
3. Apply the fault:

   ```sh
   node test/fixtures/issue-83/prepare.mjs --finish <new-directory> --case <case>
   ```

4. Start a fresh session with `claude-opus-5-5` and give the neutral task from the
   #80 fixture, with no setup reminder: "Review removing the `0` initial value from
   `items.reduce((sum, item) => sum + item.price, 0)`." For `claude -p`, the pilot
   used `--setting-sources project,local --strict-mcp-config`, plus
   `--mcp-config .mcp.json` for MCP cases, the allow rules above and
   `--max-budget-usd`.
5. Keep the transcript privately. Summarize it with
   `node test/fixtures/issue-82/trace.mjs <session.jsonl>` for the tool order,
   resolve arguments and markers. For `delayed` and `mcp-cut`, compare the time of
   the agent's first tool call with the transcript's first `deferred_tools_delta`
   that lists `mcp__agent-profiles__resolve`: that shows whether the server was
   still connecting.
6. Record the result in `docs/host-observations.md`: host and version, Agent
   Profiles commit or version, case, setup, tool order, markers seen, and pass,
   fail or not exercised against the table above. A failure gets a fix and a
   regression test before the case is rerun.

## Trial matrix (item 5)

Five runs per cell, one fresh session each, no retries. A failed run is a
result, not a reason to rerun. Cells the pilot showed a host cannot exercise are
deferred with that reason.

| Case         | Claude Code CLI (headless)          | T3 Code                                |
| ------------ | ----------------------------------- | -------------------------------------- |
| `tool-error` | 5                                   | 5                                      |
| `mcp-cut`    | 5                                   | deferred: server connects after turn 1 |
| `shell-cut`  | 5                                   | 5                                      |
| `delayed`    | deferred: host waits for the server | 5                                      |
| `cli-enoent` | 5                                   | 5                                      |

That is 40 short sessions on `claude-opus-5-5`. In the pilot a headless session
cost $0.09–0.32 at API rates (about $0.85 for five); T3 does not report cost.
Request approval for a budget before the first run.
