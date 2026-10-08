# Read-only external skill sources

External inventory is opt-in. Importing `src/external-skills.js` does not scan files;
callers must explicitly request discovery. The inventory reads local metadata, not
skill bodies, and does not execute skills, contact a service, inspect enabled-plugin
settings, install anything, or change host files. Machine-local paths belong in
local preferences, never in repository configuration.

## Supported inventory roots

| Source | Default root | Inventory identity |
| --- | --- | --- |
| Claude personal skills | `$CLAUDE_CONFIG_DIR/skills`, or `~/.claude/skills` | Direct child directory invocation alias |
| Codex user skills | `~/.agents/skills` | Exact YAML frontmatter `name` |
| Claude plugin skills | Explicitly approved root only | `namespace:frontmatter-name`, or directory fallback |

Claude roots scan direct children containing `SKILL.md`. `synced` (the downloaded
claude.ai catalog) and `anthropic-skills` (an unsupported reserved catalog) are
skipped with explanatory warnings; their descendants are not misclassified as
personal skills. Codex roots support nested directories conservatively, up to
eight directory levels. Inventory visits at most 4,096 directories across all
roots and warns when a limit is reached. A deeper tree can be approved as a
separate, more specific root.

Only the defaults above are inferred. Legacy `~/.codex/skills`, Codex admin
`/etc/codex/skills`, bundled/system catalogs, Claude enterprise roots, project
roots, downloaded catalogs and plugin caches are not automatically scanned.
`CLAUDE_CONFIG_DIR` replaces the personal Claude home; only its `skills` subdirectory
is inspected, not settings, sessions or credentials. This inventory requires an
absolute override without traversal. `CODEX_HOME` does not replace the documented
shared Codex user root `$HOME/.agents/skills`; its managed/system catalogs are not
automatically scanned. Explicit roots grant inventory permission only, not host enablement.

Directories and `SKILL.md` files are canonicalized before inspection. Internal
symlink directories are followed with visited-realpath deduplication. Links escaping
an approved canonical root are rejected with warnings. An approved root may itself
be a symlink: its resolved directory is the approval boundary. Identical canonical
skill targets with the same native identity are deduplicated. Duplicate native
identities at different targets remain visible but are not selectable: the
inventory does not invent host precedence or claim the host can address an exact
external origin by a portable name.

## Machine-local preferences

Default: `~/.config/agent-profiles/skill-sources.json`. Set
`AGENT_PROFILES_SKILL_SOURCES` to an absolute filename to override it. The API's
`sourcesFile` option takes precedence over the environment override. The default
preferences file may be absent; an explicitly requested file must be readable.

```json
{
  "version": 1,
  "roots": [
    {
      "host": "claude",
      "scope": "user",
      "path": "C:/Users/example/curated-skills"
    },
    {
      "host": "claude",
      "scope": "plugin",
      "path": "C:/Users/example/plugins/team/skills",
      "namespace": "team"
    },
    {
      "host": "codex",
      "scope": "user",
      "path": "C:/Users/example/shared-codex-skills"
    }
  ]
}
```

On Unix, use absolute paths such as `/home/example/curated-skills`. `~`, environment
substitutions, relative paths, NUL characters, and `..` traversal components are
not expanded or accepted. The only root fields are `host`, `scope`, `path`, and
`namespace`. Hosts are `claude` or `codex`; scopes are `user`, or `plugin` for
Claude only. A plugin namespace is required and must match
`^[a-z0-9][a-z0-9-]*$`; a user root must not have a namespace. Unknown fields,
unsupported versions/layouts, malformed JSON, unreadable preferences and files
over 64 KiB throw before inventory starts. Fix the preferences rather than silently
falling back to an incomplete catalog.

Missing skill roots are normal. Invalid metadata, inaccessible roots, broken links,
reserved directories and rejected escapes generate actionable warning strings.

## Exported API

```js
import {
  discoverExternalSkills,
  validateExternalSelection,
} from './src/external-skills.js';

const options = {
  // Optional: defaults to OS homedir and process.env.
  home: '/home/example',
  env: {},
  // Optional absolute local preferences filename.
  sourcesFile: '/home/example/.config/agent-profiles/skill-sources.json',
  // Optional additional explicitly approved roots, with the same root schema.
  roots: [],
};
const { skills, warnings, roots } = discoverExternalSkills(options);
// Before planning AND immediately before applying a previewed path selection:
const fresh = validateExternalSelection(skills[0], options);
```

`discoverExternalSkills(options = {})` returns `{skills, warnings, roots}`.
`roots` lists the known and approved root specifications (including missing roots);
`warnings` contains strings. Each skill has:

```js
{
  id: 'claude-plugin-team-review',
  host: 'claude',
  scope: 'plugin',
  hostId: 'team:review',
  path: '/canonical/approved/root/review/SKILL.md',
  origin: '/canonical/approved/root',
  source: 'claude-plugin', // or 'claude-user', 'codex-user'
  external: true,
  name: 'review',
  description: 'Review code changes.',
  availability: 'metadata-found',
  runtime: 'unverified',
  selectable: true
}
```

The portable alias is `${host}-${scope}-${hostId.replace(':', '-')}`. Native names
are checked, not repaired: lowercase letters, digits and hyphens, starting with a
letter or digit. Codex requires a frontmatter name; a quoted padded name is not
trimmed into a valid native token. Display names/descriptions use the shared
bounded `skillMetadata` parser. YAML frontmatter is limited to 64 KiB; BOM and
CRLF are accepted. No body content is returned or loaded in full.

`validateExternalSelection(selection, options = {})` returns the fresh matching
skill descriptor or throws. It reruns inventory from independently approved
options and requires exact host, scope, native identifier, canonical file path,
canonical origin, name and description, plus current selectability. It rejects
missing, repointed, changed, forged or newly ambiguous selections. The selection's
`origin` never grants approval. It is not a filesystem lock: callers must validate
again immediately before writing. Body-only changes are outside this metadata
fingerprint. Opaque configured native references without paths are a separate
host-provided mechanism; do not pass them to this path-selection validator.

## Host-runtime boundary and primary references

Metadata discovery proves only that local metadata was found. It does **not**
prove a plugin is enabled, that a host has loaded the source, invocation permission,
precedence against project/system skills, or successful execution. Confirm those
inside the actual host session. No installed host was executed for this inventory.

- [Claude Code skills](https://code.claude.com/docs/en/skills) documents personal
  roots, plugin namespaces, symlink support and downloaded catalogs. Personal
  directory names remain invocation aliases when frontmatter supplies another name.
  This inventory uses that directory alias for portable personal bindings. Plugin
  frontmatter names set the last command segment; an already-qualified name keeps
  the namespace without doubling it. Padded tokens or different namespaces are
  rejected, not repaired. Optional Claude descriptions remain null; host-derived
  descriptions and settings-derived aliases are not inspected.
- [Claude Code settings](https://code.claude.com/docs/en/settings) documents
  `CLAUDE_CONFIG_DIR` as the custom home for personal files.
- [Codex skills](https://developers.openai.com/codex/skills), redirected to
  [Build skills](https://learn.chatgpt.com/docs/build-skills), documents user skills
  under `$HOME/.agents/skills`, admin/system sources, symlink directories and
  multiple skills with the same name. External inventory does not infer a winner
  among duplicate native names or assert automatic loading of legacy locations.
