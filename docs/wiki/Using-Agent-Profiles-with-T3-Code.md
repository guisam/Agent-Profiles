# Using Agent Profiles with T3 Code

Agent Profiles (AP) selects project instructions and skills by model and role.
T3 supplies the agent session, model selection and delegation. Configure AP in
the project T3 opens; this is not a T3-wide plugin installation.

**Tested:** Claude in T3 with Opus 5.5, and a bounded Superpowers exercise using
Sonnet 5.5 implementer/task-reviewer children and an Opus 5.5 final reviewer.
These observations do not establish universal model, host or subagent support.
Live Codex Sol 6.1 qualification remains pending.

## Set up one project

Use Node 24. Review existing instructions, skills, permissions and MCP entries
before editing. The [agent-assisted setup prompt](https://github.com/guisam/Agent-Profiles/blob/main/docs/setup.md)
is the recommended starting point for a new project.

As of 2026-11-11, npm's latest published version is **0.23.9**. Repository source
and examples may be newer; a source version bump is not a published release.

After approving installation/configuration, run from the target project:

```sh
npm install --save-dev --save-exact @guisam/agent-profiles@0.23.9
npx --no agent-profiles init --agent claude --mcp
npx --no agent-profiles doctor
```

Choose/configure roles and required/available skills using the
[configuration guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/configure.md).
The initializer installs the managed project bootstrap and prints MCP setup;
it does not itself register the server in every host.

Merge the printed setup into the project's `.mcp.json`, preserving other servers.
For example, substitute the actual project directory (use forward slashes on Windows):

```json
{
  "mcpServers": {
    "agent-profiles": {
      "command": "npx",
      "args": ["--no", "agent-profiles", "mcp", "--root", "/absolute/path/to/project", "--host", "claude"]
    }
  }
}
```

Host approval may be required. Keep the local AP installation and managed
`CLAUDE.md` block: when MCP is unavailable or still connecting, that block directs
the agent to the shell resolver. Without it, an early task may start before the
MCP instructions arrive. Follow host permissions; do not remove gates to make a
test pass. For other providers, follow the [host-specific MCP guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/mcp.md).

## Verify in T3

Open the target folder as the T3 project, select Claude and the intended model,
and start a fresh session. Assign a role that exists in the project:

```text
Your assigned role is <configured-role-id>. Verify Agent Profiles setup only.
Do not modify files or dispatch agents. Report the selected role, required
skills, retrieval method and final context completion line. Say what remains
unverified. Follow the project's bootstrap instructions.
```

Expect a successful `resolve` before role work and a final line beginning
`End of Agent Profiles context:`. Required skill bodies arrive in full;
available skills are listed for later retrieval. Referenced scripts/templates
remain on disk and need separate access. A connected server or valid lock alone
does not prove complete delivery or adherence.

Use host-provided exact model identity; do not guess from a display name.
Omit selectors the server says are bound. A missing required file, resolver error
or absent completion marker means setup is incomplete: stop role work.

## Clear, compaction and delegated agents

After clear or compaction, the agent must resolve instructions again. Task state
comes from the project's ledger/artifacts, not from AP. Test with a neutral task
and then ask for observable tool history; do not request private reasoning.

For each child, explicitly supply its role, project root, task and evidence paths.
Require independent resolution before work. Do not assume the parent's role or
skill text reaches the child. A bound reviewer server is unsuitable for a child
assigned another role unless the host supplies an appropriately configured server.

T3's supported delegation mechanism controls provider/model selection. AP
selects instructions for that model; it does not choose the actual model. Record
actual identities and separate delivery success from correctness and review quality.

## Observed results and limits

- One fresh/clear/compact sequence in T3 with Opus 5.5 resolved before review.
- Shell fallback with MCP absent was observed; one missing-required-skill retest
  reported incomplete setup and declined review.
- The Superpowers exercise recorded independent child resolution, supporting
  file access, coordinator compaction recovery and fresh-session state recovery.
- Repeated reliability trials, all failure modes, live Codex coverage, child
  recovery and cross-project isolation remain incomplete. Native plugins are not
  disabled by AP; inspect them separately when evaluating instruction isolation.

Sources: [host observations](https://github.com/guisam/Agent-Profiles/blob/main/docs/host-observations.md),
[Superpowers findings](https://github.com/guisam/Agent-Profiles/blob/main/examples/superpowers/FINDINGS.md),
[remaining failure tests #83](https://github.com/guisam/Agent-Profiles/issues/83),
[subagent qualification #82](https://github.com/guisam/Agent-Profiles/issues/82).
Evidence includes operator observations and saved agent reports, not complete
provider traces. No cost savings or universal reinjection guarantee is claimed.

Existing protocol-3 users need no migration for this guide. If upgrading from
an older bootstrap, rerun `init` for the selected host and inspect the changes.
