import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { applyRoleChange, planRoleChange, readConfiguration } from '../src/configure.js';
import { discoverSkills } from '../src/skills.js';
import { resolveInstructions } from '../src/resolve.js';
import { planPresetExport, applyPresetExport, planPresetImport, applyPresetImport } from '../src/presets.js';
import { configureRoles, selectSkills } from '../src/wizard.js';

const project = fileURLToPath(new URL('../', import.meta.url));
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-external-integration-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home with spaces');
  fs.mkdirSync(root); fs.mkdirSync(home);
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
  const make = (directory, id) => write(path.join(directory, id, 'SKILL.md'), `---\nname: ${id}\ndescription: External ${id}.\n---\nNEVER-INJECT-THIS-BODY\n`);
  make(path.join(home, '.claude/skills'), 'release-notes');
  make(path.join(home, '.agents/skills'), 'audit');
  const sourcesFile = write(path.join(base, 'sources.json'), JSON.stringify({ version: 1, roots: [] }));
  const sourceOptions = { home, env: {}, sourcesFile };
  return { base, root, home, write, make, sourceOptions, sourcesFile };
}
const catalog = f => discoverSkills(f.root, readConfiguration(f.root).configuration, { external: true, sourceOptions: f.sourceOptions });
const configText = root => fs.readFileSync(path.join(root, '.agent-profiles/agents.yaml'), 'utf8');

for (const [label, header, blocked] of [
  ['missing', 'description: Project audit.', false],
  ['padded', "name: ' audit '\ndescription: Project audit.", false],
  ['exact', 'name: audit\ndescription: Project audit.', true],
]) {
  test(`Codex project collision requires exact frontmatter name: ${label}`, t => {
    const f = fixture(t);
    f.write(path.join(f.root, '.agents/skills/audit/SKILL.md'), `---\n${header}\n---\nProject body.\n`);
    const found = catalog(f);
    const selected = found.skills.find(s => s.host === 'codex' && s.scope === 'user');
    assert.equal(selected.selectable, !blocked);
    assert.equal(selected.availability, blocked ? 'ambiguous' : 'metadata-found');
    const input = { root: f.root, action: 'create', id: 'collision-probe', required: [selected], sourceOptions: f.sourceOptions };
    if (blocked) assert.throws(() => planRoleChange(input), /ambiguous|selectable/i);
    else applyRoleChange(planRoleChange(input));
  });
}

for (const stage of ['before preview', 'before save']) {
  for (const mutation of ['name', 'description', 'junction']) {
    test(`Claude project fingerprint rejects ${mutation} change ${stage} without writes`, t => {
      const f = fixture(t);
      const original = f.make(path.join(f.root, 'targets'), 'original');
      const replacement = f.make(path.join(f.root, 'targets'), 'replacement');
      // Same metadata: a canonical target change alone must invalidate the selection.
      fs.copyFileSync(original, replacement);
      const link = path.join(f.root, '.claude/skills/project-audit');
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.dirname(original), link, process.platform === 'win32' ? 'junction' : 'dir');
      const selected = catalog(f).skills.find(s => s.host === 'claude' && s.scope === 'project');
      assert.equal(selected.hostId, 'project-audit');
      const before = configText(f.root);
      // No source options: repository validation must not depend on external opt-in.
      const input = { root: f.root, action: 'create', id: 'fingerprint-probe', required: [selected] };
      const plan = stage === 'before save' ? planRoleChange(input) : null;
      if (mutation === 'junction') {
        fs.unlinkSync(link);
        fs.symlinkSync(path.dirname(replacement), link, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        fs.writeFileSync(original, fs.readFileSync(original, 'utf8').replace(
          mutation === 'name' ? 'name: original' : 'description: External original.',
          mutation === 'name' ? 'name: changed' : 'description: Changed metadata.',
        ));
      }
      assert.throws(() => stage === 'before save' ? applyRoleChange(plan) : planRoleChange(input), /changed|repoint|inventory|refresh/i);
      assert.equal(configText(f.root), before);
      assert.ok(!fs.existsSync(path.join(f.root, '.agent-profiles/roles/fingerprint-probe.md')));
    });
  }
}

test('Claude project fingerprint permits optional description and body-only edits while keeping logical identity', t => {
  const f = fixture(t);
  const target = f.write(path.join(f.root, 'targets/metadata/SKILL.md'), '---\nname: Display name\n---\nOriginal body.\n');
  const link = path.join(f.root, '.claude/skills/project-audit');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.dirname(target), link, process.platform === 'win32' ? 'junction' : 'dir');
  const selected = catalog(f).skills.find(s => s.host === 'claude' && s.scope === 'project');
  assert.equal(selected.hostId, 'project-audit');
  assert.equal(selected.description, null);
  const plan = planRoleChange({ root: f.root, action: 'create', id: 'fingerprint-control', required: [selected] });
  fs.appendFileSync(target, 'Changed body only.\n');
  applyRoleChange(plan);
  assert.deepEqual(parse(configText(f.root)).skills[selected.id], { host: 'claude', scope: 'project' });
  fs.unlinkSync(path.join(link, 'SKILL.md'));
  f.write(path.join(link, 'SKILL.md'), '---\nname: Different display\n---\nBody.\n');
  applyRoleChange(planRoleChange({ root: f.root, action: 'edit', id: 'fingerprint-control' }));
});

test('internal Claude directory aliases cannot conceal personal shadowing of a project skill', t => {
  const f = fixture(t);
  const personalRoot = path.join(f.home, '.claude/skills');
  fs.symlinkSync(path.join(personalRoot, 'release-notes'), path.join(personalRoot, 'aaa'), process.platform === 'win32' ? 'junction' : 'dir');
  f.make(path.join(f.root, '.claude/skills'), 'release-notes');
  const found = catalog(f);
  const projectSkill = found.skills.find(s => s.host === 'claude' && s.scope === 'project' && s.hostId === 'release-notes');
  const before = configText(f.root);
  assert.throws(() => planRoleChange({ root: f.root, action: 'create', id: 'shadow-probe', required: [projectSkill], sourceOptions: f.sourceOptions }), /shadow|not selectable|ambiguous/i);
  assert.equal(configText(f.root), before);
  assert.ok(!fs.existsSync(path.join(f.root, '.agent-profiles/roles/shadow-probe.md')));
  const personal = found.skills.filter(s => s.host === 'claude' && s.scope === 'user');
  assert.deepEqual(personal.map(s => s.hostId).sort(), ['aaa', 'release-notes']);
  assert.equal(new Set(personal.map(s => s.path)).size, 1);
  const original = personal.find(s => s.hostId === 'release-notes');
  applyRoleChange(planRoleChange({ root: f.root, action: 'create', id: 'personal-probe', available: [original], sourceOptions: f.sourceOptions }));
  assert.equal(resolveInstructions({ root: f.root, role: 'personal-probe' }).available[0].hostId, 'release-notes');
});


test('Codex user references resolve natively, remain host-scoped and exclude native bodies from measurements', t => {
  const f = fixture(t);
  const plan = planRoleChange({ root: f.root, action: 'create', id: 'auditor', required: [{ id: 'codex-audit', host: 'codex', scope: 'user', hostId: 'audit' }] });
  applyRoleChange(plan);
  const result = resolveInstructions({ root: f.root, role: 'auditor', host: 'codex' });
  assert.equal(result.required[0].delivery, 'invoke');
  assert.equal(result.required[0].verification, 'host-provided');
  assert.equal(result.required[0].bytes, null);
  assert.deepEqual(result.unsatisfied, []);
  assert.ok(!JSON.stringify(result).includes('NEVER-INJECT'));
  assert.equal(resolveInstructions({ root: f.root, role: 'auditor', host: 'hermes' }).unsatisfied.length, 1);
  assert.equal(resolveInstructions({ root: f.root, role: 'auditor', host: 'claude' }).unsatisfied.length, 1);
});

test('external selection stores portable bindings, round-trips presets and retains configured aliases', t => {
  const f = fixture(t);
  const found = catalog(f);
  const claude = found.skills.find(s => s.host === 'claude' && s.scope === 'user');
  const codex = found.skills.find(s => s.host === 'codex' && s.scope === 'user');
  assert.ok(claude && codex);
  const plan = planRoleChange({ root: f.root, action: 'create', id: 'external', required: [claude], available: [codex], sourceOptions: f.sourceOptions });
  applyRoleChange(plan);
  const text = configText(f.root);
  assert.ok(!text.includes(f.home));
  assert.ok(!text.includes('SKILL.md') || !text.includes('home with spaces'));
  assert.deepEqual(parse(text).skills[claude.id], { host: 'claude', scope: 'user', id: 'release-notes' });
  assert.equal(catalog(f).skills.filter(s => s.host === 'claude' && s.hostId === 'release-notes').length, 1);
  const destination = path.join(f.base, 'export');
  const metadata = { name: 'external', display_name: 'External', description: 'Native references.', author: 'Test', version: '1.0.0', license: 'MIT' };
  applyPresetExport(planPresetExport({ root: f.root, destination, roles: ['external'], profiles: [], metadata }), true);
  const manifest = fs.readFileSync(path.join(destination, 'preset.yaml'), 'utf8');
  assert.ok(!manifest.includes(f.home));
  assert.ok(!manifest.includes('NEVER-INJECT'));
  const target = path.join(f.base, 'second-repo'); fs.mkdirSync(target);
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(target, '.agent-profiles'), { recursive: true });
  const imported = planPresetImport({ root: target, source: destination });
  assert.ok(imported.notices.some(note => /codex/i.test(note)));
  applyPresetImport(imported, true);
  assert.equal(resolveInstructions({ root: target, role: 'external' }).available[0].hostId, 'audit');
  fs.rmSync(f.home, { recursive: true }); fs.mkdirSync(f.home);
  const missing = discoverSkills(target, readConfiguration(target).configuration, { external: true, sourceOptions: f.sourceOptions });
  const reference = missing.skills.find(s => s.id === claude.id);
  assert.equal(reference.availability, 'not-found');
  assert.equal(reference.path, null);
  applyRoleChange(planRoleChange({ root: target, action: 'edit', id: 'external' }));
  assert.equal(resolveInstructions({ root: target, role: 'external' }).required[0].hostId, 'release-notes');
});

test('missing and changed external selections fail before writes, including after preview', t => {
  const f = fixture(t);
  const selected = catalog(f).skills.find(s => s.host === 'codex');
  assert.ok(selected);
  const before = configText(f.root);
  const input = { root: f.root, action: 'create', id: 'external', required: [selected], sourceOptions: f.sourceOptions };
  const plan = planRoleChange(input);
  fs.unlinkSync(selected.path);
  assert.throws(() => planRoleChange(input), /external|missing|disappear|inventory/i);
  assert.throws(() => applyRoleChange(plan), /external|missing|disappear|inventory/i);
  assert.equal(configText(f.root), before);
  assert.ok(!fs.existsSync(path.join(f.root, '.agent-profiles/roles/external.md')));
});

test('Claude user shadowing and Codex duplicate native names block non-addressable project/user choices', t => {
  const f = fixture(t);
  f.make(path.join(f.root, '.claude/skills'), 'release-notes');
  f.make(path.join(f.root, '.agents/skills'), 'audit');
  const found = catalog(f);
  const projectSkill = found.skills.find(s => s.host === 'claude' && s.scope === 'project');
  const personal = found.skills.find(s => s.host === 'claude' && s.scope === 'user');
  const codex = found.skills.find(s => s.host === 'codex' && s.scope === 'user');
  assert.equal(projectSkill.selectable, false);
  assert.equal(personal.selectable, true);
  assert.equal(codex.selectable, false);
  assert.match(found.warnings.join('\n'), /shadow|ambigu|conflict/i);
  assert.throws(() => planRoleChange({ root: f.root, action: 'create', id: 'blocked', required: [projectSkill], sourceOptions: f.sourceOptions }), /shadow|ambigu|selectable/i);
  // The selector must not allow a blocked source to enter a new plan.
  assert.equal(found.skills.filter(s => s.selectable !== false).includes(projectSkill), false);

});

test('external wizard preselection retains aliases and a configured opaque plugin remains editable', async t => {
  const f = fixture(t);
  const skill = catalog(f).skills.find(s => s.host === 'codex');
  applyRoleChange(planRoleChange({ root: f.root, action: 'create', id: 'external', required: [skill], sourceOptions: f.sourceOptions }));
  const before = configText(f.root);
  const answers = ['e', 'external', '', '', '', '', 'y', 'q'];
  const output = [];
  await configureRoles({ root: f.root, external: true, sourceOptions: f.sourceOptions, ask: async () => { assert.ok(answers.length); return answers.shift(); }, write: text => output.push(text) });
  assert.equal(configText(f.root), before);
  assert.ok(output.some(line => line.includes(`[x] ${skill.id}`)));
  const config = parse(before);
  config.skills['opaque-lint'] = { host: 'claude', scope: 'plugin', id: 'toolkit:lint' };
  config.roles.external.skills.available = ['opaque-lint'];
  fs.writeFileSync(path.join(f.root, '.agent-profiles/agents.yaml'), stringify(config));
  const found = catalog(f).skills.find(s => s.id === 'opaque-lint');
  assert.equal(found.availability, 'host-provided-unverified');
  assert.equal(found.path, null);
  applyRoleChange(planRoleChange({ root: f.root, action: 'edit', id: 'external', available: [found] }));
  assert.equal(resolveInstructions({ root: f.root, role: 'external' }).available[0].hostId, 'toolkit:lint');
});

test('picker shows scope/status, includes source-aware filtering and refuses disabled toggles', async () => {
  const disabled = { id: 'blocked', name: 'Blocked', description: 'Metadata.', host: 'codex', hostId: 'audit', scope: 'user', source: 'codex-user', path: '/skills/audit/SKILL.md', availability: 'ambiguous', selectable: false };
  const enabled = { ...disabled, id: 'safe', host: 'claude', hostId: 'safe', selectable: true, availability: 'metadata-found' };
  const answers = ['1', '/claude', '1', '']; const output = [];
  const selected = await selectSkills({ choices: [disabled, enabled], label: 'Skills', ask: async () => answers.shift(), write: text => output.push(text) });
  assert.deepEqual(selected, [enabled]);
  assert.ok(output.some(line => /user.*metadata-found|metadata-found.*user/.test(line)));
  assert.ok(output.some(line => /cannot select|not selectable|blocked|ambiguous/i.test(line)));
});

test('metadata inventory CLI is read-only JSON, validates flag scope and exposes opted-in sources', t => {
  const f = fixture(t);
  const file = path.join(project, 'bin/agent-profiles.js');
  const preferences = { version: 1, roots: [{ host: 'claude', scope: 'user', path: path.join(f.home, '.claude/skills') }, { host: 'codex', scope: 'user', path: path.join(f.home, '.agents/skills') }] };
  f.write(f.sourcesFile, JSON.stringify(preferences));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(f.base, 'empty-claude'), AGENT_PROFILES_SKILL_SOURCES: f.sourcesFile };
  const before = configText(f.root);
  const result = spawnSync(process.execPath, [file, 'skills', '--root', f.root, '--external', '--json', '--sources', f.sourcesFile], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const found = JSON.parse(result.stdout);
  assert.ok(found.skills.some(s => s.host === 'codex' && s.scope === 'user'));
  assert.ok(!JSON.stringify(found).includes('NEVER-INJECT'));
  assert.equal(configText(f.root), before);
  assert.equal(spawnSync(process.execPath, [file, 'resolve', '--root', f.root, '--sources', f.sourcesFile], { encoding: 'utf8' }).status, 1);
});
