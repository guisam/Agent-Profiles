export const START = '<!-- agent-profiles:start -->';
export const END = '<!-- agent-profiles:end -->';

// Agent-specific path and precedence choices stay here; file editing is shared.
export const integrations = [
  {
    id: 'claude', name: 'Claude Code', hint: '.claude',
    files: ['CLAUDE.md', '.claude/CLAUDE.md'],
    select: records => records.find(record => record.span)?.file ??
      records.find(record => record.before !== null)?.file ?? 'CLAUDE.md',
  },
  {
    id: 'codex', name: 'OpenAI Codex', hint: '.codex',
    files: ['AGENTS.override.md', 'AGENTS.md'],
    select: records => records.find(record => record.before?.length)?.file ?? 'AGENTS.md',
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
    'Before beginning work, read `.agent-profiles/agents.yaml` and follow',
    '`.agent-profiles/BOOTSTRAP.md` from the repository root. Keep existing',
    'repository instructions. Resolve one model profile and an independent role;',
    'load only that profile, role, and required skills. Expose available skill',
    'metadata and load their bodies only when needed. Never select a profile',
    'by assessing your own capabilities. Report configuration errors.', '', END,
  ].join(newline));
}
