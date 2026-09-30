import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isNode, visit } from 'yaml';
import { applyChanges, readLocal, safePath } from './files.js';
import { identifier, localFile, parseYaml, parseYamlDocument, resolveInstructions, skillMetadata } from './resolve.js';

const configFile = '.agent-profiles/agents.yaml';

export function readConfiguration(root) {
  root = realpathSync(root);
  const before = readLocal(root, configFile);
  if (before === null) throw new Error(`${configFile} is missing; run init first`);
  const document = parseYamlDocument(before.toString('utf8'));
  const configuration = document.toJS({ mapAsMap: true, maxAliasCount: 100 });
  resolveInstructions({ root, configuration });
  return { root, before, document, configuration };
}

/**
 * Build a validated, reviewable plan; this function never writes files.
 * @param {{root: string, action: string, id: string, file?: string, description?: string,
 *   required?: (string | {id: string, path: string})[], available?: (string | {id: string, path: string})[],
 *   defaultRole?: string, expectedConfiguration?: Buffer}} options
 */
export function planRoleChange({ root, action, id, file, description, required, available, defaultRole, expectedConfiguration }) {
  const state = readConfiguration(root);
  ({ root } = state);
  const { document, configuration, before } = state;
  if (expectedConfiguration && !before.equals(expectedConfiguration)) throw new Error('Configuration changed while editing; reload the role before retrying');
  identifier(id, 'role');
  if (!['create', 'edit', 'delete'].includes(action)) throw new Error('Choose create, edit, or delete');
  const roles = configuration.get('roles');
  if (action === 'create' && roles.has(id)) throw new Error(`Role ${id} already exists; edit it instead`);
  if (action !== 'create' && !roles.has(id)) throw new Error(`Role ${id} does not exist`);
  const node = document.getIn(['roles', id], true);
  let shared = false;
  if (isNode(node)) visit(node, {
    Value(_, item) {
      if (item.anchor) throw new Error(`Role ${id} defines a YAML anchor; edit shared anchors manually`);
    },
    Alias() { shared = true; },
  });
  const aliases = [];
  const changes = [];
  let newRoleFile;

  if (action === 'delete') {
    if (configuration.get('default_role') === id) {
      if (!defaultRole || defaultRole === id || !roles.has(defaultRole)) {
        throw new Error(`Choose another existing default role before deleting ${id}`);
      }
      document.set('default_role', defaultRole);
    } else if (defaultRole !== undefined) {
      throw new Error('A replacement default is only needed when deleting the default role');
    }
    document.deleteIn(['roles', id]);
  } else {
    const previous = roles.get(id);
    if (required === undefined) required = previous?.get('skills').get('required') ?? [];
    if (available === undefined) available = previous?.get('skills').get('available') ?? [];
    if (!Array.isArray(required) || !Array.isArray(available)) throw new Error('Required and available skills must be lists');
    if (description !== undefined && typeof description !== 'string') throw new Error('Role description must be text');
    file ??= previous?.get('file') ?? `roles/${id}.md`;
    localFile(path.join(root, '.agent-profiles'), file, `roles.${id}.file`, '.agent-profiles', true);
    const roleFile = `.agent-profiles/${file}`;
    if (!existsSync(path.join(root, roleFile))) {
      const title = id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
      newRoleFile = { path: file, content: `# ${title}\n\n${description?.trim() || `Describe the responsibilities of ${id} here.`}\n` };
      changes.push({ file: roleFile, before: null, after: Buffer.from(newRoleFile.content) });
    }
    const sources = new Map(configuration.get('skills') ?? []);
    const binding = skillId => sources.has(skillId) ? sources.get(skillId).get('file') ?? null : `.agent-profiles/skills/${skillId}/SKILL.md`;
    const targetOf = skillId => {
      const candidate = binding(skillId);
      return candidate && existsSync(path.join(root, candidate)) ? localFile(root, candidate, skillId, 'repository') : null;
    };
    const bind = (selection, entry) => {
      const skillId = identifier(typeof selection === 'string' ? selection : selection?.id, entry);
      if (typeof selection === 'string' && sources.get(skillId)?.has('host')) return skillId;
      if (typeof selection !== 'string' && selection.host) {
        // Host skills keep the host's own identity: a conflict is reported, never renamed to an alias.
        const current = sources.get(skillId);
        if (current?.get('host') === selection.host && (current.get('id') ?? skillId) === selection.hostId) return skillId;
        if (current || existsSync(path.join(root, `.agent-profiles/skills/${skillId}/SKILL.md`))) {
          throw new Error(`${entry}: ${skillId} already names another skill, so the ${selection.host} skill ${selection.hostId} cannot use it; rename one of them first`);
        }
        const reference = new Map(Object.entries(selection.hostId === skillId ? { host: selection.host } : { host: selection.host, id: selection.hostId }));
        sources.set(skillId, reference);
        document.setIn(['skills', skillId], document.createNode(Object.fromEntries(reference)));
        return skillId;
      }
      const selectedPath = typeof selection === 'string' ? binding(skillId) : selection.path;
      const target = localFile(root, selectedPath, entry, 'repository');
      skillMetadata(target, entry, undefined, selectedPath);
      if (targetOf(skillId) === target) return skillId;
      for (const existingId of sources.keys()) {
        if (targetOf(existingId) === target) return existingId;
      }
      let reference = skillId;
      for (let suffix = 2; targetOf(reference) !== null || sources.has(reference); suffix++) reference = `${skillId}-${suffix}`;
      sources.set(reference, new Map([['file', selectedPath]]));
      document.setIn(['skills', reference, 'file'], selectedPath);
      if (reference !== skillId) aliases.push({ id: reference, originalId: skillId, path: selectedPath });
      return reference;
    };
    const next = {
      file,
      skills: {
        required: required.map((skill, index) => bind(skill, `roles.${id}.skills.required[${index}]`)),
        available: available.map((skill, index) => bind(skill, `roles.${id}.skills.available[${index}]`)),
      },
    };
    if (!previous || shared) document.setIn(['roles', id], document.createNode(previous ?? new Map()));
    document.setIn(['roles', id, 'file'], next.file);
    document.setIn(['roles', id, 'skills', 'required'], next.skills.required);
    document.setIn(['roles', id, 'skills', 'available'], next.skills.available);
    if (description !== undefined) {
      if (description.trim()) document.setIn(['roles', id, 'description'], description.trim());
      else document.deleteIn(['roles', id, 'description']);
    }
  }

  // Keep comments and unrelated YAML nodes; retain the original newline style and BOM.
  let text = document.toString({ lineWidth: 0 });
  if (before.includes(Buffer.from('\r\n'))) text = text.replace(/\n/g, '\r\n');
  if (before.toString('utf8').startsWith('\uFEFF')) text = '\uFEFF' + text;
  if (!before.toString('utf8').endsWith('\n')) text = text.replace(/\r?\n$/, '');
  const proposed = parseYaml(text);
  const role = action === 'delete' ? undefined : id;
  const resolution = resolveInstructions({ root, role, configuration: proposed, newRoleFile });
  // Avoid rewriting even formatting when the effective configuration is unchanged.
  const unchanged = JSON.stringify([...configuration], (_, value) => value instanceof Map ? Object.fromEntries(value) : value) ===
    JSON.stringify([...proposed], (_, value) => value instanceof Map ? Object.fromEntries(value) : value);
  const after = unchanged ? before : Buffer.from(text);
  if (!after.equals(before)) changes.push({ file: configFile, before, after });
  for (const change of changes) safePath(root, change.file);
  return {
    root, action, id, before, after, changes, newRoleFile, resolution, aliases,
    instructionFile: action === 'delete' ? roles.get(id).get('file') : proposed.get('roles').get(id).get('file'),
  };
}

export function applyRoleChange(plan) {
  if (!readLocal(plan.root, configFile)?.equals(plan.before)) throw new Error('Configuration changed after preview; reload before saving');
  const role = plan.action === 'delete' ? undefined : plan.id;
  resolveInstructions({ root: plan.root, role, configuration: parseYaml(plan.after.toString('utf8')), newRoleFile: plan.newRoleFile });
  const modified = applyChanges(plan.root, plan.changes, () => resolveInstructions({ root: plan.root, role }));
  return { modified, resolution: resolveInstructions({ root: plan.root, role }) };
}
