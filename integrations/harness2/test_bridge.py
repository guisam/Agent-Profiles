import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from harness2.core import runmark, schedule
from harness2.core.library import Library
from harness2.substrate.codex import CODEX_SURFACE
from harness2.substrate.opencode import OPENCODE_SURFACE

from agent_profiles_harness2 import CapturingLibrary, ProfilesBridge, run_task, seeded_adapter
from agent_profiles_harness2.bridge import digest, encoded

REPO = Path(__file__).resolve().parents[2]
CLI = [shutil.which("node"), str(REPO / "bin/agent-profiles.ts")]
SKILL = b"---\nname: review\ndescription: review changes\n---\nCheck the inputs.\r\n"


def harness(surface="codex"):
    skill_dir = ".agents/skills" if surface == "codex" else "skills"
    files = {
        "AGENTS.md" if surface == "codex" else "systemprompt.md": b"Use review for changes.\r\n",
        f"{skill_dir}/review/SKILL.md": SKILL,
        f"{skill_dir}/review/scripts/helper.py": b"raise RuntimeError('must stay inert')\n",
        "scripts/summarize.py": b"raise RuntimeError('must stay inert')\n",
        "sub_agents/checker/AGENT.md": b"---\ndescription: check work\nmode: subagent\n---\nRead the inputs.\n",
    }
    if surface == "opencode":
        files.update({"guardrails.md": b"Keep sources exact.\r\n", "LongTermMEMORY.md": b"Pinned memory.\n", "tool_descriptions/tool_guidance.md": b"Use the captured helper.\n", "plugin/check.ts": b"export default async () => ({});\n"})
    return files


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ap-harness2-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.profiles = ProfilesBridge(self.root / "capture", cli=CLI, store=self.root / "store", model="fixture-model", role="worker")

    def capture(self, files=None, surface="codex", **claims):
        return self.profiles.capture(files if files is not None else harness(surface), surface=surface, run_id=claims.pop("run_id", "run-1"), task_id=claims.pop("task_id", "task-1"), label=claims.pop("label", "agg1"), **claims)

    def test_both_surfaces_capture_exact_components_without_execution(self):
        for surface in ("codex", "opencode"):
            with self.subTest(surface=surface):
                record = self.capture(surface=surface, evidence={"adoption.json": b'{"chosen_label":"agg1"}\n'})
                self.assertEqual(record["evidenceStatus"], "external-claim")
                self.assertEqual(record["selection"]["host"], "codex" if surface == "codex" else None)
                self.assertEqual(record["treeDigest"], digest(harness(surface)))
                self.assertEqual(set(record["components"]), set(harness(surface)))
                self.assertEqual(base64.b64decode(record["evidence"]["adoption.json"]["data"]), b'{"chosen_label":"agg1"}\n')
                self.assertTrue((Path(record["project"]) / ".agent-profiles/agent-profiles.lock").is_file())
                self.assertTrue(self.profiles.command("verify", record["stampDigest"], project=Path(record["project"]))["managedReproducible"])
                primary = "AGENTS.md" if surface == "codex" else "systemprompt.md"
                self.assertEqual(record["components"][primary]["packagePath"], "PROMPT.md")

    def test_same_bytes_share_packages_and_stamp_under_same_selection(self):
        first = self.capture()
        second = self.capture(run_id="run-2", label="agg2", evidence={"decision.md": b"Different external explanation"})
        self.assertEqual(first["packages"], second["packages"])
        self.assertEqual(first["stampDigest"], second["stampDigest"])
        other = ProfilesBridge(self.root / "other-capture", cli=CLI, store=self.root / "other-store", model="fixture-model", role="worker")
        third = other.capture(harness(), surface="codex", run_id="run-3", task_id="task-1", label="agg1")
        self.assertEqual(first["packages"], third["packages"])
        self.assertEqual(first["stampDigest"], third["stampDigest"])
        index = json.loads((self.profiles.root / "index.json").read_bytes())
        self.assertEqual(len(index["adoptions"]), 2)

    def test_changed_skill_has_a_new_version_and_diff_names_its_captured_path(self):
        first = self.capture()
        changed = harness()
        changed[".agents/skills/review/SKILL.md"] = SKILL.replace(b"inputs", b"outputs")
        second = self.capture(changed, run_id="run-2")
        self.assertNotEqual(first["packages"]["skill-review"]["version"], second["packages"]["skill-review"]["version"])
        self.assertEqual(first["packages"]["profile"], second["packages"]["profile"])
        diff = self.profiles.diff(first, second)
        self.assertTrue(diff["complete"])
        self.assertEqual(diff["capturedComponentChanges"], [".agents/skills/review/SKILL.md"])

    def test_memory_change_versions_the_profile_dependency_closure(self):
        first = self.capture(surface="opencode")
        changed = harness("opencode")
        changed["LongTermMEMORY.md"] = b"Different pinned memory.\n"
        second = self.capture(changed, surface="opencode", run_id="run-2")
        self.assertNotEqual(first["stampDigest"], second["stampDigest"])
        self.assertNotEqual(first["packages"]["profile"]["version"], second["packages"]["profile"]["version"])
        self.assertEqual(first["packages"]["skill-review"], second["packages"]["skill-review"])

    def test_invalid_paths_metadata_and_busy_capture_do_not_publish(self):
        for name in ("../escape", "/absolute", "skills/review/../../escape", "scripts/con.py"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.capture({**harness(), name: b"invalid"})
        with self.assertRaisesRegex(ValueError, "case collision"):
            self.capture({**harness(), ".agents/skills/review/scripts/HELPER.py": b"print('different')"})
        invalid = harness()
        invalid[".agents/skills/review/SKILL.md"] = b"No metadata"
        with self.assertRaises(ValueError):
            self.capture(invalid)
        with self.assertRaisesRegex(ValueError, "orphan"):
            self.capture({**harness(), ".agents/skills/orphan/scripts/helper.py": b"print('inert')"})
        (self.profiles.root / ".capture-lock").mkdir()
        with self.assertRaisesRegex(RuntimeError, "capture busy"):
            self.capture()
        self.assertTrue((self.profiles.root / ".capture-lock").is_dir())
        self.assertFalse((self.profiles.root / "index.json").exists())

    def test_failed_cli_does_not_publish_an_adoption(self):
        with patch.object(self.profiles, "command", side_effect=RuntimeError("refused")):
            with self.assertRaisesRegex(RuntimeError, "refused"):
                self.capture()
        self.assertFalse((self.profiles.root / "index.json").exists())
        self.assertFalse((self.profiles.root / ".capture-lock").exists())

    def test_library_captures_adoption_without_experience(self):
        library = CapturingLibrary(root=self.root / "library", domain="fixture", surface=CODEX_SURFACE, profiles=self.profiles)
        self.assertIsNone(library.add("task-1", {name: content.decode() for name, content in harness().items()}, label="agg1", run_id="run-1", experience={}))
        index = json.loads((self.profiles.root / "index.json").read_bytes())
        self.assertEqual(len(index["adoptions"]), 1)
        self.assertFalse(library.entry_dir("task-1").exists())

    def test_post_task_pass_captures_selection_scheduler_never_sends_to_library(self):
        surface = OPENCODE_SURFACE
        adapter = SimpleNamespace(spec=SimpleNamespace(name="fixture"), substrate=SimpleNamespace(name="oc", surface=lambda: surface), domain_of=lambda _: "fixture")
        runs_root = self.root / "runs"
        namespace = schedule.Namespace("fixture", "oc", "agg", 2)
        work = namespace.task_dir(runs_root, "task-1")
        selected = work / "harnesses/agg1"
        for name, content in harness("opencode").items():
            file = selected / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        (selected / "scripts/README.md").write_text("Upstream helper stub", encoding="utf-8")
        evidence = work / "reflection/agg2/adoption.json"
        evidence.parent.mkdir(parents=True)
        evidence.write_bytes(b'{"chosen_label":"agg1"}\n')
        result = SimpleNamespace(selections={"agg": {"ok": True, "chosen_label": "agg1", "chosen_run_id": "run-1", "experience": {}}})
        with patch.object(schedule, "run_task", return_value=result):
            self.assertIs(run_task("task-1", 2, profiles=self.profiles, adapter=adapter, prop=None, runs_root=runs_root, library_root=self.root / "library", modes=("agg",)), result)
        record_path = next((self.profiles.root / "adoptions").glob("*.json"))
        record = json.loads(record_path.read_bytes())
        self.assertEqual(record["fingerprint"], runmark.fingerprint(selected))
        self.assertEqual(base64.b64decode(record["evidence"]["reflection/agg2/adoption.json"]["data"]), evidence.read_bytes())

    def test_concurrent_capture_keeps_both_index_entries(self):
        with ThreadPoolExecutor(max_workers=2) as workers:
            records = list(workers.map(lambda run: self.capture(run_id=run), ("run-a", "run-b")))
        self.assertEqual(records[0]["stampDigest"], records[1]["stampDigest"])
        self.assertEqual(len(json.loads((self.profiles.root / "index.json").read_bytes())["adoptions"]), 2)

    def test_seeded_subclass_preserves_initialization_and_native_batches(self):
        seed = self.capture()

        class Adapter:
            def __init__(self, root):
                self.root = Path(root)
                self.substrate = SimpleNamespace(surface=lambda: CODEX_SURFACE)
                self.base_harness().mkdir(parents=True)
                (self.base_harness() / "AGENTS.md").write_text("Adapter bootstrap", encoding="utf-8")
                self.batch_calls = 0

            def base_harness(self):
                return self.root / "base"

            def execute(self, task, harness_dir, run_id):
                result = self.root / "executions" / run_id
                result.mkdir(parents=True)
                if run_id == "mutates-input":
                    (self.base_harness() / "AGENTS.md").write_text("Changed during execution", encoding="utf-8")
                return result

            def execute_many(self, task, harness_dir, run_ids):
                self.batch_calls += 1
                return [self.execute(task, harness_dir, run_id) for run_id in run_ids]

        adapter = seeded_adapter(Adapter)(self.root / "adapter", profiles=self.profiles, seed_stamp=seed["stampDigest"], seed_project=seed["project"])
        self.assertEqual((adapter.root / "base/AGENTS.md").read_text(), "Adapter bootstrap")
        self.assertNotEqual(adapter.base_harness(), adapter.root / "base")
        adapter.execute_many("task-1", None, ["base1", "base2"])
        self.assertEqual(adapter.batch_calls, 1)
        records = [json.loads(file.read_bytes()) for file in (self.profiles.root / "rollouts").glob("*.json")]
        self.assertEqual(len(records), 2)
        self.assertTrue(all(record["stampDigest"] == seed["stampDigest"] and record["fingerprint"] == runmark.fingerprint(adapter.base_harness()) for record in records))
        adapter.execute("task-1", None, "mutates-input")
        adapter.execute("task-1", None, "after-mutation")
        records = {json.loads(file.read_bytes())["runId"]: json.loads(file.read_bytes()) for file in (self.profiles.root / "rollouts").glob("*.json")}
        self.assertEqual(records["mutates-input"]["stampDigest"], seed["stampDigest"])
        self.assertIsNone(records["after-mutation"]["stampDigest"])
        self.assertNotEqual(records["mutates-input"]["treeDigest"], records["after-mutation"]["treeDigest"])

    @unittest.skipIf(os.name == "nt", "unchanged upstream schedule requires POSIX fcntl; run in Ubuntu or the opt-in job")
    def test_offline_demo_seeds_captures_every_adoption_and_repeats_identities(self):
        from harness2.demo import DemoAdapter, DemoProposer

        bootstrap = DemoAdapter(self.root / "bootstrap")
        base = self.capture(bootstrap.base_harness(), surface="opencode", run_id="bootstrap", label="base")
        snapshots = []
        for run in ("first", "repeat"):
            adapter = seeded_adapter(DemoAdapter)(self.root / run, profiles=self.profiles, seed_stamp=base["stampDigest"], seed_project=base["project"])
            proposer = DemoProposer(adapter.spec.channels["proposer"])
            library_root = self.root / run / "library"
            rows = []
            for i, task_id in enumerate(adapter.tasks()):
                for mode in ("agg", "seq"):
                    Library(root=library_root / mode, domain="accounting", surface=OPENCODE_SURFACE).retain(adapter.tasks()[:i])
                result = run_task(task_id, 2, profiles=self.profiles, adapter=adapter, prop=proposer, runs_root=adapter.spec.runs_root, library_root=library_root, tag=run)
                self.assertEqual(result.status, "ok", result.errors)
                for selection in result.selections.values():
                    rows.append((task_id, selection["chosen_run_id"]))
            index = json.loads((self.profiles.root / "index.json").read_bytes())
            selected = [row for row in index["adoptions"] if (row["taskId"], row["runId"]) in rows]
            self.assertEqual(len(selected), 4)
            self.assertTrue(all(row["selection"]["host"] is None for row in selected))
            snapshots.append(sorted((row["taskId"], row["treeDigest"], row["stampDigest"], encoded(row["packages"])) for row in selected))
        self.assertEqual(snapshots[0], snapshots[1])


if __name__ == "__main__":
    unittest.main()
