"""Native execution and staging remain real; only external launchers are replaced."""

from contextlib import ExitStack, contextmanager
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from harness2.benchmarks import jobbench, lab, workbuddy
from harness2.core import runmark
from harness2.substrate.codex import CodexSubstrate
from harness2.substrate.opencode import OpencodeSubstrate

from agent_profiles_harness2 import ProfilesBridge, seeded_adapter
from test_bridge import CLI


@contextmanager
def workbuddy_runner(root, profiles, stamp, seed, surface="cx"):
    observed = []

    def launch(subset, substrate, label_dir, label, tasks, ws, k, **kwargs):
        prompt = "AGENTS.md" if substrate == "cx" else "systemprompt.md"
        observed.append((Path(ws) / prompt).read_text() if ws is not None else "UPSTREAM_DEFAULT")
        run = label_dir / f"invocation{len(list(label_dir.glob('*'))) + 1}"
        for i in range(k):
            trial = run / f"{tasks[0]}__{i}"
            (trial / "verifier").mkdir(parents=True)
            (trial / "verifier/score.json").write_text('{"reward":1}', encoding="utf-8")
        return [run]

    with ExitStack() as stack:
        stack.enter_context(patch.object(profiles, "seed", return_value=seed))
        stack.enter_context(patch.object(workbuddy, "run_batch", side_effect=launch))
        stack.enter_context(patch.object(workbuddy, "discover", return_value={name: "office" for name in ("fixture", "fix", "retain")}))
        stack.enter_context(patch.object(CodexSubstrate, "preflight"))
        stack.enter_context(patch.object(OpencodeSubstrate, "preflight"))
        adapter = seeded_adapter(workbuddy.WbAdapter)(substrate=surface, profiles=profiles, seed_stamp=stamp, seed_project=root)
        adapter.spec = replace(adapter.spec, runs_root=root / "native-runs")
        yield adapter, observed


@contextmanager
def lab_runner(root, profiles, stamp, seed, surface):
    observed = []
    repository = root / "lab-repo"
    for relative in ("opencode/run_opencode.py", "external/adapt_runs_cx/run_codex_lab.py"):
        runner = repository / relative
        runner.parent.mkdir(parents=True, exist_ok=True)
        runner.touch()
    adapter = None

    def launch(command, **kwargs):
        staged = Path(command[command.index("--harness-dir") + 1]) if "--harness-dir" in command else None
        prompt = "AGENTS.md" if surface == "cx" else "systemprompt.md"
        observed.append((staged / prompt).read_text() if staged else "UPSTREAM_DEFAULT")
        run = adapter._run_dir(command[command.index("--run-id") + 1])
        (run / "output").mkdir(parents=True)
        (run / "output/result.txt").write_text(observed[-1], encoding="utf-8")
        (run / "metrics.json").write_text("{}", encoding="utf-8")

    with ExitStack() as stack:
        stack.enter_context(patch.object(profiles, "seed", return_value=seed))
        stack.enter_context(patch.object(lab.config, "lab_repo", return_value=repository))
        stack.enter_context(patch.object(lab, "run_detached", side_effect=launch))
        adapter = seeded_adapter(lab.LabAdapter)(substrate=surface, profiles=profiles, seed_stamp=stamp, seed_project=root)
        adapter.spec = replace(adapter.spec, runs_root=root / "native-runs")
        adapter._results_root = root / "results"
        yield adapter, observed


@contextmanager
def jobbench_runner(root, profiles, stamp, seed, surface):
    observed = []
    repository = root / "jb-repo"
    inputs = repository / "dataset/main/office/fixture/task_folder"
    inputs.mkdir(parents=True)
    (inputs / "TASK_INSTRUCTIONS.txt").write_text("Fixture task.", encoding="utf-8")
    adapter = None

    def launch(command, *, env, **kwargs):
        rendered = Path(env["HARNESS_RENDER_DIR"])
        observed.append((rendered / "AGENTS.md").read_text())
        out = adapter._out_dir(env["TASK_IDS"], env["LABEL"])
        out.mkdir(parents=True)
        (out / "result.txt").write_text(observed[-1], encoding="utf-8")

    with ExitStack() as stack:
        stack.enter_context(patch.object(profiles, "seed", return_value=seed))
        stack.enter_context(patch.object(jobbench.config, "jb_repo", return_value=repository))
        stack.enter_context(patch.object(jobbench, "run_detached", side_effect=launch))
        stack.enter_context(patch.object(jobbench, "codex_config_error", return_value=None))
        stack.enter_context(patch.object(CodexSubstrate, "preflight"))
        stack.enter_context(patch.object(OpencodeSubstrate, "preflight"))
        adapter = seeded_adapter(jobbench.JobBenchAdapter)(substrate=surface, store_root=root / "dataset", profiles=profiles, seed_stamp=stamp, seed_project=root)
        adapter.spec = replace(adapter.spec, runs_root=root / "native-runs")
        yield adapter, observed


class NativeAdapterTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="ap-native-adapter-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.seed = self.root / "seed"
        self.seed.mkdir()
        (self.seed / "AGENTS.md").write_text("CANDIDATE_MARKER\n", encoding="utf-8")
        (self.seed / "systemprompt.md").write_text("CANDIDATE_MARKER\n", encoding="utf-8")
        self.profiles = ProfilesBridge(self.root / "capture", cli=CLI, store=self.root / "store", model="fixture-model", role="worker")

    def records(self):
        return [json.loads(file.read_bytes()) for file in (self.profiles.root / "rollouts").glob("*.json")]

    def test_workbuddy_launcher_consumes_seed_for_single_and_native_batch(self):
        with workbuddy_runner(self.root, self.profiles, "a" * 64, self.seed) as (adapter, observed):
            prefix = f"{adapter.spec.name}-cx-fixture/fixture/"
            adapter.execute("fixture", None, prefix + "base1")
            self.assertEqual(observed, ["CANDIDATE_MARKER\n"])
            results = adapter.execute_many("fixture", None, [prefix + "base2", prefix + "base3"])
            self.assertEqual(len(results), 2)
            self.assertEqual(observed, ["CANDIDATE_MARKER\n"] * 2)
            records = self.records()
            self.assertEqual(len(records), 3)
            self.assertTrue(all(record["stampDigest"] == "a" * 64 for record in records))
            self.assertTrue(all(record["fingerprint"] == runmark.fingerprint(self.seed) for record in records))

    def test_all_native_launchers_consume_the_seed_and_reuse_only_matching_bytes(self):
        for factory in (workbuddy_runner, lab_runner, jobbench_runner):
            for surface in ("cx", "oc"):
                with self.subTest(adapter=factory.__name__, surface=surface):
                    root = self.root / f"{factory.__name__}-{surface}"
                    with factory(root, self.profiles, "a" * 64, self.seed, surface) as (adapter, observed):
                        task = "office/fixture" if factory is jobbench_runner else "fixture"
                        run_id = f"{adapter.spec.name}-{surface}-fixture/{task}/base1"
                        adapter.execute(task, None, run_id)
                        self.assertEqual(len(observed), 1)
                        self.assertIn("CANDIDATE_MARKER", observed[0])
                        adapter.execute(task, None, run_id)
                        self.assertEqual(len(observed), 1, "matching completion should reuse the real native cache")
                        if factory is workbuddy_runner:
                            ids = [run_id + "batch1", run_id + "batch2"]
                            adapter.execute_many(task, None, ids)
                            self.assertEqual(len(observed), 2, "one native batch launcher call")
                            self.assertIn("CANDIDATE_MARKER", observed[-1])

    def test_changed_seed_cannot_overwrite_an_existing_run_before_identity_refusal(self):
        with workbuddy_runner(self.root, self.profiles, "a" * 64, self.seed) as (adapter, observed):
            run_id = f"{adapter.spec.name}-cx-fixture/fixture/base1"
            original = adapter.execute("fixture", None, run_id)
            marker = runmark.read_mark(original)
            (self.seed / "AGENTS.md").write_text("DIFFERENT_MARKER\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "immutable capture conflict"):
                adapter.execute("fixture", None, run_id)
            self.assertEqual(observed, ["CANDIDATE_MARKER\n"], "identity refusal must precede native launch")
            self.assertEqual(runmark.read_mark(original), marker)

    def test_failed_launch_has_no_completed_attribution_and_same_input_can_retry(self):
        with workbuddy_runner(self.root, self.profiles, "a" * 64, self.seed) as (adapter, observed):
            run_id = f"{adapter.spec.name}-cx-fixture/fixture/base1"
            with patch.object(workbuddy, "run_batch", side_effect=RuntimeError("fixture launch failed")):
                with self.assertRaisesRegex(RuntimeError, "fixture launch failed"):
                    adapter.execute("fixture", None, run_id)
            self.assertEqual(self.records(), [])
            adapter.execute("fixture", None, run_id)
            self.assertEqual(len(observed), 1)
            self.assertEqual(len(self.records()), 1)

    def test_partial_native_batch_attributes_only_returned_rollouts(self):
        with workbuddy_runner(self.root, self.profiles, "a" * 64, self.seed) as (adapter, observed):
            ids = [f"{adapter.spec.name}-cx-fixture/fixture/base{i}" for i in (1, 2)]
            launch = workbuddy.run_batch.side_effect
            def partial(*args, **kwargs):
                return launch(*args[:6], 1, **kwargs)
            with patch.object(workbuddy, "run_batch", side_effect=partial):
                self.assertEqual(len(adapter.execute_many("fixture", None, ids)), 1)
            self.assertEqual(len(observed), 1)
            self.assertEqual([record["runId"] for record in self.records()], ids[:1])

    def test_mutated_seed_and_explicit_candidate_do_not_inherit_seed_stamp(self):
        with workbuddy_runner(self.root, self.profiles, "a" * 64, self.seed) as (adapter, observed):
            prefix = f"{adapter.spec.name}-cx-fixture/fixture/"
            (self.seed / "AGENTS.md").write_text("MUTATED_MARKER\n", encoding="utf-8")
            adapter.execute("fixture", None, prefix + "mutated")
            candidate = self.root / "candidate"
            candidate.mkdir()
            (candidate / "AGENTS.md").write_text("THROWAWAY_MARKER\n", encoding="utf-8")
            adapter.execute("fixture", candidate, prefix + "candidate")
            self.assertEqual(observed, ["MUTATED_MARKER\n", "THROWAWAY_MARKER\n"])
            self.assertTrue(all(record["stampDigest"] is None for record in self.records()))


if __name__ == "__main__":
    unittest.main()
