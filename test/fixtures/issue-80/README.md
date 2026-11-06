# Issue #80 portable fixture

A self-contained Agent Profiles project for testing complete delivery of required
instructions. It needs no package store, trust policy, network or private skill
package. `test/mcp.test.js` uses it, and it can be copied for live host tests.
- Model `claude-opus-5-5` → profile `base`; default role `reviewer`.
- Two required local-file skills, sized like the original #80 report:
  `review-depth` (about 5.2 KB, 5 sections) and `shared-language` (about 3.7 KB,
  4 sections). Paragraphs repeat on purpose; only size and order matter.
- Each skill ends with a unique line starting `FIXTURE-FINAL`. Both lines,
  followed by `End of Agent Profiles context: 4 section(s): base, reviewer,
  review-depth, shared-language.`, mean the whole context arrived.
- Rendered `resolve` output is about 10 KB, several times the size at which
  Claude Code truncated server instructions in the original report.

## Live test

1. Copy `project/` to a disposable directory outside any repository with its own
   `CLAUDE.md`, and run `git init` there.
2. From that directory, install the bootstrap (packed build or published
   version under test):

   ```sh
   npx --no agent-profiles init --agent claude --mcp
   npx --no agent-profiles doctor
   ```

3. Register a bound server (for example in `.mcp.json`):

   ```sh
   claude mcp add --scope project agent-profiles -- npx --no agent-profiles mcp --host claude --model claude-opus-5-5 --role reviewer
   ```

4. In a fresh session, then after `/clear`, then after `/compact`, give a neutral
   task with no setup reminder, for example: "Review removing the `0` initial
   value from `items.reduce((sum, item) => sum + item.price, 0)`."
5. Afterwards, ask for the tool history. Pass when `resolve` (MCP or the shell
   fallback) ran before the review and both `FIXTURE-FINAL` lines and the final
   `End of Agent Profiles context:` line were present. Record the tool order, and
   distinguish a compaction summary from the complete bodies.

For the shell fallback, repeat with the server unregistered or still starting.
The block then tells the agent to run the shell command immediately.
