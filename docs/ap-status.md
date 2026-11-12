# Session skill status

Starting with 0.25.0, Agent Profiles ships `ap-status`, a read-only native skill.
It reports the last successful resolution visible in the conversation: host,
model, profile, role, required skill package versions, optional skills actually
loaded, and optional skills still "on the bench". It distinguishes native
references from confirmed instruction delivery and reports unknown versions
honestly. It does not silently resolve again or change role bindings.

## Install or upgrade

Use Node 24 or newer. Once 0.25.0 is published, upgrade the project dependency
to that version and rerun `init` for your host. For an unreleased checkout, build
and use its packed artifact instead; do not assume the version is on npm.

```sh
npm install --save-dev --save-exact @guisam/agent-profiles@0.25.0
npx --no agent-profiles init --agent codex
# Or, for Claude Code:
npx --no agent-profiles init --agent claude
```

Keep your existing MCP choice; `init` without `--mcp`/`--no-mcp` preserves it.
No configuration migration is required. The skill is installed independently
of your roles, not added as a required skill to every resolution.

| Host | Installed location | Invocation |
| --- | --- | --- |
| Codex | `.agents/skills/ap-status/` | `/skills`, select `ap-status`, or `$ap-status` |
| Claude Code | `.claude/skills/ap-status/` | `/ap-status` |

These are host discovery conventions, not a guarantee about every wrapper's
slash menu. Restart the host if the new skill does not appear. Codex can show
both personal and project copies with the same name; if you previously created
a personal `ap-status`, choose the project copy or remove the personal copy
yourself. The installer never edits user-level skill folders.

This release does not install native status commands for OpenCode or Hermes.
The portable skill ships at `skills/ap-status/SKILL.md` in the package and can
be read explicitly in those hosts. Their native menu integration is unverified.

## Ownership and removal

`init` records hashes of the files it creates in
`.agent-profiles/status-skill.json`. Rerunning `init` refreshes unchanged managed
copies, including already-installed Codex/Claude integrations. A pre-existing
or edited target causes an actionable error before any writes; move it aside
and rerun to adopt the bundled copy. Do not remove the ownership record while
keeping managed copies if you want automatic upgrades.

`uninstall` removes unchanged managed files and the ownership record. Edited
skill files and unrelated files are retained, including when configuration is
deleted. Empty skill directories may remain.

## Evidence limits

The report describes the last complete resolution available in that session,
not a live runtime monitor. Missing history after compaction is unknown. A
fresh resolution establishes a new baseline, not proof of what loaded earlier.
Listed optional skills are not loaded just to inspect them. Instruction presence
does not prove execution or compliance.

Host references: [Codex skills](https://learn.chatgpt.com/docs/build-skills)
and [Claude Code skills](https://code.claude.com/docs/en/skills).
