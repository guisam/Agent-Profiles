import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { safePath } from './files.js';

function fail(entry, message) {
  throw new Error(`${entry}: ${message}`);
}

function mapping(value, entry, fields, optional = []) {
  if (!(value instanceof Map)) fail(entry, 'expected a mapping');
  for (const key of value.keys()) {
    if (typeof key !== 'string' || !key.trim()) fail(entry, 'keys must be nonempty strings');
    if (fields && !fields.includes(key) && !optional.includes(key)) fail(`${entry}.${key}`, 'unknown field');
  }
  for (const key of fields ?? []) {
    if (!value.has(key)) fail(`${entry}.${key}`, 'required field is missing');
  }
  return value;
}

export function identifier(value, entry) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    fail(entry, 'expected an ID containing lowercase letters, digits, and hyphens');
  }
  return value;
}

export function localFile(base, file, entry, scope = '.agent-profiles', allowMissing = false) {
  if (typeof file !== 'string' || !file.endsWith('.md') ||
      /[:\\]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..')) {
    fail(entry, `expected a relative Markdown path inside ${scope} (no .., URLs, or backslashes)`);
  }
  try {
    const resolved = realpathSync(path.resolve(base, file));
    const relative = path.relative(base, resolved);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      fail(entry, `${file} resolves outside ${scope}`);
    }
    if (!statSync(resolved).isFile()) fail(entry, `${file} is not a file`);
    return resolved;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return safePath(base, file);
    if (error.code) fail(entry, `cannot access ${file} (${error.code}); restore the file or correct this reference in .agent-profiles/agents.yaml, then run agent-profiles doctor`);
    throw error;
  }
}

function profileFile(base, id, entry) {
  identifier(id, entry);
  const file = `profiles/${id}.md`;
  localFile(base, file, entry);
  return file;
}

export function parseYamlDocument(text) {
  const document = parseDocument(text);
  if (document.errors.length || document.warnings.length) {
    throw new Error([...document.errors, ...document.warnings].map(error => error.message).join('\n'));
  }
  return document;
}

export function parseYaml(text) {
  return parseYamlDocument(text).toJS({ mapAsMap: true, maxAliasCount: 100 });
}

export function skillMetadata(file, entry) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const chunks = [];
    // ponytail: frontmatter is capped at 64 KiB; raise the limit if a local format needs more.
    for (let size = 0; size < 65536;) {
      const buffer = Buffer.alloc(1024);
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      chunks.push(buffer.subarray(0, count));
      size += count;
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (match && (!count || match[0].endsWith('\n'))) {
        const metadata = mapping(parseYaml(match[1]), 'frontmatter');
        for (const key of ['name', 'description']) {
          if (typeof metadata.get(key) !== 'string' || !metadata.get(key).trim()) {
            fail(`frontmatter.${key}`, 'expected a nonempty string');
          }
        }
        return { name: metadata.get('name').trim(), description: metadata.get('description').trim() };
      }
      if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) break;
      if (!count) break;
    }
    throw new Error('expected YAML frontmatter delimited by --- within 64 KiB');
  } catch (error) {
    fail(entry, `${file}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function skillFiles(ids, entry, resolveSkill) {
  if (!Array.isArray(ids)) fail(entry, 'expected a list of skill IDs');
  const seen = new Set();
  return ids.map((id, index) => {
    const location = `${entry}[${index}]`;
    identifier(id, location);
    if (seen.has(id)) fail(location, `duplicate skill ${id}`);
    seen.add(id);
    return resolveSkill(id, location);
  });
}

/**
 * Validate all configuration, then load only the selected additional layers.
 * @param {{root?: string, model?: string, family?: string, role?: string,
 *   skills?: string[], configuration?: Map<string, any>,
 *   newRoleFile?: {path: string, content: string}}} options
 */
export function resolveInstructions({ root = process.cwd(), model, family, role, skills = [], configuration, newRoleFile } = {}) {
  for (const [name, value] of Object.entries({ model, family, role })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      fail(name, 'expected a nonempty string or an omitted value');
    }
  }
  if (!Array.isArray(skills)) fail('skills', 'expected a list of requested skill IDs');
  skills.forEach((id, index) => identifier(id, `skills[${index}]`));

  let repository, base, config;
  try {
    repository = realpathSync(root);
    base = realpathSync(path.join(repository, '.agent-profiles'));
    config = configuration === undefined ? parseYaml(readFileSync(path.join(base, 'agents.yaml'), 'utf8')) : configuration;
  } catch (error) {
    fail('.agent-profiles/agents.yaml', `${error.message}; run agent-profiles init for a new installation, or repair the existing configuration and run agent-profiles doctor`);
  }
  if (newRoleFile !== undefined) {
    if (typeof newRoleFile?.content !== 'string') fail('newRoleFile', 'expected path and text content');
    localFile(base, newRoleFile.path, 'newRoleFile.path', '.agent-profiles', true);
  }

  mapping(config, 'agents.yaml', ['version', 'default_profile', 'default_role', 'models', 'families', 'roles'], ['skills']);
  if (config.get('version') !== 1) fail('version', 'only version 1 is supported');
  const defaultProfile = config.get('default_profile');
  profileFile(base, defaultProfile, 'default_profile');
  const defaultRole = identifier(config.get('default_role'), 'default_role');
  for (const section of ['models', 'families']) {
    for (const [identity, value] of mapping(config.get(section), section)) {
      const entry = `${section}.${identity}`;
      mapping(value, entry, ['profile']);
      profileFile(base, value.get('profile'), `${entry}.profile`);
    }
  }

  const roles = mapping(config.get('roles'), 'roles');
  if (!roles.has(defaultRole)) fail('default_role', `role ${defaultRole} is not declared in roles`);
  const sources = mapping(config.has('skills') ? config.get('skills') : new Map(), 'skills');
  for (const [id, source] of sources) {
    identifier(id, `skills.${id}`);
    mapping(source, `skills.${id}`, ['file']);
  }
  const catalog = new Map();
  function resolveSkill(id, entry) {
    if (catalog.has(id)) return catalog.get(id);
    const conventional = `.agent-profiles/skills/${id}/SKILL.md`;
    const file = sources.has(id) ? sources.get(id).get('file') : conventional;
    const resolved = localFile(repository, file, entry, 'repository');
    if (sources.has(id) && existsSync(path.join(repository, conventional)) &&
        localFile(repository, conventional, entry, 'repository') !== resolved) {
      fail(entry, `ambiguous skill ${id}: both ${conventional} and ${file} exist`);
    }
    const skill = { id, ...skillMetadata(resolved, entry), path: file };
    catalog.set(id, skill);
    return skill;
  }
  const roleSkills = new Map();
  for (const [id, value] of roles) {
    const entry = `roles.${id}`;
    identifier(id, entry);
    mapping(value, entry, ['file', 'skills'], ['description']);
    if (value.has('description') && typeof value.get('description') !== 'string') fail(`${entry}.description`, 'expected a string');
    localFile(base, value.get('file'), `${entry}.file`, '.agent-profiles', newRoleFile?.path === value.get('file'));
    const skills = mapping(value.get('skills'), `${entry}.skills`, ['required', 'available']);
    const required = skillFiles(skills.get('required'), `${entry}.skills.required`, resolveSkill);
    const available = skillFiles(skills.get('available'), `${entry}.skills.available`, resolveSkill);
    for (const skill of available) {
      if (required.some(item => item.id === skill.id)) {
        fail(`${entry}.skills.available`, `${skill.id} is also required`);
      }
    }
    roleSkills.set(id, { required, available });
  }
  for (const id of sources.keys()) resolveSkill(id, `skills.${id}.file`);

  const models = config.get('models');
  const families = config.get('families');
  const matchedBy = models.has(model) ? 'model' : families.has(family) ? 'family' : 'default';
  const profile = matchedBy === 'model' ? models.get(model).get('profile') :
    matchedBy === 'family' ? families.get(family).get('profile') : defaultProfile;
  const selectedRole = role ?? defaultRole;
  if (!roles.has(selectedRole)) fail('role', `${selectedRole} is not declared in roles; choose ${[...roles.keys()].join(', ')} or run agent-profiles configure to create it`);
  const { required, available } = roleSkills.get(selectedRole);
  const permitted = new Map([...required, ...available].map(skill => [skill.id, skill]));
  for (const id of skills) {
    if (!permitted.has(id)) fail(`role ${selectedRole}`, `skill ${id} is not required or available to this role`);
  }
  const selectedSkills = [...new Set([...required.map(skill => skill.id), ...skills])].map(id => permitted.get(id));
  const files = [
    `.agent-profiles/profiles/${profile}.md`,
    `.agent-profiles/${roles.get(selectedRole).get('file')}`,
    ...selectedSkills.map(skill => skill.path),
  ];
  const loaded = files.map(file => {
    try {
      if (newRoleFile && file === `.agent-profiles/${newRoleFile.path}`) return { path: file, content: newRoleFile.content };
      return { path: file, content: readFileSync(localFile(repository, file, file, 'repository'), 'utf8') };
    } catch (error) {
      fail(file, `cannot load instructions: ${error.message}`);
    }
  });

  return {
    model: model ?? null,
    family: family ?? null,
    matchedBy,
    profile,
    role: selectedRole,
    repository: { path: 'AGENTS.md', suppliedBy: 'host' },
    loaded,
    required,
    available,
  };
}
