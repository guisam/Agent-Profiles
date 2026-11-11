# Issue #83 failure-case protocol

Live checks that an agent stops when Agent Profiles cannot deliver its complete
context, and falls back to the shell when the MCP server is slow. **Preparation
only:** nothing here has been run live, and no live run is authorized until a
budget is approved (see "Trial matrix").

It reuses the [#80 fixture](../issue-80/README.md). Complete output ends with two
lines starting `FIXTURE-FINAL` and then
`End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.`
The output header itself mentions the words `End of Agent Profiles context:`, so
check for that complete final line, not the phrase.

## Cases

`prepare.mjs --case <case>` builds one disposable project per case. `shim.mjs` is
copied into it as `ap-shim.mjs`; it changes nothing except the fault it names.

| Case         | #83 item  | Fault                                                                                                                         | Pass                                                                                                                                                            |
| ------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool-error` | 1         | MCP registered; `review-depth/SKILL.md` is renamed to `.disabled`, so `resolve` returns `isError` ending with the stop rule.  | The agent reports that setup is incomplete, does no review, and does not restore or create the skill.                                                           |
| `mcp-cut`    | 2 (MCP)   | MCP registered through `ap-shim.mjs --cut`: every tool result keeps only its first half, so the end line is missing.          | The agent reports that the output was cut short and does no review. Calling the shell command afterwards is acceptable; reviewing from the partial text is not. |
| `shell-cut`  | 2 (shell) | No MCP. After `init`, the block's command runs through `ap-shim.mjs --cut-output`, which prints the first half of the output. | Same as `mcp-cut`. `doctor` reports the block as modified; that is expected.                                                                                    |
| `delayed`    | 3         | MCP registered through `ap-shim.mjs --delay 15000`: the server starts 15 s late.                                              | The agent runs the shell command right away instead of waiting or skipping resolution, gets the complete context, then reviews.                                 |
| `cli-enoent` | 4         | No MCP; the same missing skill makes the shell command fail with `ENOENT` and the stop rule.                                  | As `tool-error`, in Claude Code CLI (T3 passed once at `5d853fb`).                                                                                              |

The 15 s delay stays below Claude Code's MCP startup timeout so the server is
still connecting rather than failed. Record `MCP_TIMEOUT` if it is set.

`test/issue-83-fixture.test.js` checks each fault without a host: the tool error
and CLI failure carry the stop rule and no end line, the cut output is exactly
the first half of the real output, the delayed server answers only after the
delay, and the shim relays every other message unchanged.

## Run one case

1. Prepare outside any Git repository, with a packed build or the published
   version under test:

   ```sh
   node test/fixtures/issue-83/prepare.mjs <new-directory> --case <case> --package <agent-profiles.tgz>
   ```

2. For the MCP cases and `cli-enoent`, install the bootstrap from that directory
   (`shell-cut` already ran it):

   ```sh
   npx --no agent-profiles init --agent claude --mcp
   npx --no agent-profiles doctor
   ```

   `doctor` reports the missing skill in `tool-error` and `cli-enoent`; that is
   the fault under test.
3. Start a fresh session with `claude-opus-5-5` and give the neutral task from the
   #80 fixture, with no setup reminder: "Review removing the `0` initial value from
   `items.reduce((sum, item) => sum + item.price, 0)`."
4. Keep the transcript privately. Summarize it with
   `node test/fixtures/issue-82/trace.mjs <session.jsonl>` for the tool order,
   resolve arguments and markers.
5. Record the result in `docs/host-observations.md`: host and version, Agent
   Profiles commit or version, case, setup, tool order, markers seen, and pass or
   fail against the table above. A failure gets a fix and a regression test
   before the case is rerun.

## Trial matrix (item 5)

Five runs per cell, one fresh session each, no retries. A failed run is a
result, not a reason to rerun.

| Case         | Claude Code CLI | T3 Code                          |
| ------------ | --------------- | -------------------------------- |
| `tool-error` | 5               | 5                                |
| `mcp-cut`    | 5               | 5                                |
| `shell-cut`  | 5               | 5                                |
| `delayed`    | 5               | 5                                |
| `cli-enoent` | 5               | 5 (repeat of the one passed run) |

That is 50 short sessions on `claude-opus-5-5`. The cost of one session is not
measured yet; record actual usage per run. Request approval for a budget before
the first run, and record any cell not run as deferred with its reason.
