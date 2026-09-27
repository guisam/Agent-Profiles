# Bootstrap protocol

The host supplies repository instructions using its normal instruction hierarchy.
The resolver supplies only the additional layers; it does not replace, reread,
or edit `AGENTS.md`. The installer adds a managed bootstrap block while preserving
existing instructions. Model and family identities come from runtime metadata or
explicit user input. Omit unknown identities; never guess capability or infer
family membership from a name prefix.

1. Read and validate `.agent-profiles/agents.yaml` and its file references.
2. Resolve one profile: exact model, then supplied family, then default.
3. Resolve one role: explicitly assigned role, otherwise `default_role`.
4. Load the profile, role, and all required skills in that order.
5. Advertise only the selected role's available skill IDs, names, descriptions,
   and paths. Load their contents later only on an explicit request relevant to
   the task. Do not discover or load other skills.

On a configuration error, stop bootstrap and report the offending entry. Unknown
models are valid and use the fallback rules; invalid references are errors.
Validation checks all declared references, including available skills and
inactive roles, and reads skill metadata without loading unselected bodies into
context. Explicit source mappings are validated even if unused. Missing available
skills therefore fail this resolver's validation; the YAML remains directly
inspectable even when resolution fails.

When the assigned role changes, recompute context from the repository instructions
and the newly resolved layers. The host is responsible for replacing previous
role and skill context. Additional instructions cannot override repository
invariants or host permissions.

## Reusable instruction block

The installer inserts a small managed block pointing to the portable
[routing protocol](../.agent-profiles/BOOTSTRAP.md), which is copied into the
target repository. Its wording is maintained in
[integrations.js](../src/integrations.js). It does not depend on this project's
`docs/` directory or a globally installed CLI.

```markdown
<!-- agent-profiles:start -->

## Agent Profiles

Before beginning work, read `.agent-profiles/agents.yaml` and follow
`.agent-profiles/BOOTSTRAP.md` from the repository root. Keep existing
repository instructions. Resolve one model profile and an independent role;
load only that profile, role, and required skills. Expose available skill
metadata and load their bodies only when needed. Never select a profile
by assessing your own capabilities. Report configuration errors.

<!-- agent-profiles:end -->
```

## Try the resolver

From a checkout, with Node.js 22 or newer:

```sh
npm ci
npm test
npm run resolve -- --model example-model --family example-family --role reviewer
npm run resolve -- --model unknown-model
npm run resolve -- --role reviewer --contents
npm run resolve -- --role reviewer --skill testing --contents
```

The first resolution selects `autonomous` via the exact model mapping, loads
the reviewer and `code-review` instructions, and lists `testing` without its
contents. An unknown model with no supplied matching family uses `constrained`.
`--root <repo>` targets another repository; the default is the working directory.
Flags must be explicit: missing values and unknown flags are errors.

The JSON output reports `model`, `family`, `matchedBy` (`model`, `family`, or
`default`), `profile`, `role`, host-owned `repository` instructions, `loaded`
paths, and `required` and `available` skill metadata lists. Loaded entries also
identify their kind/ID and exact byte/character counts; selected skill metadata
includes counts, and `diagnostics` reports category totals and accounting boundaries.
All output paths are
repository-relative. Use `--contents` to include the selected instruction texts.
`--skill testing` explicitly adds that available skill to `loaded`; repeat the
flag for multiple skills. Merely passing `--contents` does not select available
skills. Requests outside the selected role's skill lists fail. Errors go to
stderr with exit status 1 and no
partial resolution on stdout.

## Integration API

```js
import { resolveInstructions } from './src/resolve.js';

const result = resolveInstructions({
  root: process.cwd(),
  model: 'example-model',
  family: 'example-family',
  role: 'reviewer',
  skills: ['testing'], // Omit this to load only required skills during bootstrap.
});
```

The synchronous API returns the same result with `loaded` entries containing
`path`, `content`, `kind`, `id`, `bytes`, and `characters`. All arguments are optional; omit unavailable identity or
role values rather than supplying empty strings. Invalid input or configuration
throws an error identifying the entry. The caller supplies repository context,
inserts `loaded` contents, and exposes the available index using its host APIs.
`skills` is an optional list of requested IDs. Required skills are already loaded;
repeated requests for the same ID do not duplicate content. Each call returns a
complete resolved context, not a delta: hosts should replace the previous result
or deduplicate by path instead of appending it again. When roles change, drop any
previous skill requests that the new role does not permit.
The resolver does not inject prompts into an agent or execute skill files.
Selected-role available skills are scanned for diagnostics without including
their bodies in the returned context. [Context proof](proof.md) documents exact
measurement semantics and the user-facing `agent-profiles proof` command.

See [architecture.md](architecture.md) for the schema and ownership boundaries.
See [installer.md](installer.md) for installation, adapters, and safe removal.
