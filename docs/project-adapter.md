# Project adapter: a local layer over committed configuration

Issue: [#85](https://github.com/guisam/Agent-Profiles/issues/85). Since 0.20.0 (first slice).

A contributor can use private, pinned skills in a project without changing the
project's committed configuration, lock or npm package. One ignored file names one
external **adapter** directory. Agent Profiles composes the adapter over the
committed configuration.

```text
project/.agent-profiles/agents.yaml          committed, portable defaults
project/.agent-profiles/agents.local.yaml    ignored: adapter: ../project-config
project-config/.agent-profiles/agents.yaml   the adapter's additions
project-config/.agent-profiles/roles/*.md    files for roles the adapter adds
project-config/.agent-profiles/agent-profiles.lock
project-config/.agent-profiles/approvals/    approvals recorded in adapter mode
```

Keep the adapter in its own repository, one adapter per project. Packages come
from the local library by `name@version`. The adapter does not reference the
repository the packages were built in.

## Connection

`.agent-profiles/agents.local.yaml` contains exactly one key:

```yaml
adapter: ../project-config   # relative to the project root, or absolute
```

- No local file: the committed configuration alone applies.
- The reference must resolve to an existing directory outside the project that
  does not contain the project, with `.agent-profiles/agents.yaml`. Otherwise
  every command that reads configuration fails and names the remedy. There is no
  silent fallback.
- An adapter cannot contain `agents.local.yaml` (no chains) or `trust.yaml`.
- Add `.agent-profiles/agents.local.yaml` to the project's `.gitignore`. The npm
  package never includes it (`test/package-files.test.js`).

## Precedence

Every binding and every assignment belongs to exactly one layer. The adapter
adds; it never overrides.

| The adapter may | The adapter may not |
| --- | --- |
| Add skills under new IDs, bound to packages | Redeclare a project skill, role, profile or assignment |
| Append skills to a project role's `required`/`available` lists | Change a project role's file, package or description |
| Add roles, with a file in the adapter or a package | Shadow a project file with an adapter file |
| Add assignments that select only adapter-declared bindings | Assign versions to a project binding |
| | Set `default_profile`, `default_role`, `models`, `families`, `profiles` or `workflow_links` |

### Exact-model selection

An adapter assignment may name, in `when.model`, an exact model ID that the
project does not declare. This applies only to the adapter's own bindings. The
project's `models` routing is not changed: the profile still comes from the
project's model, family or default route.

```yaml
skills:
  review: {package: "@local/review", version: 1.0.0}      # baseline
assignments:
  opus-review:
    when: {model: claude-opus-5-5}
    versions: {skills.review: 1.1.0}                       # exact model only
```

Only a host-stated model equal to that ID selects the rule. No model, another model,
a near match such as `claude-opus-5-5-20261101`, a prefix, or a different case keeps
the baseline. An ID that is a project alias is refused; name the canonical model.
Validation checks every adapter-named model under the default and each family
profile, so an ambiguous combination is refused before any session.

Within one layer the existing rule applies: per binding, a matching rule with a
strict superset selector wins, and incomparable or duplicate rules are refused.
Because ownership is exclusive, no rule compares across layers.

Versions: the adapter declares `version: 2` or `3`. It composes with a project of
the same version. It also composes with a version 1 project if the adapter is
version 2, because v1 to v2 changes only the scalar.

Trust is unchanged: the machine policy narrowed by the project's `trust.yaml`.

## Locks, approvals and signing

- With an adapter, the lock lives in the adapter and covers the whole composed
  configuration. `install` writes only that lock. The project's lock is neither
  read nor written. Any change to the project configuration, the reference or the
  adapter configuration makes the lock stale.
- Approval checks read the project's `approvals/` and the adapter's.
  Approval files name the package, version and digest, not a path, so moving them
  between the two does not invalidate a signature.
- Signing is separate. `install` and `update` never sign or write approvals.
  `library approve` is the only command that signs; in adapter mode it records the
  approval in the adapter.

## Commands

Commands that compose the adapter: `resolve`, `install`, `doctor`, `notice`,
`library`, `outdated` (read-only), `mcp` (except `update_preview`), and the
store-only stamp reads `verify` and `diff`.

Every other command refuses while an adapter is configured. This includes `update`,
`configure`, `init`, `uninstall`, `preset`, `migrate`, `stamp` and `inspect`. Each
names the local file to move aside to run on the committed configuration. They do
not act on one layer silently.

Provenance: `resolve --json` and MCP `explain` include an `adapter` field (its
reference, root and the entries it added) only when an adapter composes. `doctor`
reports the same. Committed-only output is unchanged.

## Migration and rollback

The workshop repository provides a snapshot-backed tool:
`workflow-skills/scripts/adapter-migration.mjs`.

1. `snapshot` copies `.agent-profiles/**` and host files and hashes them. It also
   records the resolution of every role × model × host, plus approval status for
   each pinned package.
2. `migrate` refuses if anything changed since the snapshot. It writes the overlay
   (adapter additions only), the added role files and the approval bytes to the
   adapter. It then restores the committed `agents.yaml`, adds the reference and
   runs `install`. It compares every resolution with the snapshot, and rolls back
   on any difference.
3. `rollback` restores the snapshot bytes, removes the reference and verifies
   resolutions. It does not change the adapter directory.

## Not in this slice

`update` and the configure, preset and migration writers do not target an
adapter yet (#97 guarded updates; #98 stamps, evidence and inspect). Adapters cannot declare or route models;
exact-model selection above does not change routing. Adapter roles cannot declare
`resources`.
