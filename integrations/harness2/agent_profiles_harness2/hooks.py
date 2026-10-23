"""Public Harness2 seams, with a post-task pass for adoptions Library never receives."""

from __future__ import annotations

from pathlib import Path

from harness2.core import context, runmark, schedule
from harness2.core.library import Library, has_experience

from .bridge import digest, encoded, read_file, read_tree


class CapturingLibrary(Library):
    def __init__(self, *args, profiles, **kwargs):
        super().__init__(*args, **kwargs)
        self.profiles = profiles

    def add(self, task_id, harness, *, why="", label="", run_id="", experience=None):
        context.assert_tree_has_no_grader_verdicts(harness)
        result = super().add(task_id, harness, why=why, label=label, run_id=run_id, experience=experience)
        evidence = {"library-call.json": encoded({"why": why, "experience": experience, "libraryWrote": result is not None})}
        if result is not None:
            evidence["EXPERIENCE.md"] = read_file(result / "EXPERIENCE.md")
        self.profiles.capture(harness, surface=self.surface.name, run_id=run_id, task_id=task_id, label=label, evidence=evidence)
        return result


def seeded_adapter(adapter_type):
    """Return a subclass without changing Harness2 or patching global classes."""
    class SeededAdapter(adapter_type):
        def __init__(self, *args, profiles, seed_stamp, seed_project, **kwargs):
            self.profiles, self.seed_stamp = profiles, seed_stamp
            self._profile_seed = None
            super().__init__(*args, **kwargs)
            self._profile_seed = profiles.seed(seed_stamp, surface=self.substrate.surface().name, project=Path(seed_project))
            self._profile_seed_digest = digest(read_tree(self._profile_seed, self.substrate.surface()))

        def base_harness(self):
            # DemoAdapter writes its own base during __init__; redirect only after it finishes.
            return self._profile_seed if self._profile_seed is not None else super().base_harness()

        def _profiles_identity(self, harness_dir):
            directory = Path(harness_dir) if harness_dir is not None else self.base_harness()
            tree_digest = digest(read_tree(directory, self.substrate.surface()))
            stamp = self.seed_stamp if directory.resolve() == self._profile_seed.resolve() and tree_digest == self._profile_seed_digest else None
            return {"treeDigest": tree_digest, "fingerprint": runmark.fingerprint(directory), "stampDigest": stamp}

        def execute(self, task_id, harness_dir, run_id, **kwargs):
            # Native adapters can interpret None as their built-in baseline, bypassing base_harness().
            harness_dir = self.base_harness() if harness_dir is None else Path(harness_dir)
            identity = self._profiles_identity(harness_dir)
            self.profiles.reserve_rollout(run_id=run_id, task_id=task_id, identity=identity)
            result = super().execute(task_id, harness_dir, run_id, **kwargs)
            self.profiles.record_rollout(run_id=run_id, task_id=task_id, identity=identity)
            return result

    if callable(getattr(adapter_type, "execute_many", None)):
        def execute_many(self, task_id, harness_dir, run_ids, **kwargs):
            harness_dir = self.base_harness() if harness_dir is None else Path(harness_dir)
            identity = self._profiles_identity(harness_dir)
            run_ids = list(run_ids)
            for run_id in run_ids:
                self.profiles.reserve_rollout(run_id=run_id, task_id=task_id, identity=identity)
            results = list(super(SeededAdapter, self).execute_many(task_id, harness_dir, run_ids, **kwargs))
            for run_id, result in zip(run_ids, results):
                if Path(result).is_dir():
                    self.profiles.record_rollout(run_id=run_id, task_id=task_id, identity=identity)
            return results
        SeededAdapter.execute_many = execute_many
    return SeededAdapter


def run_task(task_id, k, *, profiles, adapter, prop, runs_root, library_root, modes=("agg", "seq"), seed=None, tag="", **kwargs):
    """Run upstream scheduling explicitly, then capture every successful selection."""
    if not isinstance(task_id, str) or not task_id or "\\" in task_id or any(part in ("", ".", "..") for part in task_id.split("/")):
        raise ValueError("unsafe task identifier")
    surface = adapter.substrate.surface()
    domain = adapter.domain_of(task_id)
    libraries = {mode: Library(root=Path(library_root) / mode, domain=domain, surface=surface) for mode in modes}
    result = schedule.run_task(task_id, k, adapter=adapter, prop=prop, runs_root=Path(runs_root), libraries=libraries, modes=modes, seed=seed, tag=tag, **kwargs)
    for mode, selection in result.selections.items():
        if mode not in modes or not selection.get("ok"):
            continue
        namespace = schedule.Namespace(adapter.spec.name, adapter.substrate.name, mode, k, seed, tag)
        work = namespace.task_dir(Path(runs_root), task_id)
        label = selection["chosen_label"]
        if not isinstance(label, str) or not label or Path(label).name != label or label in (".", "..") or "\\" in label or "/" in label:
            raise ValueError("unsafe selected harness label")
        harness = work / "harnesses" / label
        evidence = {"selection.json": encoded(selection)}
        for file in work.rglob("*"):
            if not file.is_file():
                continue
            relative = file.relative_to(work).as_posix()
            if (relative.startswith(("reflection/", "context/")) and file.name in ("adoption.json", "edits.md")) or ("decisions" in file.relative_to(work).parts and file.suffix == ".md"):
                evidence[relative] = read_file(file)
        if has_experience(selection.get("experience")):
            experience_file = libraries[mode].entry_dir(task_id) / "EXPERIENCE.md"
            if experience_file.is_file():
                evidence["EXPERIENCE.md"] = read_file(experience_file)
        profiles.capture(harness, surface=surface.name, run_id=selection["chosen_run_id"], task_id=task_id, label=label, evidence=evidence)
    return result
