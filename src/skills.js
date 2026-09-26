import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { safePath } from './files.js';
import { identifier, localFile, skillMetadata } from './resolve.js';

// These sources share one local layout; another layout can supply its own enumerate function.
function directorySkills(root, directory) {
  const target = safePath(root, directory);
  if (!existsSync(target)) return [];
  return readdirSync(target, { withFileTypes: true })
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => ({ id: entry.name, path: `${directory}/${entry.name}/SKILL.md` }))
    .filter(skill => existsSync(path.join(root, skill.path)));
}

export const skillSources = [
  { id: 'agent-profiles', enumerate: root => directorySkills(root, '.agent-profiles/skills') },
  { id: 'claude', enumerate: root => directorySkills(root, '.claude/skills') },
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
      skills.push({ ...skill, ...skillMetadata(location, skill.id), source });
    } catch (error) { warnings.push(error.message); }
  };
  for (const [id, value] of configuration.get('skills') ?? []) add({ id, path: value.get('file') }, 'configured');
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
