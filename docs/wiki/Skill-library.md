# Skill library

The package store is also your local skill library (source version 0.8.0; evidence in 0.9.0; outdated and update in 0.10.0; update notice in 0.11.0). One
folder on your machine (`~/.agent-profiles/store` by default) holds every version
you have published, content-addressed by SHA-256. Projects pin exact versions in
`agents.yaml` and lock them.

```sh
agent-profiles library publish ./skills/security-review
agent-profiles library list
agent-profiles library search security
agent-profiles library info @example/security-review --root /path/to/project
agent-profiles library read @example/security-review@2.0.0 SKILL.md
agent-profiles library evidence @example/security-review --model claude-haiku-4-5 --role reviewer
```

- **publish** imports a package directory, reading its name and version from
  `package.yaml`. It gives the same result as `add`.
- **list**, **search** and **info** are read-only and verify every version they
  show. **info** `--root` marks which versions a project pins and whether its lock
  agrees. Promoted releases are listed too.
- **Evidence (0.9.0):** `info` and `evidence` show, for each version, the paired
  evaluations retained for each exact role × model × host. Each row gives the
  outcome (promoted, overridden, eligible but not promoted, or blocked),
  correctness on each side, metric deltas, and whether the evidence came from
  this project or another one. With a model filter, versions without evidence are
  listed as untested, so you can choose a version that has shown it works for
  that model.

- **Outdated and update (0.10.0):** `outdated --root .` lists every pin with
  the tuples it serves, newer versions, and the evidence each newer version has
  for those tuples. `update <binding> <version> --model --role --host` previews
  a move of one exact tuple's pin; `--apply` writes it, keeping every other
  model's pins unchanged, then refreshes the lock.
  Since 0.13.1, a model that `agents.yaml` doesn't declare (it reaches a profile
  through `default_profile` or a family) is declared with its current profile in
  the same edit, so its routing doesn't change.

- **Update notice (0.11.0):** for Claude Code, `init` adds a startup-only hook
  that tells you, not the agent, when the library has newer versions for your
  pins. Promoted evidence for your exact tuples gets its own line; the rest is a
  count. It appears at most once a day, and only when something changed.
  Checked live on Claude Code 2.1.318: it shows as `SessionStart:startup says:`
  on a new session, and not after `/clear` or on an unchanged restart.
  `outdated --check` gives CI the same answer as an exit code.

- **Guardrails (0.12.0):** for Claude Code, `init` denies the library-changing
  commands to agents (publish, approve, add, install, update, promote, revision record,
  init, uninstall), so you run those yourself. `update` previews show the exact
  text a new version would inject, as a diff. Deny rules are a guardrail against
  accidents, not a security boundary; signed approvals are planned in #55.
  Checked live on Claude Code 2.1.318: an agent's `library publish` was refused
  and `outdated` ran. Shell `update` previews are refused for agents too; agents
  use the MCP `update_preview` tool instead (0.13.0), which an agent chose on its
  own in a live check. Since 0.13.2 the preview lists every `agents.yaml` edit and
  ends with the complete command you run to apply it.

- **Trust policy and approvals (0.15.0–0.17.0):**
  - `~/.agent-profiles/trust.yaml` names who may approve versions (an OpenSSH
    `allowed_signers` file), which namespaces and manifest effects are allowed, and
    whether approvals are required. A project's `.agent-profiles/trust.yaml` can
    only narrow it.
  - `library approve <@ns/name>@<version>` signs an approval of that version's
    bytes with your SSH key, written under `.agent-profiles/approvals/` to commit.
  - `info`, `outdated` and `update` previews show approval status.
  - Enforcement (0.17.0): `resolve` withholds blocked skills, and `install` and
    `update --apply` refuse them. Approve existing pins before turning on
    `require_approval`.

Details, the manifest format and limits are in
[docs/versioned-packages.md](https://github.com/guisam/Agent-Profiles/blob/main/docs/versioned-packages.md#library-browse-search-inspect-and-publish).
This is phase 2 of the [skill librarian](https://github.com/guisam/Agent-Profiles/issues/38);
see [#44](https://github.com/guisam/Agent-Profiles/issues/44).

[Return to the documentation home](https://github.com/guisam/Agent-Profiles/wiki).
