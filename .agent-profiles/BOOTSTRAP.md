# Agent Profiles routing

Keep the host's existing repository instructions and permission rules. If root
`AGENTS.md` exists and has not already been supplied, read its repository rules
once. Do not run bootstrap again if its managed block appears in that file.

Read `.agent-profiles/agents.yaml` from the repository root. Use only runtime
metadata or explicit user input for model and family identity; omit unknown
identities. Never assess your own capability to select a profile.

1. Select one profile: exact `models` key, then exact supplied `families` key,
   then `default_profile`. Unknown identities are valid and use the default.
2. Select the explicitly assigned role, or `default_role` when none is assigned.
   Model selection and role selection are independent.
3. Load `profiles/<profile>.md` and the role's `file`, both relative to
   `.agent-profiles/`. Load all the role's required skills in declaration order.
4. For each available skill, expose only its ID, name, description, and path.
   Load its complete instructions only when explicitly needed for the task.
   Do not search for or load skills outside the selected role's lists.

Skill IDs normally resolve to `.agent-profiles/skills/<id>/SKILL.md`. An entry in
the top-level `skills` map may instead provide a `file` relative to the repository
root. Names and descriptions come from YAML frontmatter in the skill itself.
Different files for the same ID are an error; no resource is downloaded.

Report malformed configuration, missing files, unknown explicit roles, duplicate
IDs, or required/available collisions instead of substituting instructions.
Paths must remain local: profile and role files inside `.agent-profiles/`, skill
files inside the repository. Required skills load once; repeated requests do
not duplicate them. When roles change, replace the previous role and skill
context while keeping the model profile unchanged.

`agent-profiles doctor` validates this configuration when the CLI is available.
The configuration and Markdown files remain usable without an installed CLI.
