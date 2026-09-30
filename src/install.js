import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstructions } from './resolve.js';
import { readConfiguration } from './configure.js';
import { safePath, readLocal, applyChanges } from './files.js';
import { blockProtocol, expectedBlock, integrations, managedSpan, PROTOCOL } from './integrations.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const protocolFile = '.agent-profiles/BOOTSTRAP.md';
// BOOTSTRAP.md is a managed reference, compared without regard to line endings, which Git may convert.
const packagedProtocol = () => readFileSync(path.join(packageRoot, protocolFile));
const sameText = (a, b) => a.toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8').replace(/\r\n/g, '\n');

export function findRoot(start = process.cwd()) {
  let current = realpathSync(start);
  while (!existsSync(path.join(current, '.git'))) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No Git repository found; pass --root <directory> explicitly');
    current = parent;
  }
  return current;
}

function integrationState(root, adapter) {
  const records = adapter.files.map(file => {
    const before = readLocal(root, file);
    return { file, before, span: before === null ? null : managedSpan(before, file) };
  });
  const installed = records.filter(record => record.span);
  if (installed.length > 1) throw new Error(`${adapter.name}: bootstrap appears in multiple instruction files`);
  const target = adapter.select(records);
  if (installed.length && installed[0].file !== target) {
    throw new Error(`${adapter.name}: bootstrap in ${installed[0].file} is shadowed by ${target}; uninstall then init to relocate it`);
  }
  return {
    id: adapter.id, name: adapter.name, file: target,
    detected: records.some(record => record.before !== null) || existsSync(path.join(root, adapter.hint)),
    installed: installed.length === 1, records,
  };
}

export function detectAgents(root) {
  root = realpathSync(root);
  return integrations.map(adapter => integrationState(root, adapter));
}

const ownVersion = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;

/**
 * Whether `npx --no agent-profiles` can run from this repository without a download,
 * mirroring npm: the local prefix is the nearest directory with package.json.
 * @param {string} root
 */
export function bootstrapAvailability(root) {
  let prefix = root;
  while (!existsSync(path.join(prefix, 'package.json')) && path.dirname(prefix) !== prefix) prefix = path.dirname(prefix);
  if (!existsSync(path.join(prefix, 'package.json'))) prefix = root;
  // npm cannot run anything from a project whose manifest it cannot parse.
  const read = file => {
    try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; }
    catch (error) { throw Object.assign(new Error(`${path.relative(root, file) || file}: ${error.message}`), { unreadable: true }); }
  };
  let project, installed;
  try {
    project = read(path.join(prefix, 'package.json')) ?? {};
    installed = read(path.join(prefix, 'node_modules/agent-profiles/package.json'));
  } catch (error) {
    if (!error.unreadable) throw error;
    return { runnable: false, version: null, reason: `${error.message}; npx cannot run the bootstrap until it is repaired` };
  }
  const version = project.name === 'agent-profiles' ? project.version : installed?.version ?? null;
  if (version === null) return { runnable: false, version, reason: 'agent-profiles is not installed in this repository, so the bootstrap command fails; run init with --package, or npm install --save-dev agent-profiles' };
  // An older or newer copy may not understand this configuration or print this protocol.
  if (version !== ownVersion) return { runnable: false, version, reason: `the bootstrap runs installed agent-profiles ${version}, but this configuration was checked with ${ownVersion}; install ${ownVersion}` };
  return { runnable: true, version, reason: null };
}

function readSettings(root, file) {
  const before = readLocal(root, file);
  if (before === null) return { before, settings: null };
  try { return { before, settings: JSON.parse(before.toString('utf8')) }; }
  catch (error) { throw new Error(`${file}: ${error.message}; repair it before Agent Profiles can check or add its permission rules`); }
}

/** Missing permission rules for an adapter's bootstrap command, across its settings files. */
function missingPermissions(root, adapter) {
  if (!adapter.permissions) return [];
  const allowed = new Set([adapter.permissions.file, ...adapter.permissions.also]
    .flatMap(file => readSettings(root, file).settings?.permissions?.allow ?? []));
  return adapter.permissions.rules.filter(rule => !allowed.has(rule));
}

function permissionChange(root, adapter, add) {
  const { file, rules } = adapter.permissions;
  const { before, settings } = readSettings(root, file);
  if (!add && settings === null) return null;
  const next = settings ?? {};
  if (typeof next !== 'object' || Array.isArray(next)) throw new Error(`${file}: expected a JSON object`);
  next.permissions ??= {};
  const allow = next.permissions.allow ?? [];
  if (!Array.isArray(allow)) throw new Error(`${file}: permissions.allow must be a list`);
  next.permissions.allow = add ? [...allow, ...rules.filter(rule => !allow.includes(rule))] : allow.filter(rule => !rules.includes(rule));
  // Untouched when nothing changes, so an existing file keeps its exact bytes.
  if (add ? rules.every(rule => allow.includes(rule)) : !rules.some(rule => allow.includes(rule))) return null;
  // A settings file that held only these rules is removed rather than left empty.
  const emptied = !add && JSON.stringify(next) === JSON.stringify({ permissions: { allow: [] } });
  return { file, before, after: emptied ? null : Buffer.from(`${JSON.stringify(next, null, 2)}\n`) };
}

export function doctor(root) {
  root = realpathSync(root);
  const errors = [];
  const notes = [];
  const capabilities = [];
  const hostSkills = new Map();
  const legacy = [];
  let resolution, roleIDs = [];
  try {
    resolution = resolveInstructions({ root });
    const { configuration } = readConfiguration(root);
    roleIDs = [...configuration.get('roles').keys()];
    for (const role of roleIDs) {
      const { required, available } = resolveInstructions({ root, role });
      for (const skill of [...required, ...available]) if (skill.type === 'host') hostSkills.set(skill.id, skill);
    }
    // Mappings written before host-native skills existed inject a host skill's file as plain text.
    for (const [id, source] of configuration.get('skills') ?? []) {
      const file = source.get('file');
      const hostId = file?.split('/')[2];
      const adapter = integrations.find(item => item.skills && hostId && item.skills.project.path(hostId) === file);
      if (adapter) legacy.push(`Skill ${id} maps ${file} as injected text; replace it with {host: ${adapter.id}, scope: project${hostId === id ? '' : `, id: ${hostId}`}} so ${adapter.name} invokes it`);
    }
    if (readLocal(root, '.agent-profiles/BOOTSTRAP.md') === null) {
      errors.push('.agent-profiles/BOOTSTRAP.md is missing; run init to add the routing protocol');
    }
  } catch (error) { errors.push(error.message); }
  const agents = [];
  const stale = [];
  for (const adapter of integrations) {
    try {
      const { records, ...state } = integrationState(root, adapter);
      agents.push(state);
      // A block from another protocol version tells the agent something this CLI no longer means.
      const record = records.find(item => item.file === state.file);
      const span = state.installed && record.before.subarray(record.span.start, record.span.end);
      if (span && !span.equals(expectedBlock(adapter.id, record.before))) {
        const version = blockProtocol(span);
        const found = version === PROTOCOL ? 'modified' : version ? `protocol ${version}` : 'unversioned (before protocol 2)';
        stale.push(`${adapter.name}: the managed block in ${state.file} is ${found}, not protocol ${PROTOCOL}; run init to replace it`);
      }
    } catch (error) { errors.push(error.message); }
  }
  const protocol = readLocal(root, protocolFile);
  if (protocol !== null && !sameText(protocol, packagedProtocol())) stale.push(`${protocolFile} differs from protocol ${PROTOCOL}; run init to refresh this managed reference`);
  if (!agents.some(agent => agent.installed)) errors.push('No active Agent Profiles integration; run init to select an agent');
  // A required host skill that an installed host cannot invoke makes that role unsatisfiable there.
  if (resolution) {
    for (const agent of agents.filter(item => item.installed)) {
      for (const role of roleIDs) {
        for (const entry of resolveInstructions({ root, role, host: agent.id }).unsatisfied) capabilities.push(`Role ${role} in ${agent.name}: required skill ${entry.id} is unsatisfied (${entry.reason})`);
      }
    }
  }
  for (const skill of hostSkills.values()) {
    // An integration whose state failed is already reported as an error and has no agent record.
    const adapter = integrations.find(item => item.id === skill.host);
    const agent = agents.find(item => item.id === skill.host);
    const state = skill.verification === 'verified-local' ? `verified at ${skill.path}` : 'host-provided; Agent Profiles cannot verify it';
    const unreadable = skill.metadataError ? `; its metadata could not be read (${skill.metadataError})` : '';
    notes.push(`Skill ${skill.id} is ${adapter.name} skill ${skill.hostId}: ${state}${unreadable}${agent && !agent.installed ? `; the ${adapter.name} integration is not installed` : ''}`);
  }
  notes.push(...legacy);
  // Bootstrap availability: can each installed block's command actually run here?
  const availability = bootstrapAvailability(root);
  const bootstrap = [...stale];
  for (const agent of agents.filter(item => item.installed)) {
    const adapter = integrations.find(item => item.id === agent.id);
    if (!availability.runnable) bootstrap.push(`${agent.name}: ${availability.reason}`);
    try {
      const missing = missingPermissions(root, adapter);
      if (missing.length) bootstrap.push(`${agent.name}: ${adapter.permissions.file} does not allow ${missing.join(' or ')}; run init to add the rules`);
    } catch (error) { bootstrap.push(`${agent.name}: ${error.message}`); }
    const { mode, verified, ...limits } = adapter.capabilities;
    notes.push([`${agent.name}: ${mode} mode (observed: ${verified})`, ...Object.entries(limits).map(([key, value]) => `  ${key}: ${value}`)].join('\n'));
  }
  return {
    root, valid: errors.length === 0 && bootstrap.length === 0 && capabilities.length === 0,
    profile: resolution?.profile, role: resolution?.role, agents, availability, ownVersion,
    errors, bootstrap, capabilities, notes,
  };
}

function templateFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = prefix + entry.name;
    if (entry.isDirectory()) return templateFiles(path.join(directory, entry.name), `${file}/`);
    if (!entry.isFile()) throw new Error(`Unsupported template entry: ${file}`);
    return [file];
  });
}

export function install({ root, agents }) {
  root = realpathSync(root);
  const choices = integrations.map(adapter => adapter.id).join(', ');
  if (!Array.isArray(agents) || !agents.length) throw new Error(`Select at least one agent: ${choices}`);
  const selected = [...new Set(agents)].map(id => {
    const adapter = integrations.find(item => item.id === id);
    if (!adapter) throw new Error(`Unknown agent ${id}; choose ${choices}`);
    return integrationState(root, adapter);
  });
  const changes = [];
  const config = readLocal(root, '.agent-profiles/agents.yaml');
  if (config === null) {
    const directory = safePath(root, '.agent-profiles');
    if (existsSync(directory) && readdirSync(directory).length) {
      throw new Error('.agent-profiles exists without agents.yaml; restore or move it before init (nothing overwritten)');
    }
    resolveInstructions({ root: packageRoot });
    const templates = path.join(packageRoot, '.agent-profiles');
    for (const file of templateFiles(templates)) {
      changes.push({ file: `.agent-profiles/${file}`, before: null, after: readFileSync(path.join(templates, file)) });
    }
  } else {
    resolveInstructions({ root });
    const before = readLocal(root, protocolFile);
    if (before === null || !sameText(before, packagedProtocol())) changes.push({ file: protocolFile, before, after: packagedProtocol() });
  }
  // Refresh every installed surface, not only the selected ones: a stale block elsewhere still reaches agents.
  const installed = integrations.map(adapter => integrationState(root, adapter)).filter(agent => agent.installed && !selected.some(item => item.id === agent.id));
  for (const agent of [...selected, ...installed]) {
    const { file, before, span } = agent.records.find(record => record.file === agent.file);
    const block = expectedBlock(agent.id, before);
    // An outdated managed block is replaced in place; bytes outside the markers are preserved.
    if (agent.installed && before.subarray(span.start, span.end).equals(block)) continue;
    changes.push({ file, before, after: agent.installed
      ? Buffer.concat([before.subarray(0, span.start), block, before.subarray(span.end)])
      : Buffer.concat([before ?? Buffer.alloc(0), block]) });
  }
  for (const agent of [...selected, ...installed]) {
    const adapter = integrations.find(item => item.id === agent.id);
    const change = adapter.permissions && permissionChange(root, adapter, true);
    if (change) changes.push(change);
  }
  // Preflight every target before the first write, including unselected integrations.
  detectAgents(root);
  for (const change of changes) safePath(root, change.file);
  const modified = applyChanges(root, changes, () => {
    const report = doctor(root);
    // Host capability gaps are reported by doctor but do not block installing an integration.
    if (report.errors.length) throw new Error(report.errors.join('\n'));
  });
  return { ...doctor(root), modified };
}

function npmCli() {
  const node = path.dirname(process.execPath);
  const cli = [process.env.npm_execpath, path.join(node, 'node_modules/npm/bin/npm-cli.js'), path.join(node, '../lib/node_modules/npm/bin/npm-cli.js')]
    .find(candidate => candidate?.endsWith('.js') && existsSync(candidate));
  if (!cli) throw new Error('npm was not found beside this Node.js; run npm install --save-dev <package> in the repository');
  return cli;
}

/**
 * Install the package the bootstrap runs, as a dev dependency of the repository.
 * @param {string} root
 * @param {string} spec npm package spec, such as agent-profiles@0.1.0 or a tarball path
 */
export function installPackage(root, spec) {
  root = realpathSync(root);
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('--package requires an npm package spec or tarball path');
  // A local tarball or directory is resolved from the caller's directory, not the repository.
  const target = existsSync(path.resolve(spec)) ? path.resolve(spec) : spec;
  const result = spawnSync(process.execPath, [npmCli(), 'install', '--save-dev', '--no-audit', '--no-fund', target], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm install --save-dev ${target} failed in ${root}`);
  return bootstrapAvailability(root);
}

export function uninstall({ root, deleteConfig = false, confirmed = false }) {
  root = realpathSync(root);
  if (typeof deleteConfig !== 'boolean' || typeof confirmed !== 'boolean') throw new Error('Deletion options must be booleans');
  if (deleteConfig && !confirmed) throw new Error('Deleting .agent-profiles requires explicit confirmation');
  const changes = [];
  // Inspect every known path, even when an override now shadows a previously installed block.
  for (const file of new Set(integrations.flatMap(adapter => adapter.files))) {
    const before = readLocal(root, file);
    const span = before === null ? null : managedSpan(before, file);
    if (span) changes.push({ file, before, after: Buffer.concat([before.subarray(0, span.start), before.subarray(span.end)]) });
  }
  const config = safePath(root, '.agent-profiles');
  if (deleteConfig && existsSync(config)) {
    // Verify the exact recursive-delete target and reject linked descendants before removal.
    for (const file of templateFiles(config)) safePath(root, `.agent-profiles/${file}`);
    if (realpathSync(config) !== path.join(root, '.agent-profiles')) throw new Error('Unsafe configuration deletion target');
  }
  // Remove only the exact permission rules init added; other settings are untouched.
  for (const adapter of integrations.filter(item => item.permissions)) {
    const change = permissionChange(root, adapter, false);
    if (change) changes.push(change);
  }
  const modified = applyChanges(root, changes);
  if (deleteConfig && existsSync(config)) {
    try { rmSync(config, { recursive: true }); modified.push('.agent-profiles/'); }
    catch (error) { throw new Error(`Integrations removed (${modified.join(', ')}); configuration deletion failed: ${error.message}`); }
  }
  return { root, modified, configurationRetained: existsSync(config) };
}
