# Changelog

## 0.1.0 — Unreleased

- Deterministic exact-model, family, and fallback profile resolution, independent
  of role selection; local YAML configuration with validated references.
- Required skill loading and available skill metadata with on-demand loading,
  including explicit repository-local source mappings.
- Claude Code and Codex bootstrap integrations with preserved instruction files,
  idempotent initialization, validation, and managed-block removal.
- Interactive role creation, editing, and deletion with paginated, filterable
  skill selection, explicit duplicate-source aliases, and preview before save.
- Minimal profiles, roles, skills, portable bootstrap, and contributor guides.
- Guarded file writes with stale-edit detection and rollback on reported failures.
- Package-artifact workflow checks and CI for Windows, macOS, and Linux on
  Node.js 22 and 24; development type and lint checks without a build step.

No remote instruction fetching, telemetry, model execution, or orchestration.
