import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { safePath } from './files.js';
import { discoveryError } from './discovery-diagnostics.js';
import { integrations } from './integrations.js';
import { identifier, localFile, skillMetadata } from './resolve.js';
import { discoverExternalSkills, externalMetadata, validateExternalSelection } from './external-skills.js';

// Repository instruction files continue to use the original containment rules.
function directorySkills(root, directory, host) {
  const target = safePath(root, directory);
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => ({ id: entry.name, path: `${directory}/${entry.name}/SKILL.md`, ...(host && { host, hostId: entry.name, scope: 'project' }) }))
    .filter(skill => existsSync(path.join(root, skill.path)));
}

export const skillSources = [
  { id: 'agent-profiles', enumerate: root => directorySkills(root, '.agent-profiles/skills') },
  { id: 'claude', enumerate: root => directorySkills(root, '.claude/skills', 'claude') },
];
const nativeKey = skill => `${skill.host}\0${skill.scope}\0${skill.hostId}`;

// Codex project names are inspected only to detect conflicts with user references.
// This does not add project bindings, copy bodies, or scan arbitrary repository files.
function codexProjectNames(root, warnings, metadataOnly) {
  const names = new Set();
  const visited = new Set();
  let count = 0;
  const walk = (directory, depth = 0) => {
    if (depth > 4 || ++count > 1000) { warnings.push('Codex project conflict scan limit reached; additional names are unobserved'); return; }
    const target = localFileDirectory(directory);
    if (visited.has(target)) return;
    visited.add(target);
    const file = `${directory}/SKILL.md`;
    if (existsSync(path.join(root, file))) {
      try {
        const metadata = externalMetadata(localFile(root, file, file, 'repository'), 'codex');
        names.add(metadata.name);
      } catch (error) { warnings.push(`Codex project conflict scan${metadataOnly ? ` (${file})` : ''}: ${discoveryError(error, metadataOnly)}`); }
      return;
    }
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (!entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink())) {
        try { walk(`${directory}/${entry.name}`, depth + 1); }
        catch (error) { warnings.push(`Codex project conflict scan${metadataOnly ? ` (${directory}/${entry.name})` : ''}: ${discoveryError(error, metadataOnly)}`); }
      }
    }
  };
  const localFileDirectory = directory => {
    const lexical = safePath(root, directory);
    const target = realpathSync(lexical);
    const relative = path.relative(root, target);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error(`${directory} resolves outside repository`);
    return target;
  };
  if (existsSync(path.join(root, '.agents/skills'))) {
    try { walk('.agents/skills'); } catch (error) { warnings.push(`Codex project conflict scan${metadataOnly ? ' (.agents/skills)' : ''}: ${discoveryError(error, metadataOnly)}`); }
  }
  return names;
}

export function discoverSkills(root, configuration, { external = false, sourceOptions = {}, metadataOnly = false } = {}) {
  root = realpathSync(root);
  const skills = [];
  const warnings = [];
  const seen = new Set();
  const add = (skill, source) => {
    try {
      identifier(skill.id, skill.path);
      const location = localFile(root, skill.path, skill.id, 'repository');
      const key = `${skill.id}\0${location}`;
      if (seen.has(key)) return;
      seen.add(key);
      skills.push({ ...skill, ...skillMetadata(location, skill.id, undefined, skill.path, !skill.host),
        ...(skill.host && skill.scope === 'project' && { canonicalPath: location }), source });
    } catch (error) { warnings.push(metadataOnly ? `${source}: ${skill.id} (${skill.path}): ${discoveryError(error, true)}` : error.message); }
  };
  const references = [];
  for (const [id, value] of configuration.get('skills') ?? []) {
    if (!value.has('host')) { add({ id, path: value.get('file') }, 'configured'); continue; }
    const hostId = value.get('id') ?? id;
    if (value.get('scope') !== 'project') {
      references.push({ id, host: value.get('host'), hostId, scope: value.get('scope') });
      continue;
    }
    const file = integrations.find(adapter => adapter.id === value.get('host'))?.skills?.project?.path(hostId);
    if (file && existsSync(path.join(root, file))) add({ id, path: file, host: value.get('host'), hostId, scope: 'project' }, 'configured');
  }
  for (const source of skillSources) {
    try { for (const skill of source.enumerate(root)) add(skill, source.id); }
    catch (error) { warnings.push(`${source.id}: ${discoveryError(error, metadataOnly)}`); }
  }
  const inventory = external ? discoverExternalSkills(sourceOptions, { metadataOnly }) : { skills: [], warnings: [], roots: [] };
  warnings.push(...inventory.warnings);
  for (const skill of inventory.skills) {
    const aliases = references.filter(reference => nativeKey(reference) === nativeKey(skill));
    if (aliases.length) for (const alias of aliases) skills.push({ ...skill, id: alias.id });
    else skills.push(skill);
  }
  for (const reference of references) {
    if (skills.some(skill => skill.id === reference.id && nativeKey(skill) === nativeKey(reference))) continue;
    const availability = external && reference.scope === 'user' ? 'not-found' : 'host-provided-unverified';
    skills.push({ ...reference, type: 'host', source: 'configured', name: reference.hostId, description: null, path: null, availability, runtime: 'unverified', selectable: true });
    if (availability === 'not-found') warnings.push(`${reference.id}: not found in inventoried roots; keep the native reference and check host setup (invocation unverified)`);
  }
  if (external) {
    const personalClaudeNames = new Set(skills.filter(skill => skill.host === 'claude' && skill.scope === 'user' && skill.path).map(skill => skill.hostId));
    for (const skill of skills) {
      if (skill.host === 'claude' && skill.scope === 'project' && personalClaudeNames.has(skill.hostId)) {
        skill.selectable = false; skill.availability = 'shadowed';
        warnings.push(`${skill.id}: Claude personal skill ${skill.hostId} shadows this project skill; the project origin is not independently addressable`);
      }
    }
    const projectNames = codexProjectNames(root, warnings, metadataOnly);
    for (const skill of skills) {
      if (skill.host === 'codex' && skill.scope === 'user' && projectNames.has(skill.hostId)) {
        skill.selectable = false; skill.availability = 'ambiguous';
        warnings.push(`${skill.id}: Codex project/user name conflict for ${skill.hostId}; this portable reference cannot address the exact origin`);
      }
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id) || String(a.path).localeCompare(String(b.path)));
  const duplicates = [...new Set(skills.map(skill => skill.id))].filter(id => skills.filter(skill => skill.id === id).length > 1);
  return { skills, warnings, duplicates, roots: inventory.roots };
}

// A source selected from disk is checked both before preview and immediately before save.
// Opaque native references have no path and remain portable, never installation-verified.
export function validateSkillSelection(root, selection, sourceOptions) {
  if (selection.selectable === false) throw new Error(`${selection.id}: source is not selectable (${selection.availability ?? 'ambiguous'})`);
  if (!selection.host || !selection.path) return;
  if (selection.scope === 'project') {
    // Derive permission from the repository and adapter, never a descriptor's origin.
    const file = integrations.find(adapter => adapter.id === selection.host)?.skills?.project?.path(selection.hostId);
    if (!file || file !== selection.path) throw new Error(`${selection.id}: project source changed; reload the inventory`);
    const canonicalPath = localFile(realpathSync(root), file, selection.id, 'repository');
    const metadata = skillMetadata(canonicalPath, selection.id, undefined, file, false);
    if (canonicalPath !== selection.canonicalPath || ['name', 'nameSource', 'description'].some(key => metadata[key] !== selection[key])) {
      throw new Error(`${selection.id}: project skill changed or repointed; refresh the inventory and select again`);
    }
  }
  if (selection.external || path.isAbsolute(selection.path)) validateExternalSelection(selection, sourceOptions);
  if (selection.external || path.isAbsolute(selection.path) || sourceOptions !== undefined) {
    const found = discoverSkills(root, new Map(), { external: true, sourceOptions });
    const candidate = found.skills.find(skill => nativeKey(skill) === nativeKey(selection) && skill.path === selection.path);
    if (!candidate || candidate.selectable === false) throw new Error(`${selection.id}: external/project source missing, shadowed, or ambiguous; reload the inventory`);
  }
}
