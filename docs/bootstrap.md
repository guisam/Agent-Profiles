# Bootstrap protocol

The host supplies repository instructions using its normal instruction hierarchy.
Agent Profiles resolves only the additional layers; it does not replace, reread,
or edit `AGENTS.md`. Model and family identities come from runtime metadata or
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

The following block is ready for a future installer or integration to insert.
This issue does not modify any agent-specific instruction file.

```markdown
## Agent Profiles

Before beginning work, read `.agent-profiles/agents.yaml` and follow
`docs/bootstrap.md`. Use runtime-provided model and family identities when
known; never select a profile by judging your own capabilities.

Resolve exactly one profile (exact model, then family, then default) and your
assigned role (or `default_role`). Keep existing repository instructions and
load only the resolved profile, role, and required skills. Expose available
skill IDs, names, descriptions, and paths without loading their bodies until
explicitly needed; do not
load skills outside that role's lists. Report configuration errors rather
than silently substituting instructions.
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
paths, and `required` and `available` skill metadata lists. All output paths are
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
`path` and `content`. All arguments are optional; omit unavailable identity or
role values rather than supplying empty strings. Invalid input or configuration
throws an error identifying the entry. The caller supplies repository context,
inserts `loaded` contents, and exposes the available index using its host APIs.
`skills` is an optional list of requested IDs. Required skills are already loaded;
repeated requests for the same ID do not duplicate content. Each call returns a
complete resolved context, not a delta: hosts should replace the previous result
or deduplicate by path instead of appending it again. When roles change, drop any
previous skill requests that the new role does not permit.
The resolver does not inject prompts into an agent or execute skill files.

See [architecture.md](architecture.md) for the schema and ownership boundaries.
Agent-specific adapters and installation remain separate work.
