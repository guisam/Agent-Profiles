import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { safePath } from './files.js';
import { integrations } from './integrations.js';
import { identifier, localFile, skillMetadata } from './resolve.js';

// These sources share one local layout; another layout can supply its own enumerate function.
function directorySkills(root, directory, host) {
  const target = safePath(root, directory);
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => ({ id: entry.name, path: `${directory}/${entry.name}/SKILL.md`, ...(host && { host, hostId: entry.name, scope: 'project' }) }))
    .filter(skill => existsSync(path.join(root, skill.path)));
}

// Claude skills stay host-native: selecting one references it for invocation, never as injected text.
export const skillSources = [
  { id: 'agent-profiles', enumerate: root => directorySkills(root, '.agent-profiles/skills') },
  { id: 'claude', enumerate: root => directorySkills(root, '.claude/skills', 'claude') },
];

export function discoverSkills(root, configuration) {
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
      // Host skills follow host metadata rules: name falls back to the directory and description is optional.
      skills.push({ ...skill, ...skillMetadata(location, skill.id, undefined, skill.path, !skill.host), source });
    } catch (error) { warnings.push(error.message); }
  };
  for (const [id, value] of configuration.get('skills') ?? []) {
    if (!value.has('host')) { add({ id, path: value.get('file') }, 'configured'); continue; }
    const hostId = value.get('id') ?? id;
    if (value.get('scope') !== 'project') continue; // User and plugin skills are not in the repository.
    const file = integrations.find(adapter => adapter.id === value.get('host'))?.skills?.project.path(hostId);
    if (file && existsSync(path.join(root, file))) add({ id, path: file, host: value.get('host'), hostId, scope: 'project' }, 'configured');
  }
  for (const source of skillSources) {
    try {
      for (const skill of source.enumerate(root)) add(skill, source.id);
    } catch (error) { warnings.push(`${source.id}: ${error.message}`); }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  const duplicates = [...new Set(skills.map(skill => skill.id))]
    .filter(id => skills.filter(skill => skill.id === id).length > 1);
  return { skills, warnings, duplicates };
}
