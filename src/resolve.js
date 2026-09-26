import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';

function fail(entry, message) {
  throw new Error(`${entry}: ${message}`);
}

function mapping(value, entry, fields) {
  if (!(value instanceof Map)) fail(entry, 'expected a mapping');
  for (const key of value.keys()) {
    if (typeof key !== 'string' || !key.trim()) fail(entry, 'keys must be nonempty strings');
    if (fields && !fields.includes(key)) fail(`${entry}.${key}`, 'unknown field');
  }
  for (const key of fields ?? []) {
    if (!value.has(key)) fail(`${entry}.${key}`, 'required field is missing');
  }
  return value;
}

function identifier(value, entry) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    fail(entry, 'expected an ID containing lowercase letters, digits, and hyphens');
  }
  return value;
}

function localFile(base, file, entry) {
  if (typeof file !== 'string' || !file.endsWith('.md') ||
      /[:\\]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..')) {
    fail(entry, 'expected a relative Markdown path inside .agent-profiles (no .., URLs, or backslashes)');
  }
  try {
    const resolved = realpathSync(path.resolve(base, file));
    const relative = path.relative(base, resolved);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      fail(entry, `${file} resolves outside .agent-profiles`);
    }
    if (!statSync(resolved).isFile()) fail(entry, `${file} is not a file`);
    return resolved;
  } catch (error) {
    if (error.code) fail(entry, `cannot access ${file} (${error.code})`);
    throw error;
  }
}

function profileFile(base, id, entry) {
  identifier(id, entry);
  const file = `profiles/${id}.md`;
  localFile(base, file, entry);
  return file;
}

function skillFiles(base, ids, entry) {
  if (!Array.isArray(ids)) fail(entry, 'expected a list of skill IDs');
  const seen = new Set();
  return ids.map((id, index) => {
    const location = `${entry}[${index}]`;
    identifier(id, location);
    if (seen.has(id)) fail(location, `duplicate skill ${id}`);
    seen.add(id);
    const file = `skills/${id}/SKILL.md`;
    localFile(base, file, location);
    return { id, path: file };
  });
}

/** Validate all configuration, then load only the selected additional layers. */
export function resolveInstructions({ root = process.cwd(), model, family, role } = {}) {
  for (const [name, value] of Object.entries({ model, family, role })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      fail(name, 'expected a nonempty string or an omitted value');
    }
  }

  let base, config;
  try {
    base = realpathSync(path.resolve(root, '.agent-profiles'));
    const document = parseDocument(readFileSync(path.join(base, 'agents.yaml'), 'utf8'));
    if (document.errors.length || document.warnings.length) {
      throw new Error([...document.errors, ...document.warnings].map(error => error.message).join('\n'));
    }
    config = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
  } catch (error) {
    fail('.agent-profiles/agents.yaml', error.message);
  }

  mapping(config, 'agents.yaml', ['version', 'default_profile', 'default_role', 'models', 'families', 'roles']);
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
  const roleSkills = new Map();
  for (const [id, value] of roles) {
    const entry = `roles.${id}`;
    identifier(id, entry);
    mapping(value, entry, ['file', 'skills']);
    localFile(base, value.get('file'), `${entry}.file`);
    const skills = mapping(value.get('skills'), `${entry}.skills`, ['required', 'available']);
    const required = skillFiles(base, skills.get('required'), `${entry}.skills.required`);
    const available = skillFiles(base, skills.get('available'), `${entry}.skills.available`);
    for (const skill of available) {
      if (required.some(item => item.id === skill.id)) {
        fail(`${entry}.skills.available`, `${skill.id} is also required`);
      }
    }
    roleSkills.set(id, { required, available });
  }

  const models = config.get('models');
  const families = config.get('families');
  const matchedBy = models.has(model) ? 'model' : families.has(family) ? 'family' : 'default';
  const profile = matchedBy === 'model' ? models.get(model).get('profile') :
    matchedBy === 'family' ? families.get(family).get('profile') : defaultProfile;
  const selectedRole = role ?? defaultRole;
  if (!roles.has(selectedRole)) fail('role', `${selectedRole} is not declared in roles`);
  const { required, available } = roleSkills.get(selectedRole);
  const files = [`profiles/${profile}.md`, roles.get(selectedRole).get('file'), ...required.map(skill => skill.path)];
  const loaded = files.map(file => {
    try {
      return { path: `.agent-profiles/${file}`, content: readFileSync(localFile(base, file, file), 'utf8') };
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
    available: available.map(skill => ({ id: skill.id, path: `.agent-profiles/${skill.path}` })),
  };
}
