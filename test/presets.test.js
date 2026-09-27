import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { applyPresetExport, applyPresetImport, planPresetExport, planPresetImport, readPreset } from '../src/presets.js';
import { runPreset } from '../src/preset-wizard.js';
import { resolveInstructions } from '../src/resolve.js';
import { applyRoleChange, planRoleChange } from '../src/configure.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const metadata = { name: 'team', display_name: 'Team', description: 'Example team.', author: 'A team', version: '1.0.0', license: 'Apache-2.0' };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-presets-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('agent-profiles-presets-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const root = path.join(directory, 'repo with spaces');
  const source = path.join(directory, 'preset');
  fs.mkdirSync(root);
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  fs.cpSync(path.join(project, 'examples/presets/release-review'), source, { recursive: true });
  return { directory, root, source };
}
function manifest(source, change) {
  const file = path.join(source, 'preset.yaml');
  const data = parse(fs.readFileSync(file, 'utf8'));
  change(data);
  fs.writeFileSync(file, stringify(data));
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(root, file), fs.readFileSync(file).toString('base64')];
  }).sort(([a], [b]) => a.localeCompare(b));
}
function prompts(answers) {
  const output = [];
  return { output, write: line => output.push(line), ask: async () => { assert.ok(answers.length, 'unexpected prompt'); return answers.shift(); } };
}

test('inspect is read-only; imported roles, profile routing, skill loading, provenance and later wizard edits work', async t => {
  const { root, source } = fixture(t);
  const before = snapshot(root);
  const io = prompts([]);
  await runPreset({ command: 'inspect', location: source, root, ...io });
  assert.match(io.output.join('\n'), /Release Review.*\nBy Agent Profiles contributors/);
  assert.match(io.output.join('\n'), /Skills required locally: testing/);
  assert.doesNotMatch(io.output.join('\n'), /Compare the proposed release against/);
  assert.deepEqual(snapshot(root), before);
  const plan = planPresetImport({ root, source });
  assert.equal(plan.ready, true, plan.errors.join('\n'));
  assert.deepEqual(snapshot(root), before);
  assert.throws(() => applyPresetImport(plan), /confirmation/);
  applyPresetImport(plan, true);
  const result = resolveInstructions({ root, role: 'release-reviewer', family: 'example-release-family' });
  assert.equal(result.profile, 'release-scaffolded');
  assert.deepEqual(result.required.map(skill => skill.id), ['release-checklist']);
  assert.deepEqual(result.available.map(skill => skill.id), ['testing']);
  assert.equal(result.loaded.length, 3);
  assert.equal(resolveInstructions({ root, role: 'release-reviewer', skills: ['testing'] }).loaded.length, 4);
  const origin = parse(fs.readFileSync(path.join(root, '.agent-profiles/preset-origins.yaml'), 'utf8'));
  assert.equal(origin['roles.release-reviewer'].preset, 'release-review');
  assert.equal(origin['skills.release-checklist'].version, '1.0.0');
  applyRoleChange(planRoleChange({ root, action: 'edit', id: 'release-reviewer', description: 'Customized by the team.' }));
  assert.equal(resolveInstructions({ root, role: 'release-reviewer' }).role, 'release-reviewer');
});

test('manifest validation rejects unsupported schemas, hooks, bad paths, missing metadata and undeclared skills', t => {
  const { root, source } = fixture(t);
  const file = path.join(source, 'preset.yaml');
  const original = fs.readFileSync(file);
  const before = snapshot(root);
  for (const change of [
    data => { data.schema_version = 99; },
    data => { data.hooks = { postinstall: 'touch SHOULD-NOT-EXIST' }; },
    data => { delete data.preset.license; },
    data => { data.roles['release-reviewer'].file = '../outside.md'; },
    data => { data.roles['release-reviewer'].file = 'C:/outside.md'; },
    data => { data.roles['release-reviewer'].file = 'roles\\reviewer.md'; },
    data => { data.roles['release-reviewer'].skills.required.push('missing-declaration'); },
    data => { data.skills.requires.push('release-checklist'); },
    data => { data.roles['release-reviewer'].skills.available.push('release-checklist'); },
    data => { data.roles['release-reviewer'].profiles = {}; },
  ]) {
    fs.writeFileSync(file, original);
    manifest(source, change);
    assert.throws(() => readPreset(source));
    assert.deepEqual(snapshot(root), before);
  }
  fs.writeFileSync(file, 'schema_version: 1\nschema_version: 1\n');
  assert.throws(() => readPreset(source), /unique/);
  fs.writeFileSync(file, 'roles: [');
  assert.throws(() => readPreset(source));
  fs.writeFileSync(file, original);
  fs.writeFileSync(path.join(source, 'postinstall.js'), 'throw new Error("must never execute");');
  applyPresetImport(planPresetImport({ root, source }), true);
  assert.ok(!snapshot(root).some(([file]) => file.endsWith('postinstall.js')));
});

test('missing dependencies block import without dropping available or required skills; partial selection excludes unrelated dependencies', t => {
  const { root, source } = fixture(t);
  manifest(source, data => {
    data.skills.requires.push('missing');
    data.roles.other = { file: 'roles/release-reviewer.md', skills: { required: ['missing'], available: [] } };
  });
  const before = snapshot(root);
  const all = planPresetImport({ root, source });
  assert.equal(all.ready, false);
  assert.match(all.errors.join('\n'), /Skill missing.*no download/);
  assert.throws(() => applyPresetImport(all, true), /dependencies/);
  assert.deepEqual(snapshot(root), before);
  const partial = planPresetImport({ root, source, roles: ['release-reviewer'] });
  assert.equal(partial.ready, true);
  applyPresetImport(partial, true);
  assert.throws(() => resolveInstructions({ root, role: 'other' }), /not declared/);
});

test('conflicts require decisions; keep is exact, replacement is explicit, and rename rewrites only incoming references', t => {
  const { root, source } = fixture(t);
  applyPresetImport(planPresetImport({ root, source }), true);
  const before = snapshot(root);
  const conflict = planPresetImport({ root, source });
  assert.deepEqual(conflict.conflicts.map(item => item.key).sort(), ['profiles.release-scaffolded', 'roles.release-reviewer', 'skills.release-checklist']);
  assert.throws(() => applyPresetImport(conflict, true), /conflicts/);
  const keep = new Map([['roles.release-reviewer', 'keep'], ['profiles.release-scaffolded', 'keep']]);
  assert.deepEqual(applyPresetImport(planPresetImport({ root, source, decisions: keep }), true), []);
  assert.deepEqual(snapshot(root), before);
  fs.appendFileSync(path.join(source, 'roles/release-reviewer.md'), '\nChanged preset instructions.');
  const rename = new Map([
    ['roles.release-reviewer', 'rename:release-v2'], ['skills.release-checklist', 'rename:checklist-v2'],
    ['profiles.release-scaffolded', 'rename:scaffolding-v2'], ['families.example-release-family', 'replace'],
  ]);
  const plan = planPresetImport({ root, source, decisions: rename });
  assert.equal(plan.ready, true, plan.errors.join('\n'));
  applyPresetImport(plan, true);
  const result = resolveInstructions({ root, role: 'release-v2', family: 'example-release-family' });
  assert.equal(result.profile, 'scaffolding-v2');
  assert.equal(result.required[0].id, 'checklist-v2');
  assert.match(result.loaded[1].content, /Changed preset instructions/);
  assert.doesNotMatch(resolveInstructions({ root, role: 'release-reviewer' }).loaded[1].content, /Changed preset instructions/);
  const replace = new Map([['roles.release-reviewer', 'replace'], ['skills.release-checklist', 'keep'], ['profiles.release-scaffolded', 'keep'], ['families.example-release-family', 'keep']]);
  applyPresetImport(planPresetImport({ root, source, decisions: replace }), true);
  assert.match(resolveInstructions({ root, role: 'release-reviewer' }).loaded[1].content, /Changed preset instructions/);
});

test('model mappings, defaults and existing YAML comments are preserved unless explicitly changed', t => {
  const { root, source } = fixture(t);
  const config = path.join(root, '.agent-profiles/agents.yaml');
  fs.writeFileSync(config, '\uFEFF# Keep my comment\r\n' + fs.readFileSync(config, 'utf8').replace(/\r?\n/g, '\r\n'));
  manifest(source, data => {
    data.models = { 'example-model': { profile: 'release-scaffolded' } };
    data.defaults = { profile: 'release-scaffolded', role: 'release-reviewer' };
  });
  const plan = planPresetImport({ root, source });
  assert.ok(plan.conflicts.some(item => item.key === 'models.example-model'));
  const decisions = new Map([['models.example-model', 'keep']]);
  applyPresetImport(planPresetImport({ root, source, decisions }), true);
  assert.equal(resolveInstructions({ root, model: 'example-model' }).profile, 'autonomous');
  assert.equal(resolveInstructions({ root }).role, 'implementer');
  assert.match(fs.readFileSync(config, 'utf8'), /^\uFEFF# Keep my comment\r\n/);
  decisions.set('models.example-model', 'replace');
  decisions.set('roles.release-reviewer', 'keep');
  decisions.set('profiles.release-scaffolded', 'keep');
  applyPresetImport(planPresetImport({ root, source, decisions, useDefaults: true }), true);
  assert.equal(resolveInstructions({ root }).role, 'release-reviewer');
  assert.equal(resolveInstructions({ root, model: 'example-model' }).profile, 'release-scaffolded');
});

test('source changes, target edits, and linked paths are rejected without writes', t => {
  const { root, source, directory } = fixture(t);
  const plan = planPresetImport({ root, source });
  fs.appendFileSync(path.join(source, 'roles/release-reviewer.md'), '\nChanged.');
  const before = snapshot(root);
  assert.throws(() => applyPresetImport(plan, true), /preset changed/);
  assert.deepEqual(snapshot(root), before);
  const next = planPresetImport({ root, source });
  fs.appendFileSync(path.join(root, '.agent-profiles/agents.yaml'), '\n# Concurrent edit\n');
  assert.throws(() => applyPresetImport(next, true), /changed after preview/);
  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'escape.md'), 'Outside instructions');
  fs.symlinkSync(outside, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest(source, data => { data.roles['release-reviewer'].file = 'linked/escape.md'; });
  assert.throws(() => readPreset(source), /outside|linked/);
  fs.symlinkSync(outside, path.join(root, '.agent-profiles/skills/release-checklist'), process.platform === 'win32' ? 'junction' : 'dir');
  manifest(source, data => { data.roles['release-reviewer'].file = 'roles/release-reviewer.md'; });
  assert.throws(() => planPresetImport({ root, source }), /linked/);
  assert.equal(fs.readFileSync(path.join(outside, 'escape.md'), 'utf8'), 'Outside instructions');
});

test('a failed import rolls back instructions, configuration and provenance together', t => {
  const { root, source } = fixture(t);
  const before = snapshot(root);
  const plan = planPresetImport({ root, source });
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === path.join(root, '.agent-profiles/preset-origins.yaml')) throw new Error('simulated failure');
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => applyPresetImport(plan, true), /simulated failure.*\nNo file changes retained/);
    assert.deepEqual(snapshot(root), before);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('export supports bundled and external skills, refuses overwrite, and round-trips ordinary configuration', t => {
  const { root, directory } = fixture(t);
  const destination = path.join(directory, 'export');
  const plan = planPresetExport({ root, destination, metadata, includeSkills: ['code-review', 'testing'] });
  assert.equal(fs.existsSync(destination), false);
  assert.throws(() => applyPresetExport(plan), /confirmation/);
  applyPresetExport(plan, true);
  const preset = readPreset(destination);
  assert.equal(preset.roles.size, 3);
  assert.deepEqual(preset.requires, []);
  assert.throws(() => planPresetExport({ root, destination, metadata }), /new directory/);
  const other = path.join(directory, 'other');
  fs.cpSync(root, other, { recursive: true });
  const decisions = new Map();
  for (const kind of ['roles', 'profiles']) for (const id of preset[kind].keys()) decisions.set(`${kind}.${id}`, 'replace');
  for (const id of preset.includes.keys()) decisions.set(`skills.${id}`, 'replace');
  applyPresetImport(planPresetImport({ root: other, source: destination, decisions, useDefaults: true }), true);
  for (const role of preset.roles.keys()) {
    assert.deepEqual(resolveInstructions({ root: other, role, model: 'example-model' }), resolveInstructions({ root, role, model: 'example-model' }));
  }
  const external = planPresetExport({ root, destination: path.join(directory, 'external'), metadata, roles: ['reviewer'], profiles: [], includeSkills: [] });
  applyPresetExport(external, true);
  assert.deepEqual(readPreset(path.join(directory, 'external')).requires.sort(), ['code-review', 'testing']);
  const stale = planPresetExport({ root, destination: path.join(directory, 'stale'), metadata });
  fs.appendFileSync(path.join(root, '.agent-profiles/roles/implementer.md'), '\nEdited.');
  assert.throws(() => applyPresetExport(stale, true), /changed after preview/);
  assert.equal(fs.existsSync(path.join(directory, 'stale')), false);
});

test('interactive import/export reuse selection, support cancellation and CLI inspection works without a Git root', async t => {
  const { root, source, directory } = fixture(t);
  const before = snapshot(root);
  await runPreset({ command: 'import', location: source, root, roles: ['release-reviewer'], ...prompts(['n']) });
  assert.deepEqual(snapshot(root), before);
  await runPreset({ command: 'import', location: source, root, ...prompts(['', 'y', 'y', 'q']) });
  assert.equal(resolveInstructions({ root, role: 'release-reviewer' }).role, 'release-reviewer');
  const imported = snapshot(root);
  await assert.rejects(runPreset({ command: 'import', location: source, root, roles: ['release-reviewer'],
    write: () => {}, ask: async () => { fs.appendFileSync(path.join(source, 'roles/release-reviewer.md'), '\nChanged during conflict selection.'); return 'keep'; },
  }), /changed while choosing/);
  assert.deepEqual(snapshot(root), imported);
  const destination = path.join(directory, 'interactive');
  await runPreset({ command: 'export', location: destination, root, roles: ['release-reviewer'], ...prompts(['', '', ...Object.values(metadata), 'y']) });
  assert.ok(readPreset(destination).roles.has('release-reviewer'));
  const cli = (...args) => spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), ...args], { cwd: directory, encoding: 'utf8' });
  const inspect = cli('preset', 'inspect', source, '--contents');
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.match(inspect.stdout, /Compare the proposed release against/);
  assert.match(inspect.stdout, /No changes have been made/);
  const canceled = snapshot(root);
  assert.equal(cli('preset', 'import', source, '--root', root).status, 1);
  assert.deepEqual(snapshot(root), canceled);
  assert.equal(cli('preset', 'inspect', source, '--delete-config').status, 1);
});
