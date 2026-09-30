import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { safePath } from './files.js';
import { contextDiagnostics, measureFile, measureText } from './diagnostics.js';
import { integrations } from './integrations.js';

function fail(entry, message) {
  throw new Error(`${entry}: ${message}`);
}

export function mapping(value, entry, fields, optional = []) {
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

export function localFile(base, file, entry, scope = '.agent-profiles', allowMissing = false, preview = new Map()) {
  if (typeof file !== 'string' || !file.endsWith('.md') ||
      /[:\\]/.test(file) || path.posix.isAbsolute(file) || file.split('/').includes('..')) {
    fail(entry, `expected a relative Markdown path inside ${scope} (no .., URLs, or backslashes)`);
  }
  if (preview.has(path.resolve(base, file))) return safePath(base, file);
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

function profileFile(base, id, entry, preview) {
  identifier(id, entry);
  const file = `profiles/${id}.md`;
  localFile(base, file, entry, '.agent-profiles', false, preview);
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

export function skillMetadata(file, entry, content, display = file, requireDescription = true) {
  let descriptor;
  try {
    if (content === undefined) descriptor = openSync(file, 'r');
    const chunks = [];
    // ponytail: frontmatter is capped at 64 KiB; raise the limit if a local format needs more.
    for (let size = 0; size < 65536;) {
      const buffer = Buffer.alloc(1024);
      const count = content === undefined ? readSync(descriptor, buffer, 0, buffer.length, null) : content.copy(buffer, 0, size, Math.min(size + buffer.length, content.length));
      chunks.push(buffer.subarray(0, count));
      size += count;
      const text = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (match && (!count || match[0].endsWith('\n'))) {
        const metadata = mapping(parseYaml(match[1]), 'frontmatter');
        const text = key => {
          if (!metadata.has(key) && (key === 'name' || !requireDescription)) return null;
          if (typeof metadata.get(key) !== 'string' || !metadata.get(key).trim()) fail(`frontmatter.${key}`, 'expected a nonempty string');
          return metadata.get(key).trim();
        };
        const name = text('name');
        return name === null
          ? { name: path.basename(path.dirname(display)), nameSource: 'directory', description: text('description') }
          : { name, nameSource: 'frontmatter', description: text('description') };
      }
      if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) break;
      if (!count) break;
    }
    throw new Error('expected YAML frontmatter delimited by --- within 64 KiB');
  } catch (error) {
    fail(entry, `${display}: ${error.message}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function strings(value, entry) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) fail(entry, 'expected a list of nonempty strings');
  if (new Set(value).size !== value.length) fail(entry, 'duplicate entries');
  return value;
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
 * Identity matching is exact and case-sensitive: model key, alias, supplied family,
 * longest configured family prefix, then default_profile.
 * `host` names the integration consuming the result; host-native skills of another host
 * are unusable there, and required ones are reported as unsatisfied.
 * @param {{root?: string, host?: string, model?: string, family?: string, identitySource?: 'host' | 'host-stated' | 'user', role?: string,
 *   skills?: string[], configuration?: Map<string, any>,
 *   newRoleFile?: {path: string, content: string}, preview?: Map<string, Buffer>}} options
 */
export function resolveInstructions({ root = process.cwd(), host, model, family, identitySource, role, skills = [], configuration, newRoleFile, preview = new Map() } = {}) {
  if (host !== undefined && !integrations.some(adapter => adapter.id === host)) fail('host', `expected one of ${integrations.map(adapter => adapter.id).join(', ')} or an omitted value`);
  for (const [name, value] of Object.entries({ model, family, role })) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
      fail(name, 'expected a nonempty string or an omitted value');
    }
  }
  if (identitySource !== undefined && !['host', 'host-stated', 'user'].includes(identitySource)) fail('identitySource', 'expected host, host-stated, user, or an omitted value');
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
  profileFile(base, defaultProfile, 'default_profile', preview);
  const defaultRole = identifier(config.get('default_role'), 'default_role');
  const models = mapping(config.get('models'), 'models');
  const aliases = new Map();
  for (const [identity, value] of models) {
    const entry = `models.${identity}`;
    mapping(value, entry, ['profile'], ['aliases']);
    profileFile(base, value.get('profile'), `${entry}.profile`, preview);
    for (const alias of value.has('aliases') ? strings(value.get('aliases'), `${entry}.aliases`) : []) {
      if (alias === identity) continue; // Redundant but harmless.
      if (models.has(alias)) fail(`${entry}.aliases`, `alias ${alias} shadows the configured model ${alias}`);
      if (aliases.has(alias)) fail(`${entry}.aliases`, `alias ${alias} is also an alias of models.${aliases.get(alias)}`);
      aliases.set(alias, identity);
    }
  }
  const families = mapping(config.get('families'), 'families');
  const prefixes = new Map();
  for (const [name, value] of families) {
    const entry = `families.${name}`;
    mapping(value, entry, ['profile'], ['match']);
    profileFile(base, value.get('profile'), `${entry}.profile`, preview);
    if (!value.has('match')) continue;
    const match = mapping(value.get('match'), `${entry}.match`, ['prefixes']);
    for (const prefix of strings(match.get('prefixes'), `${entry}.match.prefixes`)) {
      // Distinct prefixes of one identity differ in length, so only an identical prefix can tie.
      if (prefixes.has(prefix)) fail(`${entry}.match.prefixes`, `prefix ${prefix} is also used by families.${prefixes.get(prefix)}; equally specific rules are ambiguous`);
      prefixes.set(prefix, name);
    }
  }

  const roles = mapping(config.get('roles'), 'roles');
  if (!roles.has(defaultRole)) fail('default_role', `role ${defaultRole} is not declared in roles`);
  const sources = mapping(config.has('skills') ? config.get('skills') : new Map(), 'skills');
  const hosts = integrations.filter(adapter => adapter.skills);
  const hostOf = source => hosts.find(adapter => adapter.id === source.get('host'));
  for (const [id, source] of sources) {
    identifier(id, `skills.${id}`);
    if (!(source instanceof Map && source.has('host'))) { mapping(source, `skills.${id}`, ['file']); continue; }
    mapping(source, `skills.${id}`, ['host', 'scope'], ['id']);
    const adapter = hostOf(source);
    if (!adapter) fail(`skills.${id}.host`, `expected a host with native skills: ${hosts.map(item => item.id).join(', ')}`);
    const scope = adapter.skills[source.get('scope')];
    if (!Object.hasOwn(adapter.skills, source.get('scope'))) fail(`skills.${id}.scope`, `expected one of ${Object.keys(adapter.skills).join(', ')}`);
    const hostId = source.has('id') ? source.get('id') : id;
    if (typeof hostId !== 'string' || !scope.id.test(hostId)) fail(`skills.${id}.id`, `expected a ${adapter.name} ${source.get('scope')} skill identifier`);
  }
  const catalog = new Map();
  function resolveSkill(id, entry) {
    if (catalog.has(id)) return catalog.get(id);
    const conventional = `.agent-profiles/skills/${id}/SKILL.md`;
    const exists = file => existsSync(path.join(repository, file)) || preview.has(path.join(repository, file));
    const source = sources.get(id);
    if (source?.has('host')) {
      if (exists(conventional)) fail(entry, `ambiguous skill ${id}: ${conventional} exists and skills.${id} names a host skill`);
      const adapter = hostOf(source);
      const hostId = source.get('id') ?? id;
      const scope = source.get('scope');
      // User and plugin skills live outside the repository: host-provided, never verified here.
      let skill = { id, type: 'host', host: adapter.id, hostId, scope, delivery: 'invoke', name: hostId, nameSource: 'host', description: null, path: null, verification: 'host-provided' };
      if (scope === 'project') {
        // A declared project skill must exist, so a misspelled ID fails like any missing file.
        const file = adapter.skills.project.path(hostId);
        const resolved = localFile(repository, file, entry, 'repository', false, preview);
        skill = { ...skill, path: file, verification: 'verified-local' };
        // The host owns this file's format; unreadable metadata is reported, not fatal to every role.
        try { skill = { ...skill, ...skillMetadata(resolved, entry, preview.get(resolved), file, false) }; }
        catch (error) { skill.metadataError = error.message.slice(error.message.indexOf(`${file}: `) + file.length + 2); }
      }
      catalog.set(id, skill);
      return skill;
    }
    const file = source ? source.get('file') : conventional;
    const resolved = localFile(repository, file, entry, 'repository', false, preview);
    if (source && exists(conventional) &&
        localFile(repository, conventional, entry, 'repository', false, preview) !== resolved) {
      fail(entry, `ambiguous skill ${id}: both ${conventional} and ${file} exist`);
    }
    const skill = { id, type: 'instruction', delivery: 'inject', ...skillMetadata(resolved, entry, preview.get(resolved), file), path: file };
    catalog.set(id, skill);
    return skill;
  }
  const roleSkills = new Map();
  for (const [id, value] of roles) {
    const entry = `roles.${id}`;
    identifier(id, entry);
    mapping(value, entry, ['file', 'skills'], ['description']);
    if (value.has('description') && typeof value.get('description') !== 'string') fail(`${entry}.description`, 'expected a string');
    localFile(base, value.get('file'), `${entry}.file`, '.agent-profiles', newRoleFile?.path === value.get('file'), preview);
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

  const canonical = models.has(model) ? model : aliases.get(model) ?? null;
  const prefix = model === undefined ? undefined : [...prefixes.keys()].filter(item => model.startsWith(item)).sort((a, b) => b.length - a.length)[0];
  const matchedBy = models.has(model) ? 'model' : canonical ? 'alias' : families.has(family) ? 'family' : prefix !== undefined ? 'family-prefix' : 'default';
  const resolvedFamily = matchedBy === 'family-prefix' ? prefixes.get(prefix) : family ?? null;
  const familySource = matchedBy === 'family-prefix' ? 'configured-prefix' : family === undefined ? null : 'supplied';
  const profile = canonical ? models.get(canonical).get('profile') :
    matchedBy.startsWith('family') ? families.get(resolvedFamily).get('profile') : defaultProfile;
  const selectedRole = role ?? defaultRole;
  if (!roles.has(selectedRole)) fail('role', `${selectedRole} is not declared in roles; choose ${[...roles.keys()].join(', ')} or run agent-profiles configure to create it`);
  const { required, available } = roleSkills.get(selectedRole);
  const permitted = new Map([...required, ...available].map(skill => [skill.id, skill]));
  for (const id of skills) {
    if (!permitted.has(id)) fail(`role ${selectedRole}`, `skill ${id} is not required or available to this role`);
  }
  const selectedSkills = [...new Set([...required.map(skill => skill.id), ...skills])].map(id => permitted.get(id));
  const files = [
    { path: `.agent-profiles/profiles/${profile}.md`, kind: 'profile', id: profile },
    { path: `.agent-profiles/${roles.get(selectedRole).get('file')}`, kind: 'role', id: selectedRole },
    ...selectedSkills.filter(skill => skill.type === 'instruction').map(skill => ({ path: skill.path, id: skill.id, kind: required.some(item => item.id === skill.id) ? 'required-skill' : 'requested-skill' })),
  ];
  const loaded = files.map(entry => {
    const file = entry.path;
    try {
      let content;
      if (newRoleFile && file === `.agent-profiles/${newRoleFile.path}`) content = newRoleFile.content;
      else {
        const resolved = localFile(repository, file, file, 'repository', false, preview);
        content = (preview.get(resolved) ?? readFileSync(resolved)).toString('utf8');
      }
      return { ...entry, content, ...measureText(content) };
    } catch (error) {
      fail(file, `cannot load instructions: ${error.message}`);
    }
  });
  const measuredSkills = new Map(loaded.filter(entry => entry.kind.endsWith('-skill')).map(entry => [entry.id, { bytes: entry.bytes, characters: entry.characters }]));
  // null when the consuming host is unknown; otherwise whether that host can invoke the skill.
  const usable = skill => ({ bytes: null, characters: null, usable: host === undefined ? null : skill.host === host });
  const unsatisfied = host === undefined ? [] : required.filter(skill => skill.type === 'host' && skill.host !== host)
    .map(({ id, host: skillHost, hostId }) => ({ id, host: skillHost, hostId, reason: `${integrations.find(item => item.id === skillHost).name} skill ${hostId} cannot be invoked by ${integrations.find(item => item.id === host).name}` }));
  const measuredAvailable = available.map(skill => {
    try {
      if (skill.type === 'host') return { ...skill, ...usable(skill) };
      let measured = measuredSkills.get(skill.id);
      if (!measured) {
        const file = localFile(repository, skill.path, skill.path, 'repository', false, preview);
        measured = preview.has(file) ? measureText(preview.get(file).toString('utf8')) : measureFile(file);
      }
      return { ...skill, ...measured };
    } catch (error) { fail(skill.path, `cannot measure available instructions: ${error.message}`); }
  });

  const requiredOut = required.map(skill => ({ ...skill, ...(skill.type === 'host' ? usable(skill) : measuredSkills.get(skill.id)) }));
  return {
    host: host ?? null,
    model: model ?? null,
    family: resolvedFamily,
    familySource,
    matchedBy,
    identity: { raw: model ?? null, canonical, source: model === undefined ? null : identitySource ?? null, matchedBy },
    profile,
    role: selectedRole,
    roleSource: role === undefined ? 'default' : 'assigned',
    repository: { path: 'AGENTS.md', suppliedBy: 'host', exists: existsSync(path.join(repository, 'AGENTS.md')) },
    loaded,
    required: requiredOut,
    available: measuredAvailable,
    unsatisfied,
    diagnostics: contextDiagnostics(loaded, measuredAvailable, requiredOut, host),
  };
}
