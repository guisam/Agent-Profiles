---
title: "Issue 119 part 2: skill library panel in the visualizer UI"
author: Samson
date: 2026-11-12
branch: feat/119-skill-library-ui
touches:
  - CHANGELOG.md
  - docs/visualize.md
  - docs/wiki/Live-visualizer.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/visualizer/app.js
  - src/visualizer/index.html
  - src/visualizer/style.css
  - test/skill-catalog.test.js
---

## Decided
- The library panel (src/visualizer/index.html + app.js) loads `api/skills` only when the user clicks Load skill library. Startup cost and the existing visualizer tests are unaffected.
- Preview reuses the resolution view. It sets the role and requests the skill when the role lists it as available. It previews the current configuration, so it shows the pinned version and cannot swap in another version.
- Role IDs for preview come from api/config (`roles`), not from `select.options`.

## Tried and ruled out
- Reading `role.options` for validation: the fake DOMs used by 5 test files have no `.options`, and the config list is the real source.

## Watch out
- Six test files run app.js in a vm with a hand-made DOM (visualizer-live, package-caller-review-regressions, package-lock-resolution, workflow-review-regressions, local-resources, skill-catalog). Use only append, replaceChildren, add, addEventListener, textContent, value, hidden, disabled and createElement/createTextNode. Setting innerHTML fails those tests.
- Writing test files through a node heredoc mangled "\n" and regex escapes. Edit test files directly.
- The real-browser layout was not checked in a session; only the fake-DOM behavior is tested.
