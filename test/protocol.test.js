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
import { doctor, install } from '../src/install.js';
import { bootstrapBlock, END, START } from '../src/integrations.js';
import { applyPresetImport, planPresetExport, planPresetImport } from '../src/presets.js';
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
    config.skills = { 'release-notes': { host: 'claude' }, bare: { host: 'claude' }, lint: { host: 'claude', id: 'toolkit:lint' } };
    config.roles.reviewer.skills.required.push('release-notes');
    config.roles.reviewer.skills.available.push('bare', 'lint');
  });
  const result = resolveInstructions({ root: repo.root, role: 'reviewer', skills: ['lint'] });
  assert.ok(result.loaded.every(entry => !entry.content.includes('HOST-SKILL-BODY')));
  assert.deepEqual(result.loaded.map(entry => entry.id), ['constrained', 'reviewer', 'code-review']);
  const notes = result.required.find(skill => skill.id === 'release-notes');
  assert.deepEqual(notes, {
    id: 'release-notes', type: 'host', host: 'claude', hostId: 'release-notes', delivery: 'invoke',
    name: 'release-notes', nameSource: 'directory', description: 'Check release notes.',
    path: '.claude/skills/release-notes/SKILL.md', verification: 'verified-local', bytes: null, characters: null,
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
    [config => { config.skills = { x: { host: 'codex' } }; }, /skills.x.host: expected a host with native skills: claude/],
    [config => { config.skills = { x: { host: 'claude', id: 'Bad Name' } }; }, /skills.x.id: expected a Claude Code skill identifier/],
    [config => { config.skills = { x: { host: 'claude', file: 'a.md' } }; }, /skills.x.file: unknown field/],
    [config => { config.skills = { testing: { host: 'claude' } }; }, /ambiguous skill testing: .agent-profiles\/skills\/testing\/SKILL.md exists and skills.testing names a host skill/],
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
  assert.deepEqual(parse(fs.readFileSync(path.join(repo.root, '.agent-profiles/agents.yaml'), 'utf8')).skills, { 'release-notes': { host: 'claude' } });
  assert.equal(resolveInstructions({ root: repo.root, role: 'writer' }).available[0].type, 'host');
  // Editing the role again keeps the same reference.
  applyRoleChange(planRoleChange({ root: repo.root, action: 'edit', id: 'writer' }));
  const hostTesting = skills.find(skill => skill.id === 'testing' && skill.host);
  assert.throws(() => planRoleChange({ root: repo.root, action: 'create', id: 'qa', required: [hostTesting] }),
    /testing already names another skill, so the claude skill testing cannot use it; rename one of them first/);
});

test('bootstrap block routes through the resolver and never asks the model to route by hand', () => {
  const block = bootstrapBlock().toString('utf8');
  assert.ok(block.startsWith(START) && block.endsWith(END));
  assert.match(block, /npx --no agent-profiles resolve --model "<exact model ID>"/);
  assert.match(block, /new or compacted context, and after a model change/);
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
  assert.deepEqual(result.modified.sort(), ['AGENTS.md', 'CLAUDE.md']);
  const claude = fs.readFileSync(path.join(repo.root, 'CLAUDE.md'), 'utf8');
  assert.equal(claude, `# Rules\n\n${bootstrapBlock().toString('utf8')}\n\nAfter the block.\n`);
  assert.deepEqual(install({ root: repo.root, agents: ['claude', 'codex'] }).modified, []);
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(fs.readFileSync(path.join(repo.root, file), 'utf8').split(START).length, 2);
  }
});

test('doctor reports host skill verification and integration capabilities separately from errors', t => {
  const repo = repository(t);
  repo.write('.claude/skills/release-notes/SKILL.md', '---\ndescription: Check release notes.\n---\nBody\n');
  repo.change(config => {
    config.skills = { 'release-notes': { host: 'claude' }, lint: { host: 'claude', id: 'toolkit:lint' } };
    config.roles.researcher.skills.available = ['release-notes', 'lint'];
  });
  install({ root: repo.root, agents: ['codex'] });
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
    config.skills = { 'release-notes': { host: 'claude' } };
    config.roles.researcher.skills.available = ['release-notes'];
  });
  const destination = path.join(repo.root, 'exported');
  const exported = planPresetExport({ root: repo.root, destination, roles: ['researcher'], profiles: [], metadata: {
    name: 'host-demo', display_name: 'Host demo', description: 'Host skill reference.', author: 'Tests', version: '1.0.0', license: 'Apache-2.0',
  } });
  const manifest = parse(exported.changes.find(change => change.file.endsWith('preset.yaml')).after.toString('utf8'));
  assert.deepEqual(manifest.skills, { requires: [], includes: {}, host: { 'release-notes': { host: 'claude' } } });
  assert.ok(!exported.changes.some(change => change.file.includes('release-notes')));

  const target = repository(t);
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
  assert.deepEqual([imported.type, imported.verification], ['host', 'host-provided']);
});
