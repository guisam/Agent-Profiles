import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseDocument, stringify } from 'yaml';
import { applyRoleChange, planRoleChange, readConfiguration } from '../src/configure.js';
import { discoverSkills } from '../src/skills.js';
import { resolveInstructions } from '../src/resolve.js';
import { configureRoles, selectSkills } from '../src/wizard.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const configFile = '.agent-profiles/agents.yaml';

function repository(t) {
  // Canonical, like the implementation: macOS temp directories are reached through /var -> /private/var.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-configure-')));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-profiles-configure-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  return root;
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), fs.readFileSync(file).toString('base64')];
    }).sort(([a], [b]) => a.localeCompare(b));
}

function skill(root, id, directory = '.claude/skills') {
  const file = `${directory}/${id}/SKILL.md`;
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `---\nname: ${id}\ndescription: A short description.\n---\nPRIVATE-SKILL-BODY\n`);
  return { id, path: file };
}

function prompts(answers) {
  const output = [];
  return {
    output,
    ask: async prompt => {
      output.push(prompt);
      assert.ok(answers.length, `Unexpected prompt: ${prompt}`);
      return answers.shift();
    },
    write: text => output.push(text),
  };
}

test('discovery normalizes local sources and configured paths, reports duplicates, and reads metadata only', t => {
  const root = repository(t);
  skill(root, 'testing');
  const external = skill(root, 'security', 'team-skills');
  const broken = skill(root, 'broken');
  fs.writeFileSync(path.join(root, broken.path), '# Missing metadata');
  const config = readConfiguration(root).configuration;
  config.set('skills', new Map([['security', new Map([['file', external.path]])]]));
  const found = discoverSkills(root, config);
  assert.equal(found.skills.length, 4);
  assert.deepEqual(found.duplicates, ['testing']);
  assert.deepEqual(new Set(found.skills.map(item => item.source)), new Set(['agent-profiles', 'claude', 'configured']));
  assert.ok(found.skills.every(item => item.id && item.name && item.description && item.path));
  assert.match(found.warnings.join('\n'), /broken.*frontmatter/s);
  assert.ok(!JSON.stringify(found).includes('PRIVATE-SKILL-BODY'));
});

test('a role is validated before writing, then created with a short description and selected skills', t => {
  const root = repository(t);
  const before = snapshot(root);
  const plan = planRoleChange({ root, action: 'create', id: 'auditor', description: 'Inspect changes.', required: ['code-review'], available: ['testing'] });
  assert.deepEqual(snapshot(root), before);
  assert.equal(plan.resolution.role, 'auditor');
  assert.equal(plan.resolution.loaded.length, 3);
  assert.deepEqual(plan.resolution.available.map(item => item.id), ['testing']);
  const result = applyRoleChange(plan);
  assert.deepEqual(result.modified, ['.agent-profiles/roles/auditor.md', configFile]);
  assert.equal(fs.readFileSync(path.join(root, '.agent-profiles/roles/auditor.md'), 'utf8'), '# Auditor\n\nInspect changes.\n');
  assert.equal(readConfiguration(root).configuration.get('roles').get('auditor').get('description'), 'Inspect changes.');
});

test('editing preserves unrelated mappings, YAML comments, newline style, and hand-authored instructions', t => {
  const root = repository(t);
  const configPath = path.join(root, configFile);
  fs.writeFileSync(configPath, '\uFEFF' + fs.readFileSync(configPath, 'utf8').replace('models:', '# Keep this model comment\nmodels:').replace(/\r?\n/g, '\r\n'));
  const before = readConfiguration(root).configuration;
  const rolePath = path.join(root, '.agent-profiles/roles/reviewer.md');
  fs.writeFileSync(rolePath, '# Hand-written role\nKeep this exact content.');
  applyRoleChange(planRoleChange({ root, action: 'edit', id: 'reviewer', description: 'Review changes.', available: [] }));
  const after = readConfiguration(root).configuration;
  for (const section of ['models', 'families', 'default_profile', 'default_role']) assert.deepEqual(after.get(section), before.get(section));
  for (const id of ['implementer', 'researcher']) assert.deepEqual(after.get('roles').get(id), before.get('roles').get(id));
  assert.deepEqual(after.get('roles').get('reviewer').get('skills').get('required'), ['code-review']);
  assert.equal(fs.readFileSync(rolePath, 'utf8'), '# Hand-written role\nKeep this exact content.');
  const text = fs.readFileSync(configPath, 'utf8');
  assert.ok(text.startsWith('\uFEFF'));
  assert.ok(text.includes('# Keep this model comment\r\n'));
  assert.ok(!text.replace(/\r\n/g, '').includes('\n'));
  const stable = snapshot(root);
  assert.deepEqual(applyRoleChange(planRoleChange({ root, action: 'edit', id: 'reviewer' })).modified, []);
  assert.deepEqual(snapshot(root), stable);
});

test('ambiguous source selection creates a deterministic alias without rebinding other roles', t => {
  const root = repository(t);
  const claudeTesting = skill(root, 'testing');
  const before = fs.readFileSync(path.join(root, claudeTesting.path));
  const plan = planRoleChange({ root, action: 'create', id: 'qa', required: [claudeTesting] });
  assert.deepEqual(plan.aliases, [{ id: 'testing-2', originalId: 'testing', path: claudeTesting.path }]);
  applyRoleChange(plan);
  const config = readConfiguration(root).configuration;
  assert.equal(config.get('skills').get('testing-2').get('file'), claudeTesting.path);
  assert.deepEqual(config.get('roles').get('implementer').get('skills').get('available'), ['testing']);
  assert.equal(resolveInstructions({ root, role: 'qa' }).required[0].path, claudeTesting.path);
  assert.equal(resolveInstructions({ root, role: 'implementer' }).available[0].path, '.agent-profiles/skills/testing/SKILL.md');
  applyRoleChange(planRoleChange({ root, action: 'create', id: 'qa-two', available: [claudeTesting] }));
  assert.deepEqual(resolveInstructions({ root, role: 'qa-two' }).available.map(item => item.id), ['testing-2']);
  assert.deepEqual(fs.readFileSync(path.join(root, claudeTesting.path)), before);
});

test('deleting a role retains instruction and skill files and protects the default', t => {
  const root = repository(t);
  const files = snapshot(root).filter(([file]) => file !== path.normalize(configFile));
  assert.throws(() => planRoleChange({ root, action: 'delete', id: 'implementer' }), /another existing default/);
  assert.throws(() => planRoleChange({ root, action: 'delete', id: 'implementer', defaultRole: 'missing' }), /another existing default/);
  applyRoleChange(planRoleChange({ root, action: 'delete', id: 'researcher' }));
  assert.ok(!readConfiguration(root).configuration.get('roles').has('researcher'));
  applyRoleChange(planRoleChange({ root, action: 'delete', id: 'implementer', defaultRole: 'reviewer' }));
  assert.equal(resolveInstructions({ root }).role, 'reviewer');
  assert.deepEqual(snapshot(root).filter(([file]) => file !== path.normalize(configFile)), files);
  assert.throws(() => planRoleChange({ root, action: 'delete', id: 'reviewer', defaultRole: 'reviewer' }), /another existing default/);
});

test('invalid references and collisions fail before any configuration or role file is written', t => {
  const root = repository(t);
  const before = snapshot(root);
  for (const input of [
    { required: ['missing'] }, { available: ['missing'] },
    { required: ['testing', 'testing'] }, { required: ['testing'], available: ['testing'] },
    { file: '../escape.md' }, { file: '/escape.md' }, { id: '../escape' },
    { required: [{ id: 'external', path: '../outside.md' }] },
    { id: 'reviewer' }, { description: 123 }, { required: 'testing' },
  ]) {
    assert.throws(() => planRoleChange({ root, action: 'create', id: 'new-role', ...input }));
    assert.deepEqual(snapshot(root), before);
  }
});

test('a stale preview and failed writes do not clobber concurrent edits or leave a new role file', t => {
  const root = repository(t);
  const plan = planRoleChange({ root, action: 'create', id: 'new-role' });
  fs.appendFileSync(path.join(root, configFile), '\n# Concurrent edit\n');
  const before = snapshot(root);
  assert.throws(() => applyRoleChange(plan), /changed after preview/);
  assert.deepEqual(snapshot(root), before);
  const current = planRoleChange({ root, action: 'create', id: 'new-role' });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === path.join(root, configFile)) throw new Error('simulated save failure');
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyRoleChange(current), /simulated save failure.*\nNo file changes retained/);
    assert.deepEqual(snapshot(root), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('aliased roles are detached for editing; defining anchors requires manual editing', t => {
  const root = repository(t);
  const file = path.join(root, configFile);
  const document = parseDocument(fs.readFileSync(file, 'utf8'));
  document.setIn(['roles', 'researcher'], document.createAlias(document.getIn(['roles', 'implementer'], true), 'shared'));
  fs.writeFileSync(file, document.toString());
  assert.throws(() => planRoleChange({ root, action: 'edit', id: 'implementer' }), /YAML anchor/);
  const original = readConfiguration(root).configuration.get('roles').get('implementer');
  applyRoleChange(planRoleChange({ root, action: 'edit', id: 'researcher', available: [] }));
  assert.deepEqual(readConfiguration(root).configuration.get('roles').get('implementer'), original);
  assert.deepEqual(resolveInstructions({ root, role: 'researcher' }).available, []);
});

test('the wizard creates, preselects edits, cancels, and safely deletes the default role', async t => {
  const root = repository(t);
  const create = prompts(['c', 'auditor', 'Inspect changes.', '', '1', '', '1', '', 'y', 'q']);
  await configureRoles({ root, ...create });
  assert.deepEqual(resolveInstructions({ root, role: 'auditor' }).required.map(item => item.id), ['code-review']);
  assert.deepEqual(resolveInstructions({ root, role: 'auditor' }).available.map(item => item.id), ['testing']);
  const before = snapshot(root);
  const edit = prompts(['e', 'auditor', '', '', '', '', 'y', 'q']);
  await configureRoles({ root, ...edit });
  assert.ok(edit.output.some(line => line.includes('[x] code-review')));
  assert.deepEqual(snapshot(root), before);
  const cancel = prompts(['c', 'cancelled', '', '', '', '', 'n', 'q']);
  await configureRoles({ root, ...cancel });
  assert.deepEqual(snapshot(root), before);
  const remove = prompts(['d', 'implementer', 'reviewer', 'y', 'q']);
  await configureRoles({ root, ...remove });
  assert.equal(resolveInstructions({ root }).role, 'reviewer');
  assert.ok(fs.existsSync(path.join(root, '.agent-profiles/roles/implementer.md')));
});

test('an empty skill catalog still supports creating a role through the wizard', async t => {
  const root = repository(t);
  const configuration = readConfiguration(root).configuration;
  for (const role of configuration.get('roles').values()) role.set('skills', new Map([['required', []], ['available', []]]));
  fs.writeFileSync(path.join(root, configFile), stringify(configuration));
  for (const id of ['testing', 'code-review']) fs.unlinkSync(path.join(root, `.agent-profiles/skills/${id}/SKILL.md`));
  const ui = prompts(['c', 'empty', '', '', 'y', 'q']);
  await configureRoles({ root, ...ui });
  assert.ok(ui.output.some(line => line.includes('No local skills were discovered')));
  assert.deepEqual(resolveInstructions({ root, role: 'empty' }).required, []);
  assert.deepEqual(resolveInstructions({ root, role: 'empty' }).available, []);
});

test('skill multi-select supports pages, filtering, toggles, defaults, and visible duplicate sources', async () => {
  const choices = Array.from({ length: 12 }, (_, i) => ({ id: `skill-${i}`, name: `Name ${i}`, description: '\x1b[31mDescription\x1b[0m', source: 'local', path: `skills/${i}/SKILL.md` }));
  const ui = prompts(['n', '1', '/skill-1', '1', 'clear', '/skill-11', '1', '']);
  const selected = await selectSkills({ choices, initial: [choices[0]], label: 'Skills', ...ui });
  assert.deepEqual(selected, [choices[11]]);
  assert.ok(ui.output.some(line => line.includes('page 2/2')));
  assert.ok(ui.output.every(line => !line.includes('\x1b')));
  const alternate = { ...choices[0], source: 'claude', path: '.claude/skills/skill-0/SKILL.md' };
  const duplicate = prompts(['2', '']);
  assert.deepEqual(await selectSkills({ choices: [choices[0], alternate], initial: [choices[0]], label: 'Skills', ...duplicate }), [alternate]);
});

test('configure fails clearly without an interactive terminal and never changes files', t => {
  const root = repository(t);
  const before = snapshot(root);
  const result = spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'configure', '--root', root], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /configure requires a terminal/);
  assert.deepEqual(snapshot(root), before);
});

test('source aliases skip reserved IDs and disappearing skill files fail before saving', t => {
  const root = repository(t);
  skill(root, 'testing-2', '.agent-profiles/skills');
  const external = skill(root, 'testing');
  const plan = planRoleChange({ root, action: 'create', id: 'qa', required: [external] });
  assert.equal(plan.aliases[0].id, 'testing-3');
  fs.unlinkSync(path.join(root, external.path));
  const before = snapshot(root);
  assert.throws(() => applyRoleChange(plan), /cannot access/);
  assert.deepEqual(snapshot(root), before);
});

test('preview rejects missing role paths through symlinked directories outside the repository', t => {
  const root = repository(t);
  const outside = repository(t);
  fs.symlinkSync(outside, path.join(root, '.agent-profiles/roles/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => planRoleChange({ root, action: 'create', id: 'unsafe', file: 'roles/escape/new.md' }), /linked/);
  assert.equal(fs.existsSync(path.join(outside, 'new.md')), false);
});
