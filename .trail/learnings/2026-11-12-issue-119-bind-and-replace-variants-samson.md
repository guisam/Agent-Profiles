---
title: "Issue 119 bind and replace: variants via update, bind with revision"
author: Samson
date: 2026-11-12
branch: feat/119-bind-and-replace
touches:
  - CHANGELOG.md
  - docs/visualize.md
  - docs/wiki/Live-visualizer.md
  - docs/wiki/Versioning-and-upgrades.md
  - package-lock.json
  - package.json
  - src/config-edit.ts
  - src/skill-catalog.ts
  - src/visualizer/app.js
  - test/skill-variants.test.js
---

## Decided
- The user's real config (agent-profiles-config, v3) selects TDD variants with `assignments` rules on ONE binding (`skills.sp-tdd`), keyed by host × model × role. So "replace a variant" in the visualizer = update's cross-package move (#89): `preview-replace` returns previewUpdate's plan; `apply-replace` calls applyUpdate with `expect: previewDigest`, then refreshes the adapter lock too (update leaves it stale after a project-layer edit).
- Variant identity is the SKILL.md frontmatter `name` only (nameSource "frontmatter"); the directory fallback means nothing inside a package. The catalog exposes skillName, sameName (configured skill IDs whose default or rule packages share the name), roles (per-role ID lists) and packageSkills.
- `bind-skill` writes `skills.<id>` in the role's layer (adapter role → adapter). The ID is the SKILL.md name, numbered when taken (brainstorming-2), else the package name without namespace. v3 requires a release revision. It calls refuseUntrusted(trustBlockers()) first, and `replace` removes a same-layer same-name entry in the same write.

## Tried and ruled out
- Matching variants from resolution output: resolved entries carry no SKILL.md name, and trust policy can withhold them (this machine withholds "effects: commands" packages), so matching uses config + store instead.
- Inline `node - <<'EOF'` scripts with nested template literals: bash failed to parse them. Write the script to the scratchpad and run it from there.

## Watch out
- Replace needs both Host and Model selected (update needs a full tuple); the page says so instead of guessing.
- Variants already referenced by an assignment rule count as bound (usage.bindings includes `assignments.<rule>.bindings.skills.<id>`).
