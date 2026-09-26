import { existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInstructions } from './resolve.js';
import { safePath, readLocal, applyChanges } from './files.js';
import { bootstrapBlock, integrations, managedSpan } from './integrations.js';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

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

export function doctor(root) {
  root = realpathSync(root);
  const errors = [];
  let resolution;
  try {
    resolution = resolveInstructions({ root });
    if (readLocal(root, '.agent-profiles/BOOTSTRAP.md') === null) {
      errors.push('.agent-profiles/BOOTSTRAP.md is missing; run init to add the routing protocol');
    }
  } catch (error) { errors.push(error.message); }
  const agents = [];
  for (const adapter of integrations) {
    try {
      const { records, ...state } = integrationState(root, adapter);
      agents.push(state);
    } catch (error) { errors.push(error.message); }
  }
  if (!agents.some(agent => agent.installed)) errors.push('No active Agent Profiles integration; run init to select an agent');
  return { root, valid: errors.length === 0, profile: resolution?.profile, role: resolution?.role, agents, errors };
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
    const file = '.agent-profiles/BOOTSTRAP.md';
    if (readLocal(root, file) === null) changes.push({ file, before: null, after: readFileSync(path.join(packageRoot, file)) });
  }
  for (const agent of selected) {
    if (agent.installed) continue;
    const { file, before } = agent.records.find(record => record.file === agent.file);
    const block = bootstrapBlock(before?.includes(Buffer.from('\r\n')) ? '\r\n' : '\n');
    changes.push({ file, before, after: Buffer.concat([before ?? Buffer.alloc(0), block]) });
  }
  // Preflight every target before the first write, including unselected integrations.
  detectAgents(root);
  for (const change of changes) safePath(root, change.file);
  const modified = applyChanges(root, changes, () => {
    const report = doctor(root);
    if (!report.valid) throw new Error(report.errors.join('\n'));
  });
  return { ...doctor(root), modified };
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
  const modified = applyChanges(root, changes);
  if (deleteConfig && existsSync(config)) {
    try { rmSync(config, { recursive: true }); modified.push('.agent-profiles/'); }
    catch (error) { throw new Error(`Integrations removed (${modified.join(', ')}); configuration deletion failed: ${error.message}`); }
  }
  return { root, modified, configurationRetained: existsSync(config) };
}
