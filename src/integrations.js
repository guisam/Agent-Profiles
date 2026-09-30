export const START = '<!-- agent-profiles:start -->';
export const END = '<!-- agent-profiles:end -->';
// --no refuses to download: an unpublished or squatted npm name must never run from a bootstrap.
export const resolveCommand = 'npx --no agent-profiles resolve';

// Agent-specific path and precedence choices stay here; file editing is shared.
// capabilities record observed host behavior (docs/host-observations.md), not guarantees.
export const integrations = [
  {
    id: 'claude', name: 'Claude Code', hint: '.claude',
    files: ['CLAUDE.md', '.claude/CLAUDE.md'],
    select: records => records.find(record => record.span)?.file ??
      records.find(record => record.before !== null)?.file ?? 'CLAUDE.md',
    // Project-local skills live in the repository; plugin skills (plugin:skill) are host-provided only.
    skills: { id: /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)?$/, path: id => id.includes(':') ? null : `.claude/skills/${id}/SKILL.md` },
    capabilities: {
      mode: 'bootstrap', verified: 'Claude Code 2.1.283',
      identity: 'exact model ID stated to the model; hooks cannot see it',
      compaction: 'bootstrap re-injected; recently read files re-attached verbatim',
      modelChange: 'model must run resolve again; earlier profile text stays in context',
      roleChange: 'clean only in a new session or custom agent',
      subagents: 'custom agents receive the bootstrap; built-in Explore does not',
      hostSkills: 'every host skill stays visible regardless of role',
    },
  },
  {
    id: 'codex', name: 'OpenAI Codex', hint: '.codex',
    files: ['AGENTS.override.md', 'AGENTS.md'],
    select: records => records.find(record => record.before?.length)?.file ?? 'AGENTS.md',
    capabilities: { mode: 'bootstrap', verified: 'not yet observed', identity: 'unverified' },
  },
];

export function managedSpan(content, file) {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start === -1 && end === -1) return null;
  if (start === -1 || end < start || content.indexOf(START, start + START.length) !== -1 ||
      content.indexOf(END, end + END.length) !== -1) {
    throw new Error(`${file}: malformed or duplicate Agent Profiles markers; repair them before retrying`);
  }
  return { start, end: end + Buffer.byteLength(END) };
}

export function bootstrapBlock(newline = '\n') {
  // All added whitespace is inside the markers, so removal preserves every other byte.
  return Buffer.from([
    START, '', '## Agent Profiles', '',
    'At the start of every new or compacted context, and after a model change,',
    'run this exact command (no `cd` or other prefix) and follow its output:', '',
    `    ${resolveCommand} --model "<exact model ID>"`, '',
    'Use the exact model ID your host states for you (for example, "The exact',
    'model ID is ..."): not a display name, another model\'s ID, or your own',
    'recollection. If the host states none, omit `--model`. Add `--role <id>` only',
    'when the user or your agent definition assigns a role. If the command fails,',
    'report its error; do not read `.agent-profiles/` to route by hand.', '', END,
  ].join(newline));
}
