# Bootstrap protocol

Agent Profiles supports two integration modes. Each statement below names the
mode that can actually guarantee it.

- **Bootstrap mode** is for hosts whose only hook is an instruction file, such as
  Claude Code (`CLAUDE.md`) and Codex (`AGENTS.md`). The installer adds a managed
  block asking the agent to run the resolver. Agent Profiles guarantees the block,
  the configuration check, and what `resolve` prints for a given identity and role.
  Running the command, copying the right identity, and re-running it are agent
  behavior, verified only by live-host tests.
- **Native mode** is for a host that calls the resolver API while building
  context. The host supplies identity, role, and lifecycle events and replaces
  context itself, so the resolution is exactly what the agent receives.

No native integration ships yet. The protocol reference copied into each
repository is [BOOTSTRAP.md](../.agent-profiles/BOOTSTRAP.md); observed host
behavior is in [host-observations.md](host-observations.md).

## The managed block

```markdown
<!-- agent-profiles:start -->

## Agent Profiles

At the start of every new or compacted context, and after a model change,
run this exact command (no `cd` or other prefix) and follow its output:

    npx --no agent-profiles resolve --model "<exact model ID>"

Use the exact model ID your host states for you (for example, "The exact
model ID is ..."): not a display name, another model's ID, or your own
recollection. If the host states none, omit `--model`. Add `--role <id>` only
when the user or your agent definition assigns a role. If the command fails,
report its error; do not read `.agent-profiles/` to route by hand.

<!-- agent-profiles:end -->
```

The wording is maintained in [integrations.js](../src/integrations.js). Running
`init` again replaces an outdated managed block in place.

The model's only routing task is copying one string. Live tests found that
models asked to match `agents.yaml` themselves made mistakes, for example
treating a dated model ID as matching an undated key. Aliases, family prefixes,
validation, and file selection therefore happen in code.

`--no` makes `npx` fail instead of downloading. Agent Profiles never runs a
package fetched from the registry at bootstrap time, even if the name is taken
by someone else.

## Host setup

1. Install the package in the repository: `npm install --save-dev agent-profiles`
   (until v0.1.0 is published, install a packed tarball; see [installer.md](installer.md)).
   The command then resolves from `node_modules/.bin` without a network request.
2. Allow the command so the agent is not blocked on a permission prompt. In
   Claude Code, add both rules; on Windows, models often choose PowerShell:

   ```json
   {
     "permissions": {
       "allow": [
         "Bash(npx --no agent-profiles resolve:*)",
         "PowerShell(npx --no agent-profiles resolve:*)"
       ]
     }
   }
   ```

3. Run `agent-profiles doctor`. It reports configuration errors, host skill
   verification, and the observed capabilities of each installed integration.

## Identity

Claude Code states `The exact model ID is <id>.` in every observed context,
including subagents and after a model change. The same prompt also lists the IDs
of *other* Claude models, and a model launched with an alias such as `haiku` sees
the dated ID (`claude-haiku-4-5-20251001`). Configure the IDs your host actually
exposes, using aliases and family prefixes (see [architecture.md](architecture.md#model-resolution)).
Run `agent-profiles proof --model <id>` to check a route.

Claude Code hooks do not receive the model, so a hook cannot resolve a profile at
session start. Codex identity exposure has not been observed yet.

## Roles

The role is `default_role` unless `--role` is passed. In bootstrap mode the agent
passes a role only when one is assigned: by the user, or by an agent definition.

For Claude Code, a custom agent in `.claude/agents/<name>.md` gives a role its own
session and model. Put the exact command in the agent's instructions; naming the
role alone was not enough in live tests:

```markdown
---
name: reviewer
description: Reviews changes using the Agent Profiles reviewer role.
model: haiku
---

Before any other step, run `npx --no agent-profiles resolve --role reviewer --model "<exact model ID>"`
with the exact model ID your host states for you, and follow its output.
```

Built-in subagents such as Explore do not receive `CLAUDE.md` and so get no
profile.

## Lifecycle

| Event | Bootstrap mode (expectation, observed on Claude Code) | Native mode |
| --- | --- | --- |
| New session | Agent runs `resolve`; observed reliably | Host resolves before the first turn |
| Compaction | Block is re-injected; Claude Code also re-attaches recently read files. Agent re-ran `resolve` when asked about its profile | Host treats reconstruction as a resolution event |
| Model change | Re-ran `resolve` when asked about its profile; **not** on an unrelated task. The previous profile text stays in context | Host resolves with the new identity and rebuilds context |
| Role change | A new session or custom agent is the only clean transition; a rerun with `--role` supersedes but cannot remove earlier text | Host resolves the new role before rebuilding context |
| Subagent | Custom agents receive the block; built-in Explore does not | Host resolves per subagent |

Each `resolve` output states that it supersedes earlier Agent Profiles text in
the same context. That is an instruction to the agent, not removal.

## The resolve command

```sh
agent-profiles resolve [--model <id>] [--family <id>] [--identity-source host|user]
                       [--role <id>] [--skill <id> ...] [--json [--contents]]
```

Without `--json`, it prints the agent-facing context:

- The profile, role, and required instruction skills, each injected in full.
- Required host skills, named with the host skill to invoke.
- Available skills, with their descriptions. Instruction skills show a path to
  read, and host skills show the host skill to invoke.
- A reminder to read `AGENTS.md` when it exists, since Claude Code does not load it.
- The exact command to run again, and when.

From a checkout, `npm run resolve -- --model example-model --role reviewer`
prints the JSON form. `--skill testing` injects an available instruction skill;
requesting a host skill injects nothing. Errors go to stderr with exit status 1
and no partial output.

## JSON and API

```js
import { resolveInstructions } from './src/resolve.js';

const result = resolveInstructions({
  root: process.cwd(),
  host: 'claude',         // the consuming integration
  model: 'claude-opus-5-5[1m]',
  identitySource: 'host', // or 'user'; omit when unknown
  role: 'reviewer',
  skills: ['testing'],    // omit to inject only required skills
});
```

The synchronous result contains:

- `model`, `family`, and `familySource` (`supplied` or `configured-prefix`).
- `matchedBy` (`model`, `alias`, `family`, `family-prefix`, or `default`), and
  `identity` (`raw`, `canonical`, `source`, `matchedBy`) for provenance.
- `host`: the consuming integration, or `null`.
- `profile`, `role`, and `roleSource` (`assigned` or `default`).
- `repository` (host-supplied `AGENTS.md` and whether it exists).
- `loaded`: the injected entries, with `path`, `content`, `kind`, `id`, `bytes`,
  and `characters`.
- `required` and `available`: skill metadata with `type`, `delivery`, and
  `nameSource`. Host skills also carry `host`, `hostId`, `verification`, and `usable`
  for the consuming host.
- `unsatisfied`: required host skills the consuming host cannot invoke, with reasons.
- `diagnostics`.

Each call returns a complete resolution, not a delta. A native host should
replace the previous result, and drop skill requests the new role does not
permit. The resolver never injects prompts or executes skill files.

See [architecture.md](architecture.md) for the schema and [installer.md](installer.md)
for installation and removal.
