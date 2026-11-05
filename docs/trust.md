# Trust policy and signed approvals

Skills are instructions that end up in an agent's context, so a tampered or
malicious version works like prompt injection delivered through the supply chain.
A trust policy says which packages may reach a project and who may approve them.
An approval is an SSH signature over one version's exact bytes. See #55 for the
threats and #71 for the design.

> **Status (0.15.0):** the policy is read and checked, and `doctor` reports it.
> Nothing is enforced yet. `library approve` and enforcement in `resolve`,
> `install` and `update` come next (#71). Projects without a policy are unaffected.

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
