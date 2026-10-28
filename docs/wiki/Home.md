# Agent Profiles

Agent Profiles selects additional instructions by model and role, so an agent receives context relevant to its job. Use this wiki to find the right setup guide, configure skills, and learn how to evaluate a change.

Repository guides are the source of truth. This wiki provides navigation and maintained copies of workflow guides. Links to `main` follow committed source; the versioning page distinguishes unpublished working-source additions.

## Start here

New to Agent Profiles? Start with [agent-assisted setup](https://github.com/guisam/Agent-Profiles/blob/main/docs/setup.md). It explains how your coding agent can inspect a project, propose a configuration, and apply changes after your approval.

For manual setup, follow the [quick start](https://github.com/guisam/Agent-Profiles/blob/main/README.md#quick-start). The project requires Node 24 and is not yet published to npm; use the preparation instructions in the guide.

Your first goal is a working configuration for one model and one role. Inspect the resulting context before expanding to more roles or models.

## Configure your agent

- [Create roles and select skills](https://github.com/guisam/Agent-Profiles/blob/main/docs/configure.md): choose which skills a role requires and which it makes available.
- [Understand the instruction layers](https://github.com/guisam/Agent-Profiles/blob/main/README.md#the-layers): see how model profiles, roles, and skills fit together.
- [Discover external skills](https://github.com/guisam/Agent-Profiles/blob/main/docs/hosts/external-skill-sources.md): review native skill sources and their host requirements.
- [Check the selected context](https://github.com/guisam/Agent-Profiles/blob/main/docs/proof.md): inspect what Agent Profiles supplies and understand the measurement boundary.

## Evaluate and improve

For a guided role or basic/premium service decision, start with
[Qualify an agent](https://github.com/guisam/Agent-Profiles/wiki/Agent-qualification).
Its starting prompt helps you set requirements, use the existing evaluation
tools, retain a qualification report and choose adoption explicitly. The
[report template](https://github.com/guisam/Agent-Profiles/wiki/Agent-qualification-report-template)
and [worked pilot report](https://github.com/guisam/Agent-Profiles/wiki/Agent-qualification-pilot)
show how incomplete evidence stays unqualified. This is an assistant-assisted
workflow; it does not provide a queue, billing or automatic certification.

Start with [Set up Agent Profiles with Harness²](https://github.com/guisam/Agent-Profiles/blob/main/docs/harness2.md). Its starter captures, verifies, and exports a small harness without model credentials.

When you have a skill change to evaluate, use the [skill migration guide](https://github.com/guisam/Agent-Profiles/blob/main/docs/skill-migrations.md) for proposals, candidates, retained baseline/candidate comparisons, and explicit promotion. The [Harness² adapter reference](https://github.com/guisam/Agent-Profiles/blob/main/docs/hosts/harness2.md) covers mappings and evidence requirements.

Use the [assistant-assisted guided workflow](https://github.com/guisam/Agent-Profiles/wiki/Guided-skill-evaluation) for one copyable prompt covering evaluate → improve → compare → adopt, restoration, and a second model. The guide coordinates existing tools; two-model live qualification remains in progress under [issue #33](https://github.com/guisam/Agent-Profiles/issues/33). The [Windows JobBench pilot](https://github.com/guisam/Agent-Profiles/wiki/Windows-JobBench-pilot) completed baseline task execution for Luna and Strata, with content problems identified in both. Formal judging and skill-improvement qualification remain pending. A completed baseline alone does not establish that a skill improves a model's performance.

The first [Strata verification-skill trial](https://github.com/guisam/Agent-Profiles/wiki/Windows-JobBench-pilot#strata-verification-step-experiment) did not qualify for adoption: the fresh control completed four documents, while the candidate timed out with two partial documents and retained unsupported examples. Keep that candidate unadopted.

A later [twenty-minute follow-up](https://github.com/guisam/Agent-Profiles/wiki/Windows-JobBench-pilot#twenty-minute-follow-up) finished in about 11 minutes 31 seconds with all four documents. It still contained confirmed content defects, so completion alone did not qualify the skill for adoption.

The [Luna/Sol comparison](https://github.com/guisam/Agent-Profiles/wiki/Luna-Sol-qualification)
completed twelve repeated documentation trials and retained a native Luna report.
The candidate did not demonstrate improvement. The report also explains rubric
conflicts and CSV defects that prevent an adoption decision from raw scores.

## Use and share profiles

Use the [saved profile examples and run evidence](https://github.com/guisam/Agent-Profiles/wiki/Saved-profile-evidence)
to inspect model/role YAML, distinct skill assignments, per-run instruction copies
and restoration notes. Experiments are stopped; configuration persistence and
selection do not establish equivalent quality across models.

- [Share a configuration with presets](https://github.com/guisam/Agent-Profiles/blob/main/docs/presets.md).
- [Pin packages and reconstruct managed snapshots](https://github.com/guisam/Agent-Profiles/blob/main/docs/versioned-packages.md).
- Read the host-specific guidance for [Claude Code](https://github.com/guisam/Agent-Profiles/blob/main/docs/hosts/claude-code.md), [Codex bootstrap](https://github.com/guisam/Agent-Profiles/blob/main/docs/bootstrap.md), [OpenCode](https://github.com/guisam/Agent-Profiles/blob/main/docs/hosts/opencode.md), or [Hermes Agent](https://github.com/guisam/Agent-Profiles/blob/main/docs/hosts/hermes.md).

Check the selected host's requirements before reusing a configuration. A model or role change can select different instructions; it does not guarantee equivalent behavior or tools across agent apps.

## Troubleshoot

- **Setup or configuration fails:** start with the [installer's diagnostic and recovery guidance](https://github.com/guisam/Agent-Profiles/blob/main/docs/installer.md).
- **The agent receives unexpected instructions:** inspect the [bootstrap lifecycle](https://github.com/guisam/Agent-Profiles/blob/main/docs/bootstrap.md) and [selected-context proof](https://github.com/guisam/Agent-Profiles/blob/main/docs/proof.md).
- **A skill is missing or unavailable:** check [skill selection](https://github.com/guisam/Agent-Profiles/blob/main/docs/configure.md) and the relevant host guide above.
- **Harness² setup fails:** use [the setup guide's troubleshooting section](https://github.com/guisam/Agent-Profiles/blob/main/docs/harness2.md#if-setup-fails).

## Technical reference

- [Architecture](https://github.com/guisam/Agent-Profiles/blob/main/docs/architecture.md): how the project fits together.
- [Bootstrap protocol](https://github.com/guisam/Agent-Profiles/blob/main/docs/bootstrap.md): identity, roles, lifecycle, and context resolution.
- [Package and snapshot formats](https://github.com/guisam/Agent-Profiles/blob/main/docs/versioned-packages.md): selection, identity, and trust limits.
- [Repository documentation index](https://github.com/guisam/Agent-Profiles/blob/main/README.md#further-reading): additional guides and references.
