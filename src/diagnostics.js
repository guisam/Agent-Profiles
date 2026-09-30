import { closeSync, openSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { bootstrapBlock, resolveCommand } from './integrations.js';

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

export function contextDiagnostics(loaded, available, required = [], consumer, surface = null) {
  const loadedSkills = new Set(loaded.filter(entry => entry.kind.endsWith('-skill')).map(entry => entry.id));
  const host = (list, requirement) => list.filter(skill => skill.type === 'host')
    .map(({ id, host, hostId, verification, usable }) => ({ id, host, hostId, requirement, verification, usable, bytes: null, characters: null }));
  return {
    scope: 'resolved-instruction-bodies',
    encoding: 'utf8',
    characterUnit: 'unicode-code-points',
    excluded: ['host-context', 'repository-instructions', 'bootstrap-instructions', 'host-native-skills', 'inventory-rendering', 'output-formatting'],
    managed: {
      profile: total(loaded.filter(entry => entry.kind === 'profile')),
      role: total(loaded.filter(entry => entry.kind === 'role')),
      requiredSkills: total(loaded.filter(entry => entry.kind === 'required-skill')),
      requestedSkills: total(loaded.filter(entry => entry.kind === 'requested-skill')),
      total: total(loaded),
    },
    availableNotLoaded: total(available.filter(entry => entry.type !== 'host' && !loadedSkills.has(entry.id))),
    // Delivered by the host's own skill mechanism; Agent Profiles never injects or measures them.
    hostSkills: [...host(required, 'required'), ...host(available, 'available')],
    // Bootstrap mode adds this managed block to each host instruction surface; native integrations need none.
    // The installed block is measured as stored (CRLF files hold a CRLF block); otherwise the block init would write with LF.
    bootstrap: !consumer ? { scope: 'not-measured', host: null, file: null, installed: false, bytes: null, characters: null }
      : surface ? { scope: 'installed-managed-block', host: consumer, file: surface.file, installed: true, ...measureText(surface.block.toString('utf8')) }
        : { scope: 'expected-managed-block', host: consumer, file: null, installed: false, ...measureText(bootstrapBlock(consumer).toString('utf8')) },
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
  const lines = ['Context proof', '', `Host        ${clean(result.host ?? '(unspecified)')}`, `Model       ${clean(result.model ?? '(unknown)')}`,
    `Canonical   ${clean(result.identity.canonical ?? '(none)')}`, `Source      ${clean(result.identity.source ?? '(unspecified)')}`,
    `Family      ${clean(result.family ?? '(unknown)')}${result.familySource ? ` (${result.familySource})` : ''}`, `Matched by  ${result.matchedBy}`,
    `Profile     ${clean(result.profile)}`, `Role        ${clean(result.role)}`, '', 'Injected by Agent Profiles (instruction bodies)'];
  for (const [kind, label] of [['profile', 'Profile'], ['role', 'Role'], ['required-skill', 'Required skills'], ['requested-skill', 'Requested skills']]) {
    lines.push('', label);
    const entries = result.loaded.filter(entry => entry.kind === kind);
    if (!entries.length) lines.push('  (none)');
    for (const entry of entries) lines.push(`  ${clean(entry.path)}  ${size(entry)}`);
  }
  const loadedIDs = new Set(result.loaded.filter(entry => entry.kind.endsWith('-skill')).map(entry => entry.id));
  lines.push('', `Agent Profiles managed context: ${size(result.diagnostics.managed.total)}`, '', 'Available, not injected');
  const remaining = result.available.filter(entry => entry.type !== 'host' && !loadedIDs.has(entry.id));
  if (!remaining.length) lines.push('  (none)');
  for (const entry of remaining) lines.push(`  ${clean(entry.id)} (${clean(entry.path)})  ${size(entry)}`);
  lines.push(`Available context not injected: ${size(result.diagnostics.availableNotLoaded)}`, '', 'Host-native skills (invoked through the host; bytes not counted)');
  if (!result.diagnostics.hostSkills.length) lines.push('  (none)');
  const usability = entry => entry.usable === null ? '' : entry.usable ? '; usable by this host' : '; not usable by this host';
  for (const entry of result.diagnostics.hostSkills) lines.push(`  ${clean(entry.id)} (${clean(entry.host)}: ${clean(entry.hostId)})  ${entry.requirement}; ${entry.verification}${usability(entry)}`);
  if (result.unsatisfied.length) lines.push('', 'Unsatisfied requirements');
  for (const entry of result.unsatisfied) lines.push(`  ${clean(entry.id)}: ${clean(entry.reason)}`);
  const { bootstrap } = result.diagnostics;
  const block = bootstrap.bytes === null ? 'Bootstrap block: not measured (no --host given)'
    : bootstrap.installed ? `Bootstrap block in ${clean(bootstrap.file)}: ${size(bootstrap)} (bootstrap mode only; not in the managed total)`
      : `Bootstrap block (not installed; as init would write it with LF): ${size(bootstrap)}`;
  lines.push('', block, '',
    'Repository context: AGENTS.md and other project instructions supplied by host; injection host controlled; not measured.',
    'Host context: system instructions, tools, built-in skills, and runtime context unobserved.',
    'Tokens: not calculated (no tokenizer or estimate).',
    'Counts: UTF-8 encoded resolved text; characters are Unicode code points.',
    'Excludes bootstrap, inventory rendering, and output formatting. This is not total agent context or a savings claim.');
  return lines.join('\n');
}

// Agent-facing resolution: everything the model needs, so it never parses agents.yaml itself.
export function formatContext(result) {
  const skill = entry => entry.type === 'host'
    ? `Invoke the ${entry.host} skill \`${entry.hostId}\` through your host's skill mechanism.`
    : `Read \`${entry.path}\`.`;
  const rerun = `${resolveCommand}${result.host ? ` --host ${result.host}` : ''}${result.model ? ` --model "${result.model}"` : ''}${result.roleSource === 'assigned' ? ` --role ${result.role}` : ''}`;
  const lines = ['# Agent Profiles context', '',
    `Profile: ${result.profile} (model ${result.model ?? 'not stated'}; matched by ${result.matchedBy}). Role: ${result.role}.`,
    'These instructions add to the repository instructions and never override them or host permissions.',
    // Observed: Claude Code does not load AGENTS.md, and a soft conditional here was skipped.
    ...result.repository.exists ? ['AGENTS.md holds this repository\'s rules. Read it now unless its full text is already in your context.'] : [],
    'This output supersedes Agent Profiles profile, role, and skill instructions from any earlier run in this context,',
    'including copies your host re-attached after compaction.'];
  const titles = { profile: 'Profile', role: 'Role', 'required-skill': 'Required skill', 'requested-skill': 'Requested skill' };
  if (result.unsatisfied.length) {
    lines.push('', '## Unsatisfied requirements', '', 'This role requires capabilities your host cannot provide. Tell the user before doing role work, and do not substitute another skill:');
    for (const entry of result.unsatisfied) lines.push(`- ${entry.id}: ${entry.reason}.`);
  }
  for (const entry of result.loaded) lines.push('', `## ${titles[entry.kind]}: ${entry.id}`, '', entry.content.trim());
  const requiredHost = result.required.filter(entry => entry.type === 'host' && entry.usable !== false);
  if (requiredHost.length) {
    lines.push('', '## Required host skills', '', 'Use each for all work in this role:');
    for (const entry of requiredHost) lines.push(`- ${entry.id}: ${skill(entry)}`);
  }
  // Skill IDs may equal a profile or role ID, so compare against injected skills only.
  const loadedIDs = new Set(result.loaded.filter(entry => entry.kind.endsWith('-skill')).map(entry => entry.id));
  // Another host's skills are never exposed: this host could not invoke them.
  const available = result.available.filter(entry => !loadedIDs.has(entry.id) && entry.usable !== false);
  if (available.length) {
    lines.push('', '## Available skills', '', 'Use a skill only when the current task falls within its description:');
    for (const entry of available) lines.push(`- ${entry.id}${entry.description ? ` — ${entry.description}` : ''} ${skill(entry)}`);
  }
  lines.push('', '## Run again', '', `Command: \`${rerun}\``,
    '- after context compaction or in a new agent context;',
    '- after a model change, with the new exact model ID;',
    '- to change role, with `--role <id>`; a new session gives a cleaner transition.');
  return lines.join('\n');
}
