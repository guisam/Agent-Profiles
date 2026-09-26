import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { resolveInstructions } from '../src/resolve.js';

const project = fileURLToPath(new URL('../', import.meta.url));

function repository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-profiles-test-'));
    rmSync(root, { recursive: true, force: true });
  });
  cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  const configPath = path.join(root, '.agent-profiles/agents.yaml');
  return {
    root,
    configPath,
    change(edit) {
      const config = parse(readFileSync(configPath, 'utf8'));
      edit(config);
      writeFileSync(configPath, stringify(config));
    },
  };
}

test('exact, family, and default routing; roles and identities remain independent', () => {
  const cases = [
    [{ model: 'example-model' }, 'autonomous', 'model'],
    [{ model: 'example-model', family: 'example-family' }, 'autonomous', 'model'],
    [{ model: 'unlisted', family: 'example-family' }, 'scaffolded', 'family'],
    [{ family: 'example-family' }, 'scaffolded', 'family'],
    [{ model: 'unknown' }, 'constrained', 'default'],
    [{}, 'constrained', 'default'],
    [{ model: 'example-family-new' }, 'constrained', 'default'],
    [{ model: 'EXAMPLE-MODEL', family: 'EXAMPLE-FAMILY' }, 'constrained', 'default'],
    [{ model: 'frontier-autonomous', capability: 'autonomous' }, 'constrained', 'default'],
    [{ model: 'constructor', family: '__proto__' }, 'constrained', 'default'],
  ];
  for (const [identity, profile, matchedBy] of cases) {
    for (const role of ['implementer', 'reviewer', 'researcher']) {
      const result = resolveInstructions({ root: project, ...identity, role });
      assert.equal(result.profile, profile);
      assert.equal(result.matchedBy, matchedBy);
      assert.equal(result.role, role);
    }
  }
  assert.equal(resolveInstructions({ root: project }).role, 'implementer');
  assert.throws(() => resolveInstructions({ root: project, role: 'missing' }), /role: missing.*not declared/);
  for (const name of ['model', 'family', 'role']) {
    for (const value of ['', ' ', null, 1, []]) {
      assert.throws(() => resolveInstructions({ root: project, [name]: value }), new RegExp(`${name}: expected`));
    }
  }
});

test('only selected instructions load, with required skills ordered and available skills indexed', t => {
  const repo = repository(t);
  writeFileSync(path.join(repo.root, '.agent-profiles/skills/testing/SKILL.md'), 'AVAILABLE-CONTENT-SENTINEL');
  const result = resolveInstructions({ root: repo.root, model: 'example-model', role: 'reviewer' });
  assert.deepEqual(result.repository, { path: 'AGENTS.md', suppliedBy: 'host' });
  assert.deepEqual(result.loaded.map(item => item.path), [
    '.agent-profiles/profiles/autonomous.md',
    '.agent-profiles/roles/reviewer.md',
    '.agent-profiles/skills/code-review/SKILL.md',
  ]);
  for (const item of result.loaded) {
    assert.equal(item.content, readFileSync(path.join(repo.root, item.path), 'utf8'));
  }
  assert.deepEqual(result.available, [{ id: 'testing', path: '.agent-profiles/skills/testing/SKILL.md' }]);
  assert.ok(!JSON.stringify(result).includes('AVAILABLE-CONTENT-SENTINEL'));
  const researcher = resolveInstructions({ root: repo.root, role: 'researcher' });
  assert.equal(researcher.loaded.length, 2);
  assert.deepEqual(researcher.available, []);
  repo.change(config => {
    config.roles.reviewer.skills = { required: ['testing', 'code-review'], available: [] };
  });
  assert.deepEqual(resolveInstructions({ root: repo.root, role: 'reviewer' }).loaded.slice(2).map(item => item.path), [
    '.agent-profiles/skills/testing/SKILL.md', '.agent-profiles/skills/code-review/SKILL.md',
  ]);
});

test('all invalid references identify the offending entry, including inactive roles', async t => {
  const cases = [
    [config => { config.default_profile = 'missing'; }, /default_profile: cannot access profiles\/missing.md/],
    [config => { config.default_role = 'missing'; }, /default_role: role missing/],
    [config => { config.models['example-model'].profile = 'missing'; }, /models.example-model.profile:/],
    [config => { config.families['example-family'].profile = 'missing'; }, /families.example-family.profile:/],
    [config => { config.roles.researcher.file = 'roles/missing.md'; }, /roles.researcher.file:/],
    [config => { config.roles.reviewer.skills.required = ['missing']; }, /roles.reviewer.skills.required\[0\]:/],
    [config => { config.roles.reviewer.skills.available = ['missing']; }, /roles.reviewer.skills.available\[0\]:/],
  ];
  for (const [edit, error] of cases) {
    await t.test(error.source, t => {
      const repo = repository(t);
      repo.change(edit);
      assert.throws(() => resolveInstructions({ root: repo.root }), error);
    });
  }
});

test('schema errors and unsafe paths are rejected', async t => {
  const cases = [
    [config => { config.version = 2; }, /version:/],
    [config => { config.version = '1'; }, /version:/],
    [config => { delete config.models; }, /agents.yaml.models: required/],
    [config => { config.extra = true; }, /agents.yaml.extra: unknown/],
    [config => { config.models = []; }, /models: expected a mapping/],
    [config => { config.models[''] = { profile: 'autonomous' }; }, /models: keys/],
    [config => { config.models['example-model'].extra = true; }, /models.example-model.extra: unknown/],
    [config => { config.default_profile = '../outside'; }, /default_profile: expected an ID/],
    [config => { config.roles.reviewer.skills.required = 'code-review'; }, /skills.required: expected a list/],
    [config => { config.roles.reviewer.skills.required = ['code-review', 'code-review']; }, /duplicate skill/],
    [config => { config.roles.reviewer.skills.available = ['code-review']; }, /also required/],
    [config => { config.roles.reviewer.skills.available = ['../testing']; }, /expected an ID/],
    [config => { config.roles.reviewer.file = '../README.md'; }, /roles.reviewer.file: expected a relative/],
    [config => { config.roles.reviewer.file = '/outside.md'; }, /roles.reviewer.file: expected a relative/],
    [config => { config.roles.reviewer.file = 'C:/outside.md'; }, /roles.reviewer.file: expected a relative/],
    [config => { config.roles.reviewer.file = 'roles\\reviewer.md'; }, /roles.reviewer.file: expected a relative/],
    [config => { config.roles.reviewer.file = 'https://example.com/role.md'; }, /roles.reviewer.file: expected a relative/],
  ];
  for (const [edit, error] of cases) {
    await t.test(error.source, t => {
      const repo = repository(t);
      repo.change(edit);
      assert.throws(() => resolveInstructions({ root: repo.root }), error);
    });
  }
});

test('malformed YAML, duplicate keys, typed keys, and missing config fail clearly', t => {
  const repo = repository(t);
  const original = readFileSync(repo.configPath, 'utf8');
  for (const text of [
    'version: [',
    original + '\nversion: 1\n',
    original.replace('example-model:', '123:'),
    original.replace('version: 1', 'version: !unknown 1'),
    'null',
  ]) {
    writeFileSync(repo.configPath, text);
    assert.throws(() => resolveInstructions({ root: repo.root }), /agents.yaml|models: keys/);
  }
  rmSync(repo.configPath);
  assert.throws(() => resolveInstructions({ root: repo.root }), /agents.yaml.*ENOENT/);
});

test('symlink escapes and directories masquerading as instruction files fail', t => {
  const repo = repository(t);
  const outside = path.join(repo.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'role.md'), 'outside instructions');
  symlinkSync(outside, path.join(repo.root, '.agent-profiles/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  repo.change(config => { config.roles.reviewer.file = 'escape/role.md'; });
  assert.throws(() => resolveInstructions({ root: repo.root }), /roles.reviewer.file:.*outside .agent-profiles/);
  mkdirSync(path.join(repo.root, '.agent-profiles/directory.md'));
  repo.change(config => { config.roles.reviewer.file = 'directory.md'; });
  assert.throws(() => resolveInstructions({ root: repo.root }), /roles.reviewer.file:.*not a file/);
});

test('debug command emits inspectable JSON, optional contents, and actionable failures', t => {
  const repo = repository(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(project, 'scripts/resolve.js'), '--root', repo.root, ...args], { encoding: 'utf8' });
  const output = run('--model', 'example-model', '--role', 'reviewer');
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.profile, 'autonomous');
  assert.equal(result.role, 'reviewer');
  assert.ok(result.loaded.every(item => !Object.hasOwn(item, 'content')));
  const contents = JSON.parse(run('--role', 'reviewer', '--contents').stdout);
  assert.ok(contents.loaded.every(item => typeof item.content === 'string'));
  assert.ok(contents.available.every(item => !Object.hasOwn(item, 'content')));
  for (const args of [['--role', 'missing'], ['--model'], ['--capability', 'autonomous']]) {
    const failure = run(...args);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /Agent Profiles:/);
  }
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});
