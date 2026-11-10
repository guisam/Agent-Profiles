# Separate your skill workshop from your codebase

Keep the skills you write and tune in their own Git repository, a *workshop*.
Your product repository then only pins the versions it uses. Teammates get the
same skills by cloning the workshop and verifying the exact bytes your project's
lock names. The project adapter section needs 0.20.0 (0.21.0 to `update` its pins); everything else works with 0.19.10.

## Three places, three owners

| Place | Holds | Shared how |
| --- | --- | --- |
| **Workshop repository** (its own Git repo, private if you like) | Package sources: one folder per skill or instruction package, each with `package.yaml`. Notes, evals and drafts. | Git: teammates clone it. |
| **Project repository** | `.agent-profiles/agents.yaml` with exact pins, `agent-profiles.lock`, signed `approvals/`, an optional project `trust.yaml` that narrows policy. | Committed with the code. This is the team's policy. |
| **Each machine** | The store (`~/.agent-profiles/store` or `AGENT_PROFILES_STORE`), the machine `trust.yaml`, `allowed_signers` and signing keys. | Never committed. Each person builds their own. |

Don't commit a store, a key or a machine path to either repository.

## Set up the workshop

```text
my-ap-workshop/
  packages/
    review/            package.yaml + SKILL.md
    implementation/    package.yaml + SKILL.md
  evals/               cases and retained results (optional)
  README.md            what each package is for, and who maintains it
```

1. Create the repository: `git init my-ap-workshop`.
2. Write each package with the manifest shown in the
   [versioned packages walkthrough](https://github.com/guisam/Agent-Profiles/blob/main/docs/versioned-packages.md#complete-local-walkthrough).
   Use one namespace for the team, such as `@acme/review`.
3. Treat a published version as frozen. To change a skill, raise `version` in
   `package.yaml`. Republishing changed bytes under the same version is refused
   as `identity-conflict`.
4. Tag each release in Git (`git tag review-1.2.0`), so anyone can check out
   the exact source of a version a project pins.

## Use a workshop package in a project

```sh
agent-profiles library publish ../my-ap-workshop/packages/review   # into your store
agent-profiles library info @acme/review --root .                  # what this project pins
```

Pin the version in `agents.yaml` with the configure wizard or by hand, then run
`install` to write the lock. To move a pin later, use `outdated --root .` and an
`update` preview; the [skill library guide](Skill-library) has the details.
Commit `agents.yaml` and `agent-profiles.lock`. Each project pins on its own, so
moving one project to a new version doesn't move any other.

## Share with your team

A teammate who clones the project gets the pins and the lock, not the package
bytes. To get them:

1. Clone the workshop and check out the tags the lock needs.
2. Run `agent-profiles library publish <package folder>` for each pinned
   version. Identical bytes give the identical digest.
3. Run `agent-profiles install --root . --frozen-lockfile --offline`. It refuses
   if any byte differs from what the lock names, and never rewrites the lock.

If the team uses [signed approvals](https://github.com/guisam/Agent-Profiles/blob/main/docs/trust.md):
- the maintainer runs `library approve` and commits `.agent-profiles/approvals/`;
- each teammate adds the maintainer's public key to their own `allowed_signers`;
- a project `trust.yaml` can require approval and limit namespaces, but it can't
  name keys. Keys come only from each machine's policy.

## Personal choices that aren't team policy

Everything committed under `.agent-profiles/` is team policy. Keep one person's
extra pins and roles in a **project adapter** instead: an ignored
`.agent-profiles/agents.local.yaml` names a separate directory whose additions
compose over the committed configuration. The adapter has its own lock and
approvals. It can add skills, roles and assignments; it can't override project
policy or trust. See [project adapter](https://github.com/guisam/Agent-Profiles/blob/main/docs/project-adapter.md)
for precedence, supported commands and snapshot-backed migration.

- Don't hide local edits with `git update-index --skip-worktree`. It hides them
  from review, not from a commit made from another tool, a pack or a release.
- Don't release from a checkout that carries local adoption. Release from CI
  or from a clean worktree:
  `git worktree add ../my-project-release origin/main`.

## If you develop Agent Profiles itself

Since 0.19.10 the npm package ships only the ten named `.agent-profiles/`
templates, and a test proves that local locks, approvals, permissions, host
settings and extra roles beside them stay out. The package still ships the
committed *contents* of `agents.yaml` and the other templates. Local edits to
those files would ship too, so publish only from CI or a clean checkout.
