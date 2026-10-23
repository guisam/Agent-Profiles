"""Opt-in compatibility check; validates archived Python without executing it."""

import json
import sys
from pathlib import Path

from harness2.core.tree import is_tree, read_tree, validate
from harness2.substrate.codex import CODEX_SURFACE
from harness2.substrate.opencode import OPENCODE_SURFACE


def check(root: Path) -> None:
    for surface in (CODEX_SURFACE, OPENCODE_SURFACE):
        directory = root / surface.name
        if not is_tree(surface, directory):
            raise ValueError(f"missing {surface.name} harness at {directory}")
        rejected: list[str] = []
        tree = {
            Path(relative).as_posix(): content
            for relative, content in read_tree(surface, directory, rejected=rejected).items()
        }
        if rejected:
            raise ValueError(f"off-surface files: {rejected}")
        census = validate(surface, tree)
        if census["skills"] != 1 or census["scripts"] != 1:
            raise ValueError(f"fixture lost its skill or script: {census}")
        print(surface.name, json.dumps(census, sort_keys=True))


if __name__ == "__main__":
    check(Path(sys.argv[1]))
