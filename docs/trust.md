# Trust policy and signed approvals

Skills are instructions that end up in an agent's context, so a tampered or
malicious version works like prompt injection delivered through the supply chain.
A trust policy says which packages may reach a project and who may approve them.
An approval is an SSH signature over one version's exact bytes. See #55 for the
threats and #71 for the design.

> **Status (0.17.0):** policy, signed approvals and enforcement are in place
> (#71). Projects without a policy are unaffected. Checked live on Windows 11
> with OpenSSH: `library approve` signed with a passphrase-protected Ed25519 key,
> and `library info` and `doctor` reported the approval.

## Policy files

**Machine policy:** `~/.agent-profiles/trust.yaml`, or the file named by
`AGENT_PROFILES_TRUST` (useful in CI):

```yaml
version: 1
allowed_signers: ~/.ssh/allowed_signers   # who may approve, with which keys
signing_key: ~/.ssh/id_ed25519_sk.pub      # the key `library approve` will sign with
require_approval: false                    # opt-in
namespaces: ["@guisam/*", "@ap-live/*"]    # omitted = any namespace
effects: [substitution]                    # allowed manifest effects
principals: ["*@example.com"]              # omitted = any principal in allowed_signers
```

- **`allowed_signers`:** an OpenSSH `allowed_signers` file, the same format Git uses
  for SSH commit signing (`gpg.ssh.allowedSignersFile`). A relative path is resolved
  from the policy file's folder, and `~` means your home folder.
- **`effects`:** the manifest effects a package may declare. The default is
  `substitution` only, so `commands`, `external-references` and
  `host-configuration` need to be listed to be allowed.
- **`require_approval`:** off unless a policy turns it on.

**Project policy:** `.agent-profiles/trust.yaml`, committed with the project. It can
only narrow the machine policy:

- `namespaces`: a package must match the machine list and the project list;
- `effects`: only effects both lists allow;
- `require_approval: true`: either file can turn it on, and neither can turn it off
  for the other;
- `principals`: an approver must match both lists.

A project policy can't name `allowed_signers` or `signing_key`. Repository files can
be edited by any process, including an agent, so keys come only from the machine
policy.

## Signatures

Approvals use the SSH signature format (`ssh-keygen -Y sign`, namespace
`agent-profiles-approval`). Agent Profiles verifies them itself, without calling
`ssh-keygen`:

- **Key types:** `ssh-ed25519`, and `sk-ssh-ed25519@openssh.com` for hardware keys
  (FIDO2 security keys). RSA, ECDSA and certificate authorities aren't supported
  yet; `allowed_signers` lines that use them are reported and skipped.
- **`allowed_signers` options:** principal patterns (`*`, `?`, `!` to exclude),
  `namespaces=`, `valid-after=` and `valid-before=`.
- **Hardware keys need a touch.** A signature from a hardware key must have the
  user-presence flag set. This is stricter than `ssh-keygen -Y verify`, which
  accepts an untouched signature: the touch is what an agent session can't supply.

## Approving a version

```sh
agent-profiles library approve @ap-live/security-review@1.1.0
```

This command:
1. Verifies the version in the library.
2. Writes `.agent-profiles/approvals/@ap-live/security-review/1.1.0/<principal>.json`
   with the package, version, object digest, principal and time.
3. Signs that file with `ssh-keygen -Y sign` using `signing_key` (or `--key`).
   A hardware key asks for a touch; a passphrase-protected key asks for the
   passphrase or uses your `ssh-agent`.
4. Verifies the result as every later check will. If signing or verification
   fails, nothing is left behind.

Commit both files with the project. Reviewers see the approval in the pull
request, and CI and teammates verify the same files against their own
`allowed_signers`.

- **Principal:** taken from the `allowed_signers` line for your key. If the key
  is listed for more than one principal, or only for patterns, pass
  `--principal`.
- **What's approved:** the version's exact object digest. If the library's bytes
  for that version differ, the approval doesn't count.
- **Formatting:** the signature covers a canonical form of the JSON, so a project
  formatter that reflows the file doesn't break it. Changing any value does.
- **Agents:** `init` denies `library approve` to agents, like the other
  library-changing commands. The key is the real boundary (see below).

## Approval status

With a trust policy, these show whether a version is approved, by whom, and
anything that breaks the policy:

| Where | Field in `--json` / MCP |
| --- | --- |
| `library info --root <project>` | `approvals` (per version) |
| `outdated` | `approval` on each newer version |
| `update` preview and `update_preview` | `approval` for the target version |
| `doctor` | with `require_approval`, a note for each pinned version that isn't approved |

The status is `approved` when at least one approval file verifies. Files that
don't count are listed with the reason, never silently ignored:
- an unknown key or principal;
- a principal the policy doesn't allow;
- a changed payload;
- a different digest;
- a missing `.sig`.

Without a policy the fields are `null`.

## Enforcement

| Command | Always, with a policy | With `require_approval: true` |
| --- | --- | --- |
| `resolve` (CLI and MCP) | withholds packaged skills whose namespace or effects the policy doesn't allow | also withholds packaged skills without a valid approval |
| `install` | refuses pinned versions that break the policy | also refuses unapproved pinned versions |
| `update --apply` | refuses a target that breaks the policy | also refuses an unapproved target; the preview says so in advance |
| `update --apply`, `library publish` | without a `signing_key`, ask on a terminal for a short code (see below) | same |

**Withheld skills:**
- **What changes:** `resolve` still returns the profile and role, so sessions keep
  working. A withheld skill is left out of the required, available and loaded
  lists, and listed under `withheld` with the reason (`--json` and MCP).
- **What the agent sees:** a "Withheld by the trust policy" section. It tells the
  agent not to look for the skill's text elsewhere, such as the store folder, and
  to tell you.
- **What doesn't change:** `outdated`, `update` previews and `library info` still
  show configured pins, so you can see and approve what's withheld.

**Terminal confirmation without a key:**
- **When it applies:** a policy exists but names no `signing_key`.
- **What it asks:** `update --apply` asks you to type the first 8 characters of the
  preview digest, and `library publish` asks for the package's `name@version`.
- **Why it slows agents down:** an agent's shell has no terminal, so the command
  refuses there.

It's a speed bump; signed approvals are the boundary.

### Turning on require_approval

Approve what's already pinned first, or sessions will start without those skills:
1. With a policy that has `allowed_signers` and `signing_key` but not
   `require_approval`, run `doctor`.
2. Temporarily set `require_approval: true`. `doctor` then lists each unapproved
   pin with the command to approve it.
3. Run `agent-profiles library approve <@namespace/name>@<version>` for each.
4. Commit `.agent-profiles/approvals/`.
5. Run `doctor` again; the approval notes are gone.

To limit `require_approval` to one project, set it in that project's
`.agent-profiles/trust.yaml` instead of the machine policy.

## Which key to use

An approval is a boundary only if an agent can't produce one. An agent with a
shell can run `ssh-keygen -Y sign` through a loaded, unlocked `ssh-agent`, so:

- **Best:** a hardware key (`ssh-keygen -t ed25519-sk`). Every signature needs a
  touch.
- **Good:** a passphrase-protected key added with `ssh-add -c`, so the agent asks
  you to confirm each use.
- **Weak:** a key without a passphrase. An agent session can sign with it.

## doctor

With a policy in place, `doctor` prints one line that names the policy files,
whether `require_approval` is on, how many signer keys were loaded, and the
allowed namespaces and effects. It reports as errors anything that would stop
approvals from verifying:

- a policy file that isn't valid;
- a project policy that tries to widen the machine policy or name keys;
- a missing `allowed_signers` file, or lines in it that can't be used;
- `require_approval` without an `allowed_signers` file.
