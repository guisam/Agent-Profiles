# CI/CD Engineering Rules

You must strictly enforce modern GitHub Actions standards. Completely disregard backward compatibility for Node 20 or earlier. 

### Mandatory Invariants:
1. All node environments must explicitly target Node 24.
2. Every GitHub Action step must use modern, non-deprecated releases (e.g., pin actions/checkout and actions/setup-node to `@v4` or higher).
3. If setting up a macOS environment runner, you must target `macos-14` or newer to maintain Node 24 runtime compatibility. Never fall back to older macOS images.

## Task completion and versions

- For each completed repository task, bump the version in `package.json` and keep the root package versions in `package-lock.json` synchronized.
- Use a patch bump (`x.y.z` → `x.y.(z+1)`) for minor revisions, bug fixes, and documentation changes; a minor bump (`x.y.z` → `x.(y+1).0`) for a new feature; and a major bump (`x.y.z` → `(x+1).0.0`) for a backward-incompatible rewrite of the configuration YAML. Apply the highest applicable bump once per task.
- Check version-dependent fixtures, packaging checks, and documentation when bumping. A version edit does not authorize publishing a package, creating a release, or tagging Git.
- The final task-completion step is updating the GitHub wiki with relevant changes and version-upgrade instructions. For incompatible changes, document the old/new configuration formats, migration steps, and required user actions. Report any wiki publication blocker explicitly.
- Beta numbering is pending the maintainer's choice; do not introduce a prerelease convention without that decision.

<!-- trail:start -->
## Trail — repo context graph

This repo is indexed in `.trail/cache/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `trail map` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `trail ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run `trail grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `trail skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `trail callers <symbol>` gives precomputed, exact edges — who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `.trail/cache/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `trail ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with `trail build` (deterministic,
no API key, $0).
<!-- trail:end -->
