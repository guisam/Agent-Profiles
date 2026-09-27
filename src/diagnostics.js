import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

export function measureText(content) {
  return { bytes: Buffer.byteLength(content, 'utf8'), characters: [...content].length };
}

// Scan unloaded text for exact counts without retaining its body in the result.
export function measureFile(file) {
  const descriptor = openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.alloc(65536);
    let bytes = 0, characters = 0;
    for (;;) {
      const size = readSync(descriptor, buffer, 0, buffer.length, null);
      const text = size ? decoder.write(buffer.subarray(0, size)) : decoder.end();
      const measured = measureText(text);
      bytes += measured.bytes;
      characters += measured.characters;
      if (!size) return { bytes, characters };
    }
  } finally { closeSync(descriptor); }
}

function total(entries) {
  return entries.reduce((sum, entry) => ({
    files: sum.files + 1, bytes: sum.bytes + entry.bytes, characters: sum.characters + entry.characters,
  }), { files: 0, bytes: 0, characters: 0 });
}

export function contextDiagnostics(loaded, available) {
  const loadedSkills = new Set(loaded.filter(entry => entry.kind.endsWith('-skill')).map(entry => entry.id));
  return {
    scope: 'resolved-instruction-bodies',
    encoding: 'utf8',
    characterUnit: 'unicode-code-points',
    excluded: ['host-context', 'repository-instructions', 'bootstrap-instructions', 'inventory-rendering', 'output-formatting'],
    managed: {
      profile: total(loaded.filter(entry => entry.kind === 'profile')),
      role: total(loaded.filter(entry => entry.kind === 'role')),
      requiredSkills: total(loaded.filter(entry => entry.kind === 'required-skill')),
      requestedSkills: total(loaded.filter(entry => entry.kind === 'requested-skill')),
      total: total(loaded),
    },
    availableNotLoaded: total(available.filter(entry => !loadedSkills.has(entry.id))),
    repository: {
      path: 'AGENTS.md', suppliedBy: 'host', status: 'host-supplied', injection: 'host-controlled', bytes: null, characters: null,
      otherInstructions: { status: 'unobserved', suppliedBy: 'host' },
    },
    host: {
      systemInstructions: { status: 'unobserved' },
      tools: { status: 'unobserved' },
      builtInSkills: { status: 'unobserved' },
      otherContext: { status: 'unobserved' },
    },
    tokens: { value: null, kind: 'not-calculated', method: null },
  };
}

export function resolutionOutput(result, contents = false) {
  return { ...result, loaded: contents ? result.loaded : result.loaded.map(({ content, ...entry }) => entry) };
}

export function formatProof(result) {
  const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f]/g, ' ');
  const size = entry => `${entry.bytes} B; ${entry.characters} characters`;
  const lines = ['Context proof', '', `Model       ${clean(result.model ?? '(unknown)')}`,
    `Family      ${clean(result.family ?? '(unknown)')}`, `Matched by  ${result.matchedBy}`,
    `Profile     ${clean(result.profile)}`, `Role        ${clean(result.role)}`, '', 'Loaded by Agent Profiles (instruction bodies)'];
  for (const [kind, label] of [['profile', 'Profile'], ['role', 'Role'], ['required-skill', 'Required skills'], ['requested-skill', 'Requested skills']]) {
    lines.push('', label);
    const entries = result.loaded.filter(entry => entry.kind === kind);
    if (!entries.length) lines.push('  (none)');
    for (const entry of entries) lines.push(`  ${clean(entry.path)}  ${size(entry)}`);
  }
  const loadedIDs = new Set(result.loaded.filter(entry => entry.kind.endsWith('-skill')).map(entry => entry.id));
  lines.push('', `Agent Profiles managed context: ${size(result.diagnostics.managed.total)}`, '', 'Available, not loaded');
  const remaining = result.available.filter(entry => !loadedIDs.has(entry.id));
  if (!remaining.length) lines.push('  (none)');
  for (const entry of remaining) lines.push(`  ${clean(entry.id)} (${clean(entry.path)})  ${size(entry)}`);
  lines.push(`Available context not loaded: ${size(result.diagnostics.availableNotLoaded)}`, '',
    'Repository context: AGENTS.md and other project instructions supplied by host; injection host controlled; not measured.',
    'Host context: system instructions, tools, built-in skills, and runtime context unobserved.',
    'Tokens: not calculated (no tokenizer or estimate).',
    'Counts: UTF-8 encoded resolved text; characters are Unicode code points.',
    'Excludes bootstrap, inventory rendering, and output formatting. This is not total agent context or a savings claim.');
  return lines.join('\n');
}
