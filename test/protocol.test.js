import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { applyRoleChange, planRoleChange, readConfiguration } from '../src/configure.js';
import { formatContext, formatProof } from '../src/diagnostics.js';
import { bootstrapAvailability, doctor, install, installPackage, uninstall } from '../src/install.js';
import { bootstrapBlock, END, START } from '../src/integrations.js';
import { applyPresetExport, applyPresetImport, planPresetExport, planPresetImport } from '../src/presets.js';
import { resolveInstructions } from '../src/resolve.js';
import { discoverSkills } from '../src/skills.js';

const project = fileURLToPath(new URL('../', import.meta.url));

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-protocol-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('agent-profiles-protocol-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  const configPath = path.join(root, '.agent-profiles/agents.yaml');
  return {
    root,
    change(edit) {
      const config = parse(fs.readFileSync(configPath, 'utf8'));
      edit(config);
      fs.writeFileSync(configPath, stringify(config));
    },
    write(file, content) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
  };
}

// Simulates `npm install --save-dev agent-profiles` so the bootstrap command is runnable.
function withPackage(root, version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version) {
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
  fs.mkdirSync(path.join(root, 'node_modules/agent-profiles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/agent-profiles/package.json'), JSON.stringify({ name: 'agent-profiles', version }));
  return root;
}

const claudeFamilies = config => {
  config.models = {
    'claude-opus-5-5': { profile: 'autonomous', aliases: ['claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0'] },
  };
  config.families = {
    claude: { profile: 'constrained', match: { prefixes: ['claude-'] } },
    haiku: { profile: 'scaffolded', match: { prefixes: ['claude-haiku-'] } },
    'example-family': { profile: 'scaffolded' },
  };
};

test('canonical models, aliases, and longest configured prefixes route deterministically with provenance', t => {
  const repo = repository(t);
  repo.change(claudeFamilies);
  const route = options => {
    const { profile, matchedBy, family, familySource, identity } = resolveInstructions({ root: repo.root, ...options });
    return { profile, matchedBy, family, familySource, identity };
  };
  assert.deepEqual(route({ model: 'claude-opus-5-5', identitySource: 'host' }), {
    profile: 'autonomous', matchedBy: 'model', family: null, familySource: null,
    identity: { raw: 'claude-opus-5-5', canonical: 'claude-opus-5-5', source: 'host', matchedBy: 'model' },
  });
  for (const alias of ['claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5-v1:0']) {
    const result = route({ model: alias });
    assert.equal(result.profile, 'autonomous');
    assert.deepEqual(result.identity, { raw: alias, canonical: 'claude-opus-5-5', source: null, matchedBy: 'alias' });
  }
  // The dated Haiku ID observed live matches the longer prefix, not the generic Claude rule.
  assert.deepEqual(route({ model: 'claude-haiku-4-5-20251001' }), {
    profile: 'scaffolded', matchedBy: 'family-prefix', family: 'haiku', familySource: 'configured-prefix',
    identity: { raw: 'claude-haiku-4-5-20251001', canonical: null, source: null, matchedBy: 'family-prefix' },
  });
  assert.equal(route({ model: 'claude-sonnet-5' }).family, 'claude');
  // A supplied family outranks a derived prefix; exact model and alias outrank both.
  assert.deepEqual(route({ model: 'claude-sonnet-5', family: 'example-family' }).familySource, 'supplied');
  assert.equal(route({ model: 'claude-sonnet-5', family: 'example-family' }).matchedBy, 'family');
  assert.equal(route({ model: 'claude-opus-5-5[1m]', family: 'example-family' }).matchedBy, 'alias');
  // Matching is case-sensitive and never guesses display names.
  assert.equal(route({ model: 'Claude-Sonnet-5' }).matchedBy, 'default');
  assert.equal(route({ model: 'Opus 5.5' }).matchedBy, 'default');
});

test('missing identity uses the fallback without inventing a source or family', t => {
  const repo = repository(t);
  repo.change(claudeFamilies);
  const result = resolveInstructions({ root: repo.root });
  assert.equal(result.profile, 'constrained');
  assert.deepEqual(result.identity, { raw: null, canonical: null, source: null, matchedBy: 'default' });
  assert.equal(result.family, null);
  assert.throws(() => resolveInstructions({ root: repo.root, identitySource: 'guess' }), /identitySource/);
});

test('alias and prefix collisions fail instead of picking a route', async t => {
  const cases = [
    [config => { config.models = { a: { profile: 'autonomous', aliases: ['b'] }, b: { profile: 'constrained' } }; }, /models.a.aliases: alias b shadows the configured model b/],
    [config => { config.models = { a: { profile: 'autonomous', aliases: ['x'] }, b: { profile: 'constrained', aliases: ['x'] } }; }, /alias x is also an alias of models.a/],
    [config => { config.models = { a: { profile: 'autonomous', aliases: ['x', 'x'] } }; }, /models.a.aliases: duplicate/],
    [config => { config.models = { a: { profile: 'autonomous', aliases: [''] } }; }, /models.a.aliases: expected a list of nonempty strings/],
    [config => { config.families = { one: { profile: 'autonomous', match: { prefixes: ['claude-'] } }, two: { profile: 'constrained', match: { prefixes: ['claude-'] } } }; }, /families.two.match.prefixes: prefix claude- is also used by families.one/],
    [config => { config.families = { one: { profile: 'autonomous', match: { patterns: ['claude-*'] } } }; }, /families.one.match.patterns: unknown field/],
  ];
  for (const [index, [edit, error]] of cases.entries()) {
    await t.test(`collision case ${index + 1}`, t => {
      const repo = repository(t);
      repo.change(edit);
      assert.throws(() => resolveInstructions({ root: repo.root }), error);
    });
  }
  const repo = repository(t);
  repo.change(config => { config.models = { a: { profile: 'autonomous', aliases: ['a', 'a-dated'] } }; });
  assert.equal(resolveInstructions({ root: repo.root, model: 'a-dated' }).matchedBy, 'alias');
});

test('host-native skills resolve as host capabilities, are never injected, and are not counted', t => {
  const repo = repository(t);
  repo.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Check release notes.\n---\nHOST-SKILL-BODY\n');
  repo.write('.claude/skills/bare/SKILL.md', '---\nallowed-tools: Read\n---\nBARE-BODY\n');
  repo.change(config => {
    config.skills = { 'release-notes': { host: 'claude', scope: 'project' }, bare: { host: 'claude', scope: 'project' }, lint: { host: 'claude', scope: 'plugin', id: 'toolkit:lint' } };
    config.roles.reviewer.skills.required.push('release-notes');
    config.roles.reviewer.skills.available.push('bare', 'lint');
  });
  const result = resolveInstructions({ root: repo.root, role: 'reviewer', skills: ['lint'] });
  assert.ok(result.loaded.every(entry => !entry.content.includes('HOST-SKILL-BODY')));
  assert.deepEqual(result.loaded.map(entry => entry.id), ['constrained', 'reviewer', 'code-review']);
  const notes = result.required.find(skill => skill.id === 'release-notes');
  assert.deepEqual(notes, {
    id: 'release-notes', type: 'host', host: 'claude', hostId: 'release-notes', scope: 'project', delivery: 'invoke',
    name: 'release-notes', nameSource: 'directory', description: 'Check release notes.',
    path: '.claude/skills/release-notes/SKILL.md', verification: 'verified-local', bytes: null, characters: null, usable: null,
  });
  // Host metadata rules: no name falls back to the directory, and description is optional.
  assert.deepEqual(result.available.find(skill => skill.id === 'bare').description, null);
  assert.equal(result.available.find(skill => skill.id === 'lint').verification, 'host-provided');
  const { diagnostics } = result;
  assert.deepEqual(diagnostics.availableNotLoaded, { files: 1, bytes: result.available[0].bytes, characters: result.available[0].characters });
  assert.deepEqual(diagnostics.hostSkills.map(skill => [skill.id, skill.requirement, skill.verification]),
    [['release-notes', 'required', 'verified-local'], ['bare', 'available', 'verified-local'], ['lint', 'available', 'host-provided']]);
  assert.ok(diagnostics.excluded.includes('host-native-skills'));
  const context = formatContext(result);
  assert.match(context, /## Required host skills\n\nUse each for all work in this role:\n- release-notes: Invoke the claude skill `release-notes`/);
  assert.match(context, /- lint Invoke the claude skill `toolkit:lint`/);
  assert.match(formatProof(result), /lint \(claude: toolkit:lint\)  available; host-provided/);
});

test('host skill references validate host, identifier, and conflicts with local skills', async t => {
  const cases = [
    [config => { config.skills = { x: { host: 'codex', scope: 'project' } }; }, /skills.x.host: expected a host with native skills: claude/],
    [config => { config.skills = { x: { host: 'claude', scope: 'project', id: 'Bad Name' } }; }, /skills.x.id: expected a Claude Code project skill identifier/],
    [config => { config.skills = { x: { host: 'claude', file: 'a.md' } }; }, /skills.x.file: unknown field/],
    [config => { config.skills = { testing: { host: 'claude', scope: 'project' } }; }, /ambiguous skill testing: .agent-profiles\/skills\/testing\/SKILL.md exists and skills.testing names a host skill/],
  ];
  for (const [index, [edit, error]] of cases.entries()) {
    await t.test(`host reference case ${index + 1}`, t => {
      const repo = repository(t);
      repo.change(edit);
      assert.throws(() => resolveInstructions({ root: repo.root }), error);
    });
  }
});

test('local skills without name use the directory name; errors show repository-relative paths', t => {
  const repo = repository(t);
  repo.write('.agent-profiles/skills/testing/SKILL.md', '---\ndescription: No name here.\n---\nBody\n');
  const skill = resolveInstructions({ root: repo.root }).available[0];
  assert.deepEqual([skill.name, skill.nameSource], ['testing', 'directory']);
  repo.write('.agent-profiles/skills/testing/SKILL.md', '---\nname: Testing\n---\nBody\n');
  assert.throws(() => resolveInstructions({ root: repo.root }), error => {
    assert.match(error.message, /\.agent-profiles\/skills\/testing\/SKILL\.md: .*frontmatter\.description/);
    assert.ok(!error.message.includes(repo.root), error.message);
    return true;
  });
});

test('Claude skill discovery and configuration keep host identity instead of creating aliases', t => {
  const repo = repository(t);
  repo.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Check release notes.\n---\nBody\n');
  repo.write('.claude/skills/testing/SKILL.md', '---\nname: testing\ndescription: Host testing.\n---\nBody\n');
  const { skills, warnings } = discoverSkills(repo.root, readConfiguration(repo.root).configuration);
  assert.deepEqual(warnings, []);
  const notes = skills.find(skill => skill.id === 'release-notes');
  assert.deepEqual([notes.host, notes.hostId, notes.name, notes.source], ['claude', 'release-notes', 'release-notes', 'claude']);
  const plan = planRoleChange({ root: repo.root, action: 'create', id: 'writer', available: [notes] });
  assert.deepEqual(plan.aliases, []);
  applyRoleChange(plan);
  assert.deepEqual(parse(fs.readFileSync(path.join(repo.root, '.agent-profiles/agents.yaml'), 'utf8')).skills, { 'release-notes': { host: 'claude', scope: 'project' } });
  assert.equal(resolveInstructions({ root: repo.root, role: 'writer' }).available[0].type, 'host');
  // Editing the role again keeps the same reference.
  applyRoleChange(planRoleChange({ root: repo.root, action: 'edit', id: 'writer' }));
  const hostTesting = skills.find(skill => skill.id === 'testing' && skill.host);
  assert.throws(() => planRoleChange({ root: repo.root, action: 'create', id: 'qa', required: [hostTesting] }),
    /testing already names another skill, so the claude skill testing cannot use it; rename one of them first/);
});

test('bootstrap block routes through the resolver and never asks the model to route by hand', () => {
  const block = bootstrapBlock('claude').toString('utf8');
  assert.ok(block.startsWith(START) && block.endsWith(END));
  assert.match(block, /npx --no agent-profiles resolve --host claude --model "<exact model ID>"/);
  assert.match(block, /This block is for Claude Code; agents in other hosts skip it/);
  assert.match(block, /new or compacted context, and after a model change/);
  assert.match(bootstrapBlock('codex').toString('utf8'), /resolve --host codex --model/);
  assert.match(block, /not a display name, another model's ID, or your own\nrecollection/);
  assert.match(block, /do not read `\.agent-profiles\/` to route by hand/);
  assert.doesNotMatch(block, /run once|BOOTSTRAP\.md|agents\.yaml/);
});

test('resolve prints agent context with supersession and re-run guidance', t => {
  const repo = repository(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'resolve', '--root', repo.root, ...args], { encoding: 'utf8' });
  const assigned = run('--model', 'example-model', '--role', 'reviewer');
  assert.equal(assigned.status, 0, assigned.stderr);
  assert.ok(assigned.stdout.startsWith('# Agent Profiles context'));
  assert.match(assigned.stdout, /supersedes Agent Profiles profile, role, and skill instructions from any earlier run/);
  assert.match(assigned.stdout, /## Required skill: code-review/);
  assert.match(assigned.stdout, /- testing — Verify changed behavior .* Read `\.agent-profiles\/skills\/testing\/SKILL\.md`\./);
  assert.doesNotMatch(assigned.stdout, /# Testing/);
  assert.match(assigned.stdout, /Command: `npx --no agent-profiles resolve --model "example-model" --role reviewer`/);
  const unassigned = run();
  assert.match(unassigned.stdout, /Command: `npx --no agent-profiles resolve`/);
  const failure = run('--role', 'missing');
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.equal(run('--identity-source', 'guess').status, 1);
  assert.equal(run('--contents').status, 1);
});

test('init replaces an outdated managed block in place and stays idempotent across integrations', t => {
  const repo = repository(t);
  const old = `# Rules\n\n${START}\n\nOld bootstrap text.\n\n${END}\n\nAfter the block.\n`;
  repo.write('CLAUDE.md', old);
  repo.write('AGENTS.md', '# Repository\n');
  const result = install({ root: repo.root, agents: ['claude', 'codex'] });
  assert.deepEqual(result.modified.sort(), ['.claude/settings.json', 'AGENTS.md', 'CLAUDE.md']);
  const claude = fs.readFileSync(path.join(repo.root, 'CLAUDE.md'), 'utf8');
  assert.equal(claude, `# Rules\n\n${bootstrapBlock('claude').toString('utf8')}\n\nAfter the block.\n`);
  assert.deepEqual(install({ root: repo.root, agents: ['claude', 'codex'] }).modified, []);
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(fs.readFileSync(path.join(repo.root, file), 'utf8').split(START).length, 2);
  }
});

test('doctor reports host skill verification and integration capabilities separately from errors', t => {
  const repo = repository(t);
  repo.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Check release notes.\n---\nBody\n');
  repo.change(config => {
    config.skills = { 'release-notes': { host: 'claude', scope: 'project' }, lint: { host: 'claude', scope: 'plugin', id: 'toolkit:lint' } };
    config.roles.researcher.skills.available = ['release-notes', 'lint'];
  });
  install({ root: withPackage(repo.root), agents: ['codex'] });
  const report = doctor(repo.root);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.ok(report.notes.includes('Skill release-notes is Claude Code skill release-notes: verified at .claude/skills/release-notes/SKILL.md; the Claude Code integration is not installed'));
  assert.ok(report.notes.includes('Skill lint is Claude Code skill toolkit:lint: host-provided; Agent Profiles cannot verify it; the Claude Code integration is not installed'));
  assert.ok(report.notes.some(note => note.startsWith('OpenAI Codex: bootstrap mode (observed: not yet observed)')));
});

test('presets carry host skills as references and surface a missing host integration', t => {
  const repo = repository(t);
  repo.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Check release notes.\n---\nBody\n');
  repo.change(config => {
    config.skills = { 'release-notes': { host: 'claude', scope: 'project' } };
    config.roles.researcher.skills.available = ['release-notes'];
  });
  const destination = path.join(repo.root, 'exported');
  const exported = planPresetExport({ root: repo.root, destination, roles: ['researcher'], profiles: [], metadata: {
    name: 'host-demo', display_name: 'Host demo', description: 'Host skill reference.', author: 'Tests', version: '1.0.0', license: 'Apache-2.0',
  } });
  const manifest = parse(exported.changes.find(change => change.file.endsWith('preset.yaml')).after.toString('utf8'));
  assert.deepEqual(manifest.skills, { requires: [], includes: {}, host: { 'release-notes': { host: 'claude', scope: 'project' } } });
  assert.ok(!exported.changes.some(change => change.file.includes('release-notes')));

  const target = repository(t);
  target.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Check release notes.\n---\nBody\n');
  const source = path.join(target.root, 'preset');
  for (const change of exported.changes) {
    fs.mkdirSync(path.dirname(path.join(target.root, 'preset', change.file.split('/').slice(1).join('/'))), { recursive: true });
    fs.writeFileSync(path.join(target.root, 'preset', change.file.split('/').slice(1).join('/')), change.after);
  }
  const plan = planPresetImport({ root: target.root, source, decisions: new Map([['roles.researcher', 'rename:host-researcher']]) });
  assert.equal(plan.ready, true, plan.errors.join('\n'));
  assert.ok(plan.actions.includes('Add skills.release-notes -> Claude Code skill release-notes'));
  assert.deepEqual(plan.notices, ['Preset skill release-notes is Claude Code skill release-notes; the Claude Code integration is not installed in this repository. The reference is kept as is.']);
  applyPresetImport(plan, true);
  const imported = resolveInstructions({ root: target.root, role: 'host-researcher' }).available[0];
  assert.deepEqual([imported.type, imported.scope, imported.verification], ['host', 'project', 'verified-local']);
});

test('an available skill sharing its ID with the role or profile is still exposed to the agent', t => {
  const repo = repository(t);
  repo.write('.agent-profiles/roles/testing.md', '# Testing role\n');
  repo.change(config => {
    config.roles.testing = { file: 'roles/testing.md', skills: { required: [], available: ['testing'] } };
  });
  const context = formatContext(resolveInstructions({ root: repo.root, role: 'testing' }));
  assert.match(context, /## Available skills\n\n.*\n- testing — Verify changed behavior/);
});

test('doctor reports broken host markers instead of crashing when host skills are configured', t => {
  const repo = repository(t);
  repo.change(config => {
    config.skills = { notes: { host: 'claude', scope: 'user' } };
    config.roles.researcher.skills.available = ['notes'];
  });
  install({ root: repo.root, agents: ['codex'] });
  repo.write('CLAUDE.md', `${START}\nno end marker\n`);
  const report = doctor(repo.root);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => /CLAUDE\.md: malformed or duplicate Agent Profiles markers/.test(error)), report.errors.join('\n'));
  assert.ok(report.notes.includes('Skill notes is Claude Code skill notes: host-provided; Agent Profiles cannot verify it'));
});

test('unreadable host skill metadata is reported without breaking other roles', t => {
  const repo = repository(t);
  repo.write('.claude/skills/notes/SKILL.md', 'Instructions without frontmatter.\n');
  repo.change(config => {
    config.skills = { notes: { host: 'claude', scope: 'project' } };
    config.roles.researcher.skills.available = ['notes'];
  });
  assert.equal(resolveInstructions({ root: repo.root }).role, 'implementer');
  const notes = resolveInstructions({ root: repo.root, role: 'researcher' }).available[0];
  assert.deepEqual([notes.verification, notes.description, notes.path], ['verified-local', null, '.claude/skills/notes/SKILL.md']);
  assert.match(notes.metadataError, /^expected YAML frontmatter/);
  install({ root: repo.root, agents: ['claude'] });
  assert.ok(doctor(repo.root).notes.some(note => note.startsWith('Skill notes is Claude Code skill notes: verified at .claude/skills/notes/SKILL.md; its metadata could not be read (expected YAML frontmatter')));
});

test('doctor flags older file mappings that inject a Claude skill as text', t => {
  const repo = repository(t);
  repo.write('.claude/skills/testing/SKILL.md', '---\nname: testing\ndescription: Host testing.\n---\nBODY\n');
  repo.change(config => {
    config.skills = { 'testing-2': { file: '.claude/skills/testing/SKILL.md' } };
    config.roles.researcher.skills.available = ['testing-2'];
  });
  install({ root: withPackage(repo.root), agents: ['claude'] });
  const report = doctor(repo.root);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.ok(report.notes.includes('Skill testing-2 maps .claude/skills/testing/SKILL.md as injected text; replace it with {host: claude, scope: project, id: testing} so Claude Code invokes it'));
});

test('resolution knows its host: other hosts\' skills are unusable and required ones unsatisfied', t => {
  const repo = repository(t);
  repo.write('.claude/skills/notes/SKILL.md', '---\ndescription: Notes.\n---\nBody\n');
  repo.write('.claude/skills/lint/SKILL.md', '---\ndescription: Lint.\n---\nBody\n');
  repo.change(config => {
    config.skills = { notes: { host: 'claude', scope: 'project' }, lint: { host: 'claude', scope: 'project' } };
    config.roles.researcher.skills = { required: ['notes'], available: ['lint'] };
  });
  const unknown = resolveInstructions({ root: repo.root, role: 'researcher' });
  assert.deepEqual([unknown.host, unknown.required[0].usable, unknown.unsatisfied], [null, null, []]);
  const claude = resolveInstructions({ root: repo.root, role: 'researcher', host: 'claude' });
  assert.deepEqual([claude.required[0].usable, claude.available[0].usable, claude.unsatisfied], [true, true, []]);
  assert.match(formatContext(claude), /## Required host skills\n\nUse each for all work in this role:\n- notes: Invoke the claude skill `notes`/);
  assert.match(formatContext(claude), /Command: `npx --no agent-profiles resolve --host claude --role researcher`/);
  const codex = resolveInstructions({ root: repo.root, role: 'researcher', host: 'codex' });
  assert.deepEqual(codex.unsatisfied, [{ id: 'notes', host: 'claude', hostId: 'notes', reason: 'Claude Code skill notes cannot be invoked by OpenAI Codex' }]);
  assert.equal(codex.available[0].usable, false);
  assert.deepEqual(codex.diagnostics.hostSkills.map(skill => skill.usable), [false, false]);
  const context = formatContext(codex);
  assert.match(context, /## Unsatisfied requirements\n\nThis role requires capabilities your host cannot provide\. Tell the user before doing role work, and do not substitute another skill:\n- notes: Claude Code skill notes cannot be invoked by OpenAI Codex\./);
  assert.doesNotMatch(context, /Invoke the claude skill/);
  assert.throws(() => resolveInstructions({ root: repo.root, host: 'cursor' }), /host: expected one of claude, codex/);
  install({ root: repo.root, agents: ['codex'] });
  assert.ok(doctor(repo.root).capabilities.includes('Role researcher in OpenAI Codex: required skill notes is unsatisfied (Claude Code skill notes cannot be invoked by OpenAI Codex)'));
});

test('host skill scope is explicit: project skills must exist, user and plugin skills cannot be verified', async t => {
  const cases = [
    [config => { config.skills = { notes: { host: 'claude', scope: 'project', id: 'relase-notes' } }; }, /skills.notes.file: cannot access .claude\/skills\/relase-notes\/SKILL.md/],
    [config => { config.skills = { notes: { host: 'claude' } }; }, /skills.notes.scope: required field is missing/],
    [config => { config.skills = { notes: { host: 'claude', scope: 'global' } }; }, /skills.notes.scope: expected one of project, user, plugin/],
    [config => { config.skills = { notes: { host: 'claude', scope: 'user', id: 'kit:notes' } }; }, /skills.notes.id: expected a Claude Code user skill identifier/],
    [config => { config.skills = { notes: { host: 'claude', scope: 'plugin', id: 'notes' } }; }, /skills.notes.id: expected a Claude Code plugin skill identifier/],
  ];
  for (const [index, [change, error]] of cases.entries()) {
    await t.test(`scope case ${index + 1}`, t => {
      const repo = repository(t);
      repo.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Notes.\n---\nBody\n');
      repo.change(change);
      assert.throws(() => resolveInstructions({ root: repo.root }), error);
    });
  }
  const repo = repository(t);
  repo.change(config => {
    config.skills = { mine: { host: 'claude', scope: 'user' }, kit: { host: 'claude', scope: 'plugin', id: 'toolkit:lint' } };
    config.roles.researcher.skills.available = ['mine', 'kit'];
  });
  const result = resolveInstructions({ root: repo.root, role: 'researcher' });
  assert.deepEqual(result.available.map(skill => [skill.id, skill.scope, skill.verification]), [['mine', 'user', 'host-provided'], ['kit', 'plugin', 'host-provided']]);
});

test('doctor separates configuration validity, bootstrap availability, and host capability', t => {
  const repo = repository(t);
  const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
  install({ root: repo.root, agents: ['claude'] });
  const missing = doctor(repo.root);
  assert.deepEqual([missing.errors, missing.capabilities, missing.valid], [[], [], false]);
  assert.deepEqual(missing.bootstrap, ['Claude Code: agent-profiles is not installed in this repository, so the bootstrap command fails; run init with --package, or npm install --save-dev agent-profiles']);
  withPackage(repo.root, '0.0.1');
  assert.match(doctor(repo.root).bootstrap[0], /runs installed agent-profiles 0\.0\.1, but this configuration was checked with /);
  withPackage(repo.root);
  assert.deepEqual(bootstrapAvailability(repo.root), { runnable: true, version, reason: null });
  assert.equal(doctor(repo.root).valid, true);
  // Removing the permission rules makes the bootstrap wait on a prompt; doctor says so.
  fs.writeFileSync(path.join(repo.root, '.claude/settings.json'), '{"permissions":{"allow":["Bash(npx --no agent-profiles resolve:*)"]}}');
  assert.deepEqual(doctor(repo.root).bootstrap, ['Claude Code: .claude/settings.json does not allow PowerShell(npx --no agent-profiles resolve:*); run init to add the rules']);
  repo.write('.claude/settings.local.json', '{"permissions":{"allow":["PowerShell(npx --no agent-profiles resolve:*)"]}}');
  assert.deepEqual(doctor(repo.root).bootstrap, []);
});

test('init adds only the exact permission rules, preserves other settings, and uninstall removes them', t => {
  const repo = repository(t);
  const custom = '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Read(*)"]\n  }\n}\n';
  repo.write('.claude/settings.json', custom);
  install({ root: repo.root, agents: ['claude'] });
  const settings = JSON.parse(fs.readFileSync(path.join(repo.root, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(settings, { model: 'opus', permissions: { allow: ['Read(*)', 'Bash(npx --no agent-profiles resolve:*)', 'PowerShell(npx --no agent-profiles resolve:*)'] } });
  const installed = fs.readFileSync(path.join(repo.root, '.claude/settings.json'));
  assert.deepEqual(install({ root: repo.root, agents: ['claude'] }).modified, []);
  assert.deepEqual(fs.readFileSync(path.join(repo.root, '.claude/settings.json')), installed);
  uninstall({ root: repo.root });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo.root, '.claude/settings.json'), 'utf8')), { model: 'opus', permissions: { allow: ['Read(*)'] } });
  repo.write('.claude/settings.json', '{ not json');
  assert.throws(() => install({ root: repo.root, agents: ['claude'] }), /\.claude\/settings\.json: .*repair it before Agent Profiles can check or add its permission rules/);
});

test('installPackage makes the bootstrap runnable from a local package directory', t => {
  const repo = repository(t);
  const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
  const local = path.join(repo.root, 'vendor/agent-profiles');
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'package.json'), JSON.stringify({ name: 'agent-profiles', version }));
  fs.writeFileSync(path.join(repo.root, 'package.json'), '{"name":"fixture","private":true}\n');
  assert.equal(bootstrapAvailability(repo.root).runnable, false);
  assert.deepEqual(installPackage(repo.root, local), { runnable: true, version, reason: null });
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8')).devDependencies['agent-profiles'].startsWith('file:'), true);
});

test('init exits nonzero while the bootstrap cannot run', t => {
  const repo = repository(t);
  fs.mkdirSync(path.join(repo.root, '.git'));
  const run = (...args) => spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), ...args, '--root', repo.root], { encoding: 'utf8' });
  const blocked = run('init', '--agent', 'claude');
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Bootstrap: Claude Code: agent-profiles is not installed in this repository/);
  withPackage(repo.root);
  const ready = run('init', '--agent', 'claude');
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /Bootstrap runnable with agent-profiles /);
  const report = run('doctor');
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /Configuration: valid\n[\s\S]*Bootstrap availability: runnable[\s\S]*Host capability: every role is satisfiable/);
});

test('uninstall removes a settings file that only held the bootstrap permission rules', t => {
  const repo = repository(t);
  install({ root: repo.root, agents: ['claude'] });
  assert.ok(fs.existsSync(path.join(repo.root, '.claude/settings.json')));
  uninstall({ root: repo.root });
  assert.equal(fs.existsSync(path.join(repo.root, '.claude/settings.json')), false);
});

test('managed surfaces are versioned: stale blocks and references are reported and refreshed everywhere', t => {
  const repo = repository(t);
  withPackage(repo.root);
  const unversioned = `${START}\n\n## Agent Profiles\n\nBefore beginning work, read \`.agent-profiles/agents.yaml\` and follow it.\n\n${END}`;
  repo.write('AGENTS.md', `# Rules\n\n${unversioned}\n`);
  repo.write('CLAUDE.md', `${bootstrapBlock('claude').toString('utf8').replace('protocol 2', 'protocol 1')}\n`);
  fs.appendFileSync(path.join(repo.root, '.agent-profiles/BOOTSTRAP.md'), '\nOld guidance.\n');
  const report = doctor(repo.root);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.bootstrap.filter(line => !line.includes('does not allow')), [
    'Claude Code: the managed block in CLAUDE.md is protocol 1, not protocol 2; run init to replace it',
    'OpenAI Codex: the managed block in AGENTS.md is unversioned (before protocol 2), not protocol 2; run init to replace it',
    '.agent-profiles/BOOTSTRAP.md differs from protocol 2; run init to refresh this managed reference',
  ]);
  // Selecting only Claude still refreshes the installed Codex block and the reference.
  install({ root: repo.root, agents: ['claude'] });
  assert.equal(fs.readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8'), `# Rules\n\n${bootstrapBlock('codex').toString('utf8')}\n`);
  assert.deepEqual(doctor(repo.root).bootstrap, []);
  const edited = fs.readFileSync(path.join(repo.root, 'CLAUDE.md'), 'utf8').replace('run this exact', 'run the');
  fs.writeFileSync(path.join(repo.root, 'CLAUDE.md'), edited);
  assert.deepEqual(doctor(repo.root).bootstrap, ['Claude Code: the managed block in CLAUDE.md is modified, not protocol 2; run init to replace it']);
});

test('presets round-trip model aliases and family prefixes', t => {
  const source = repository(t);
  source.change(config => {
    config.models['example-model'].aliases = ['example-model-2026', 'example-model[1m]'];
    config.families['example-family'].match = { prefixes: ['example-'] };
  });
  const destination = path.join(source.root, 'exported');
  applyPresetExport(planPresetExport({ root: source.root, destination, roles: ['reviewer'], profiles: ['autonomous', 'scaffolded'], metadata: {
    name: 'routing', display_name: 'Routing', description: 'Aliases and prefixes.', author: 'Tests', version: '1.0.0', license: 'Apache-2.0',
  } }), true);
  const manifest = parse(fs.readFileSync(path.join(destination, 'preset.yaml'), 'utf8'));
  assert.deepEqual(manifest.models, { 'example-model': { profile: 'autonomous', aliases: ['example-model-2026', 'example-model[1m]'] } });
  assert.deepEqual(manifest.families, { 'example-family': { profile: 'scaffolded', match: { prefixes: ['example-'] } } });

  // The target maps the same model without aliases: a differing entry is a conflict, not a silent no-op.
  const target = repository(t);
  const conflicted = planPresetImport({ root: target.root, source: destination, decisions: new Map([['roles.reviewer', 'keep'], ['profiles.autonomous', 'keep'], ['profiles.scaffolded', 'keep']]) });
  assert.deepEqual(conflicted.conflicts.map(conflict => conflict.key), ['models.example-model', 'families.example-family']);
  const plan = planPresetImport({ root: target.root, source: destination, decisions: new Map([
    ['roles.reviewer', 'keep'], ['profiles.autonomous', 'keep'], ['profiles.scaffolded', 'keep'],
    ['models.example-model', 'replace'], ['families.example-family', 'replace'],
  ]) });
  assert.equal(plan.ready, true, plan.errors.join('\n'));
  applyPresetImport(plan, true);
  assert.equal(resolveInstructions({ root: target.root, model: 'example-model[1m]' }).matchedBy, 'alias');
  assert.equal(resolveInstructions({ root: target.root, model: 'example-other' }).matchedBy, 'family-prefix');

  // An imported alias that collides with the target's configuration blocks the import.
  const clash = repository(t);
  clash.change(config => { config.models['example-model-2026'] = { profile: 'constrained' }; });
  const blocked = planPresetImport({ root: clash.root, source: destination, decisions: new Map([
    ['roles.reviewer', 'keep'], ['profiles.autonomous', 'keep'], ['profiles.scaffolded', 'keep'],
    ['models.example-model', 'replace'], ['families.example-family', 'replace'],
  ]) });
  assert.equal(blocked.ready, false);
  assert.match(blocked.errors.join('\n'), /models\.example-model\.aliases: alias example-model-2026 shadows the configured model/);
});

test('bootstrap accounting measures the block actually installed, including CRLF', t => {
  const repo = repository(t);
  assert.deepEqual(resolveInstructions({ root: repo.root }).diagnostics.bootstrap, { scope: 'not-measured', host: null, file: null, installed: false, bytes: null, characters: null });
  const expected = resolveInstructions({ root: repo.root, host: 'claude' }).diagnostics.bootstrap;
  assert.deepEqual([expected.scope, expected.installed, expected.bytes], ['expected-managed-block', false, bootstrapBlock('claude').length]);
  repo.write('CLAUDE.md', '# Rules\r\n');
  install({ root: repo.root, agents: ['claude'] });
  const written = fs.readFileSync(path.join(repo.root, 'CLAUDE.md')).length - Buffer.byteLength('# Rules\r\n');
  const installed = resolveInstructions({ root: repo.root, host: 'claude' }).diagnostics.bootstrap;
  assert.deepEqual([installed.scope, installed.file, installed.bytes], ['installed-managed-block', 'CLAUDE.md', written]);
  assert.ok(installed.bytes > bootstrapBlock('claude').length);
  assert.match(formatProof(resolveInstructions({ root: repo.root, host: 'claude' })), new RegExp(`Bootstrap block in CLAUDE.md: ${written} B`));
});
