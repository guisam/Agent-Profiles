# Set up Agent Profiles with Harness²

Start here to get the two projects working together. The first example runs on
Windows, needs no API keys, and creates a small harness you can inspect.

Prefer help from your coding assistant? Copy the [setup prompt](#ask-your-coding-assistant)
below. For file formats and advanced options, use the [technical reference](hosts/harness2.md).

## What this gives you

Harness² finds changes to an agent's instructions. Agent Profiles keeps a
versioned copy of those instructions and records which configuration a run used.
That recorded configuration is called a **stamp**.

This walkthrough will create a starter harness, save it as packages and a stamp,
and export it back into a directory Harness² can use. It does not run a model.

## 1. Point to your checkouts

You need **Node 24**, **Python 3.12 or newer**, and both source checkouts. Agent
Profiles integrations require the source checkout, so these commands run it from source.

Open PowerShell and paste this, changing the first two paths if necessary:

```powershell
$AgentProfiles = 'C:\workspace\Agent-Profiles'
$Harness2 = 'C:\workspace\harness2'
Set-Location $AgentProfiles
$env:PYTHONPATH = "$Harness2;$AgentProfiles\integrations\harness2"
$env:AGENT_PROFILES_ROOT = $AgentProfiles
node --version
py -3 --version
git -C $Harness2 rev-parse HEAD
```

Check that the versions meet the requirements. The tested Harness² revision is
`1cfe254e8d25b15f37048c3730134686abe60335`. If yours differs, use a separate
checkout of that revision for this walkthrough; keep your existing work intact.

## 2. Install the Node dependencies

In the same PowerShell window:

```powershell
npm ci --ignore-scripts
py -3 -B -c "from agent_profiles_harness2 import ProfilesBridge; print('Bridge import OK')"
```

You should see `Bridge import OK`. No Python package installation is needed for
this source-checkout setup: `PYTHONPATH` connects the bridge to both checkouts.

## 3. Run the complete starter example

Paste this entire block into that PowerShell window. It creates a fresh output
directory in your temporary folder each time, so rerunning it keeps earlier
results intact.

```powershell
$env:AP_HARNESS2_OUTPUT = Join-Path $env:TEMP ('agent-profiles-harness2-' + [guid]::NewGuid().ToString('N'))
@'
import json
import os
from pathlib import Path
from agent_profiles_harness2 import ProfilesBridge

repo = Path(os.environ["AGENT_PROFILES_ROOT"])
output = Path(os.environ["AP_HARNESS2_OUTPUT"])
profiles = ProfilesBridge(
    output / "captures",
    cli=["node", str(repo / "bin/agent-profiles.ts")],
    store=output / "store",
    model="example-model",
    role="worker",
)
starter = {
    "AGENTS.md": "Use the review skill when reviewing changes.\n",
    ".agents/skills/review/SKILL.md": (
        "---\nname: review\ndescription: review changes\n---\n"
        "Check the inputs and explain your findings.\n"
    ),
}
adopted = profiles.capture(
    starter, surface="codex",
    run_id="starter-run", task_id="starter-task", label="base",
)
(output / "adopted.json").write_text(json.dumps(adopted, indent=2), encoding="utf-8")
harness = profiles.seed(
    adopted["stampDigest"], surface="codex", project=Path(adopted["project"]),
)
assert (harness / ".agents/skills/review/SKILL.md").read_bytes() == starter[".agents/skills/review/SKILL.md"].encode()
assert profiles.command("verify", adopted["stampDigest"], project=Path(adopted["project"]))["managedReproducible"]
print("Setup OK: captured, verified, and exported the starter harness.")
print("Stamp:", adopted["stampDigest"])
print("Harness directory:", harness)
print("Saved record:", output / "adopted.json")
'@ | py -3 -B -
```

Success starts with **`Setup OK: captured, verified, and exported the starter harness.`**

Open the printed harness directory. It contains `AGENTS.md` and the review skill.
That directory is the input to give Harness². Its parent also contains an Agent
Profiles receipt; the receipt is not part of the harness.

| Saved item | What it is for |
| --- | --- |
| `adopted.json` | The record to load when seeding another run |
| `captures/index.json` | A list of captured harnesses and their stamps |
| `store/` | The retained packages, revisions and configurations |

The temporary directory is useful for trying this out. For real experiments,
choose a durable output directory outside both checkouts and retain the whole
directory with your experiment records.

## 4. Use your own harness

To capture an existing Harness² adoption, replace `starter` in the capture call
with `Path(r"C:\path\to\your\adopted\harness")`. Replace the example model,
task, run ID and label with your actual experiment values. Use `surface="opencode"`
for an OpenCode tree; its layout differs from Codex.

To seed a real experiment, use the bridge's `seeded_adapter` wrapper around your
existing benchmark adapter, then the bridge's `run_task` facade to capture its
successful adoptions. Both are shown in the
[capture and seeding example](hosts/harness2.md#adoption-capture-and-stamp-seeding).
Your benchmark still needs its usual Harness² dataset, executor and credentials.
The starter example does not install those or launch a benchmark.

Set `HARNESS2_RUNS_DIR` to your experiment's output directory **before** importing
Harness² in your driver. Use a new run-ID namespace when the task, harness or
stamp changes. The wrapper supplies the pinned harness to native execution and
preserves native batching; calling an unwrapped adapter with `None` can select its
built-in baseline instead.

## Ask your coding assistant

Paste this into an assistant with access to your local files. Change the paths
and add your benchmark/model choices if you already know them:

```text
Help me set up Agent Profiles with Harness².

My Agent Profiles checkout is C:\workspace\Agent-Profiles.
My Harness² checkout is C:\workspace\harness2.
I use Windows and PowerShell.

Read docs/harness2.md in Agent Profiles first. Use docs/hosts/harness2.md
for technical details and verify APIs against my local Harness² source.

Check Node 24, Python 3.12+, and the supported Harness² commit. Configure
the source CLI and Python import paths. Keep my existing work and the
upstream checkout unchanged; put experiment artifacts outside both repos.

Run the complete credential-free starter example from the guide. Confirm
the captured stamp verifies, the exported review skill has the expected
bytes, and show me the output directory and saved adoption record.

Then help connect my existing Harness² driver using ProfilesBridge,
seeded_adapter and the bridge's run_task facade. Ask which benchmark,
surface and model I want if that information is missing. Preserve native
batching, capture successful adoptions, and use separate output directories
and run-ID namespaces for independent experiments.

Keep this setup step free of model calls. Explain the exact command that
would start a real benchmark and any remaining dataset/credential setup.
Leave promotion as a separate explicit decision.

Finish with what works, what remains to configure, and commands I can reuse.
```

## When you are ready to evaluate a change

For a role or service-tier decision, start with [Qualify an agent](agent-qualification.md).
It provides the requirements intake, report template and worked pilot outcome.

For a single assistant-assisted entry point, use
[Evaluate and improve a role's skill](guided-evaluation.md). Its copyable prompt
coordinates the existing bridge and CLI, prepares internal artifacts for you,
and keeps paid execution and adoption behind explicit decisions.

For Codex or OpenCode, [prepare a migration before searching for a skill change](hosts/harness2.md#convert-adopted-edits-into-proposals-codex).
Use its new base stamp for that search, rather than the original capture stamp.
Review the generated proposals and unsupported-edit report, then explicitly
accept a skill edit and [publish its candidate](skill-migrations.md#publish-one-advisory-task-only-candidate).

Next, [run a fixed base/candidate comparison](hosts/harness2.md#convert-fixed-arm-evaluation-evidence-codex),
retain the plan before running either arm, and import the resulting judgments.
Each arm needs a separate output directory and run-ID namespace. Review the
report before the separate [promotion decision](skill-migrations.md#promote-the-exact-evaluated-tuple).

Only skill-entrypoint edits can become candidates today. Both Codex and OpenCode
captures retain real host assignments for this workflow. See the
[OpenCode setup guide and assistant prompt](hosts/opencode.md) for native host
setup. Harness² uses a separately pinned executor; credential-free checks verify
setup and routing, while live benchmark behavior and judge quality remain
separate validation work.

## If setup fails

| Problem | What to try |
| --- | --- |
| `No module named harness2` or `agent_profiles_harness2` | Repeat step 1 in the same terminal. Check that both paths exist. |
| Node cannot load the CLI | Check `node --version`, the Agent Profiles path, and that step 2 completed. |
| `immutable capture conflict` for a real run | Keep the old record. Use a fresh run namespace if its inputs changed. Exact-input retries are allowed. |
| Old evidence has a literal `base` fingerprint | Collect fresh runs with the current wrapper; do not rewrite those old records. |
| `.capture-lock` remains after an interrupted process | Confirm no writer is active before removing that lock. |

For the full offline search demo, run the opt-in integration suite on Linux/WSL
with Linux Node 24 and Python 3.12+. Its scheduler requires POSIX `fcntl`. This
does not affect the Windows starter example above. See the
[validation instructions](hosts/harness2.md#upstream-validation) and
[technical reference](hosts/harness2.md) for further checks and limits.
