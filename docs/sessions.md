# Session records

A session record says which instructions a session actually ran:
- the stamp digest of its resolution;
- the model, role, host and project;
- the client (for MCP, the host's name and version);
- the package versions it selected;
- anything the [trust policy](trust.md) withheld.

This lets you tie a session's behavior, or an evaluation you ran in it, back to
the exact profile state. This is phase 7 of #38.

Records are **opt-in** and **machine-local**. They live under
`~/.agent-profiles/sessions/`, or the folder named by `AGENT_PROFILES_SESSIONS`.
Nothing is written to the project or the store.

## Turning it on

**MCP server:** add `--record-sessions` to the server's arguments. For Claude
Code, edit the `args` in `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-profiles": {
      "command": "npx",
      "args": ["--no", "agent-profiles", "mcp", "--host", "claude", "--record-sessions"]
    }
  }
}
```

One record file is written per server process, which for Claude Code is one per
session. It gets an entry for:
- the bound instructions at start (`bound`), when the server was started with
  `--model` or `--role`;
- each `resolve` or `explain` call, for example after compaction or a model
  change.

**CLI:** `agent-profiles resolve --record-session …` writes a one-entry record
(`cli`). It's for shell bootstraps and scripts.

Writing a record never fails a resolution. If the folder can't be written, the
server prints one warning on stderr and carries on.

## Reading records

```sh
agent-profiles sessions                 # this project's sessions, newest first
agent-profiles sessions --all           # every project
agent-profiles sessions --limit 50 --json
```

Each record (`--json`) holds:

| Field | Meaning |
| --- | --- |
| `id`, `startedAt`, `source` | the record, when it started, and `mcp` or `cli` |
| `agentProfiles` | the Agent Profiles version that wrote it |
| `client` | the MCP client's name and version, as the host reported it |
| `resolutions[]` | one entry per resolution (see below) |

Each resolution holds:
- **`at`** and **`via`:** when it happened, and whether it came from `bound`,
  `resolve`, `explain` or `cli`. A `bound` entry records the selection a bound
  MCP server validated at start. Since 0.19.3 the server's instructions carry no
  profile text, so it is not evidence that anything reached the agent; a later
  `resolve` entry is.
- **The selectors:** `root`, `host`, `model`, `role`, and the resolved `profile`.
- **`stamp`:** the stamp digest of the configured selection. It's the same digest
  `agent-profiles stamp` would record with the same selectors. If it couldn't be
  computed, `stampError` gives the reason.
- **`configuration`** (since 0.22.0, #98): `{mode: "committed"}`, or, with a
  [project adapter](project-adapter.md#stamps-verify-diff-and-evidence),
  `{mode: "composed", digest, adapter: {label, referenceDigest}}`. `digest` is the
  composed configuration digest that the adapter lock covers (`null` if no stamp
  could be computed). Treat results from different modes or different digests as
  different configurations. Records written before 0.22.0 have no
  `configuration` field.
- **`packages`:** each selected package's skill, name, version, sha256 and
  revision digest.
- **`withheld`:** skills the trust policy left out, with the reason.
- **`requested`:** skills loaded by `--skill` or `skills`.

## Checked live

Checked on Claude Code 2.1.318, Windows 11, on 2026-11-06, with Agent Profiles
0.18.0 and `--record-sessions` in `.mcp.json`. One session called `resolve`, and
`agent-profiles sessions` showed:
- one record with the client `claude-code 2.1.318`;
- a `resolve` entry `implementer × claude-opus-5-5 × claude → constrained` with
  its stamp digest and `@ap-live/security-review@1.1.0`.

The file was written under `~/.agent-profiles/sessions/2026-11-06/`, and nothing
was written to the project.

## Limits

- **Stamps aren't stored.** A record keeps the digest and the selection; the
  stamp itself goes into the store only if you run `agent-profiles stamp`. The
  record is enough to see which versions ran, but `verify <digest>` works only for
  retained stamps.
- **No transcripts.** A record says what the session was given, not what the model
  did with it.
- **Host session IDs aren't known.** The MCP server can't see the host's session
  ID, so a record is identified by its server process. A SessionStart hook sees
  the session ID but not the model, so it can't compute the stamp.
- **Removal is manual.** Records are never pruned; delete old day folders yourself.
