---
name: ap-status
description: Report the current Agent Profiles role, profile, loaded required skill versions, and optional skills on the bench. Use when asked for Agent Profiles status or which skills are loaded or available in this session.
metadata:
  version: 1.0.0
---

# Agent Profiles status

Provide an on-demand, read-only status report. This skill persists on disk; it does not install a status panel, hook, or background monitor.

## Establish the evidence

Use the latest successful Agent Profiles resolution visible in this conversation, ending with `End of Agent Profiles context:`. It supersedes earlier resolutions. Report its host, model, profile, and role when known. Label the report `Last successful session resolution`; do not imply it reflects subsequent configuration changes.

Read the resolution's required and available sections and any explicit subsequent skill loads visible in this conversation. A description in an available-skills catalog is not evidence that the skill body was loaded. Do not count a remembered load from a superseded resolution as currently active without supporting evidence.

If no complete resolution is available, say that the session's loaded state is unknown. Do not reconstruct it from the current configuration, library's latest version, or a different session's records. A fresh resolution can establish a new baseline, but cannot recover historical loading. Follow the project's Agent Profiles bootstrap instructions if initialization or an explicit refresh is needed, and label the result as newly resolved. Do not select a new role or load optional skills merely to report status.

## Report

Lead with host/model, profile, and role, and any known resolution or stamp identifier. Then show a compact table with columns `State`, `Skill`, `Version / source`, and `Notes`:

- `Required — loaded`: instruction skill bodies included in the successful resolution.
- `Optional — loaded`: optional skill bodies actually loaded with evidence in the current context. Mention how they were loaded if known.
- `Bench — available`: Agent Profiles optional skills listed but not loaded. Include their brief purpose or trigger.
- `Native — loading unverified`: host-native references without evidence that the host supplied their bodies. A required reference is not proof of native invocation.

Use binding IDs and exact selected package names and versions from the resolution. Preserve the content digest in a compact provenance list when supplied; shorten it only with an explicit abbreviation marker. For local skills with no selected package version, show `local / unversioned` and the supplied path. Frontmatter version metadata may be reported as declared metadata, never substituted for a resolved package version. Missing values are `unknown`, not guesses.

Keep the host's general skill catalog separate from Agent Profiles' optional bench. Do not enumerate every installed host skill unless requested. If this status skill was directly read or invoked, acknowledge `ap-status` as a host-loaded reporting skill, not an Agent Profiles required binding.

End with material uncertainty only: configuration may have changed since resolution, history may be incomplete after compaction, or native loading may be unverified. Instruction presence does not prove compliance or execution. Do not imply that a chat slash menu registered the skills.

## Boundaries

Do not edit configuration, pins, packages, session records, or other skills. Do not invoke optional skills to inspect their behavior. For package contents genuinely needed to answer a follow-up, use Agent Profiles verified library reads rather than opening its store directly.
