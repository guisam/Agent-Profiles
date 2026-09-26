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
  const testingFile = path.join(repo.root, '.agent-profiles/skills/testing/SKILL.md');
  writeFileSync(testingFile, readFileSync(testingFile, 'utf8') + '\nAVAILABLE-CONTENT-SENTINEL');
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
  assert.deepEqual(result.available, [{
    id: 'testing', name: 'Testing',
    description: 'Verify changed behavior with focused checks and failure cases.',
    path: '.agent-profiles/skills/testing/SKILL.md',
  }]);
  assert.deepEqual(result.required.map(skill => skill.id), ['code-review']);
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
    [config => { config.roles.reviewer.skills.available = ['testing', 'testing']; }, /duplicate skill/],
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
  const requested = run('--role', 'reviewer', '--skill', 'testing', '--skill', 'testing', '--contents');
  assert.equal(requested.status, 0, requested.stderr);
  assert.equal(JSON.parse(requested.stdout).loaded.length, 4);
  for (const args of [['--role', 'missing'], ['--model'], ['--capability', 'autonomous'], ['--skill'], ['--role', 'researcher', '--skill', 'testing']]) {
    const failure = run(...args);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /Agent Profiles:/);
  }
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
});

test('on-demand skills are role-scoped, deduplicated, and do not change model resolution', t => {
  const repo = repository(t);
  const initial = resolveInstructions({ root: repo.root, model: 'example-model', role: 'reviewer' });
  const requested = resolveInstructions({ root: repo.root, model: 'example-model', role: 'reviewer', skills: ['testing', 'testing', 'code-review'] });
  assert.equal(requested.profile, initial.profile);
  assert.deepEqual(requested.available, initial.available);
  assert.equal(requested.loaded.length, initial.loaded.length + 1);
  assert.equal(requested.loaded.at(-1).path, '.agent-profiles/skills/testing/SKILL.md');
  assert.equal(requested.loaded.at(-1).content, readFileSync(path.join(repo.root, requested.loaded.at(-1).path), 'utf8'));
  assert.deepEqual(resolveInstructions({ root: repo.root }).available, initial.available);
  assert.throws(() => resolveInstructions({ root: repo.root, role: 'researcher', skills: ['testing'] }), /role researcher: skill testing is not required or available/);
  assert.throws(() => resolveInstructions({ root: repo.root, skills: ['missing'] }), /role implementer: skill missing/);
  for (const skills of ['testing', null, [1], ['../testing']]) {
    assert.throws(() => resolveInstructions({ root: repo.root, skills }), /skills/);
  }
});

test('external repository-local resources retain their own metadata and are not discovered globally', t => {
  const repo = repository(t);
  mkdirSync(path.join(repo.root, 'team-skills'));
  const file = 'team-skills/research.md';
  const content = '---\nname: Research\ndescription: Check source quality.\nlicense: MIT\n---\nPRIVATE-BODY';
  writeFileSync(path.join(repo.root, file), content);
  repo.change(config => {
    config.skills = { research: { file } };
    config.roles.researcher.skills.available = ['research'];
  });
  const result = resolveInstructions({ root: repo.root, role: 'researcher' });
  assert.deepEqual(result.available, [{ id: 'research', name: 'Research', description: 'Check source quality.', path: file }]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-BODY'));
  assert.ok(!JSON.stringify(resolveInstructions({ root: repo.root })).includes('team-skills'));
  const loaded = resolveInstructions({ root: repo.root, role: 'researcher', skills: ['research'] });
  assert.equal(loaded.loaded.at(-1).content, content);
  assert.equal(loaded.loaded.at(-1).path, file);
});

test('ambiguous sources and duplicate YAML identifiers fail instead of picking a winner', t => {
  const repo = repository(t);
  const original = readFileSync(repo.configPath, 'utf8');
  repo.change(config => {
    config.skills = { testing: { file: '.agent-profiles/skills/code-review/SKILL.md' } };
  });
  assert.throws(() => resolveInstructions({ root: repo.root }), /roles.implementer.skills.available\[0\]: ambiguous skill testing/);
  repo.change(config => {
    config.skills.testing.file = '.agent-profiles/skills/testing/SKILL.md';
  });
  assert.equal(resolveInstructions({ root: repo.root }).available.length, 1);
  for (const text of [
    original.replace('  reviewer:', '  implementer: {}\n  reviewer:'),
    original + '\nskills:\n  testing: {}\n  testing: {}\n',
  ]) {
    writeFileSync(repo.configPath, text);
    assert.throws(() => resolveInstructions({ root: repo.root }), /agents.yaml:.*unique/);
  }
});

test('skill source configuration stays inside the repository and validates unused entries', async t => {
  const cases = [
    [null, /skills: expected a mapping/],
    [{ external: {} }, /skills.external.file: required/],
    [{ external: { file: 'missing.md' } }, /skills.external.file: cannot access/],
    [{ testing: { file: '../outside.md' } }, /roles.implementer.skills.available\[0\]: expected a relative/],
    [{ testing: { file: 'https://example.com/SKILL.md' } }, /expected a relative/],
    [{ testing: { file: 'C:\\outside.md' } }, /expected a relative/],
  ];
  for (const [sources, error] of cases) {
    await t.test(error.source, t => {
      const repo = repository(t);
      repo.change(config => { config.skills = sources; });
      assert.throws(() => resolveInstructions({ root: repo.root }), error);
    });
  }
  const repo = repository(t);
  // Use a real file beyond this repository without creating or deleting anything there.
  const outside = path.join(project, 'README.md');
  symlinkSync(path.dirname(outside), path.join(repo.root, 'project'), process.platform === 'win32' ? 'junction' : 'dir');
  repo.change(config => { config.skills = { testing: { file: 'project/README.md' } }; });
  assert.throws(() => resolveInstructions({ root: repo.root }), /outside repository/);
});

test('malformed skill frontmatter identifies the role, skill path, and metadata problem', async t => {
  const cases = [
    '# No metadata',
    '---\nname: Testing\n---\nBody',
    '---\nname: 123\ndescription: Test.\n---\nBody',
    '---\nname: Testing\ndescription: " "\n---\nBody',
    '---\nname: [\n---\nBody',
    '---\nname: A\nname: B\ndescription: Test.\n---\nBody',
    '---\nname: A\ndescription: ' + 'x'.repeat(65536) + '\n---\nBody',
  ];
  for (const [index, content] of cases.entries()) {
    await t.test(`metadata case ${index + 1}`, t => {
      const repo = repository(t);
      writeFileSync(path.join(repo.root, '.agent-profiles/skills/testing/SKILL.md'), content);
      assert.throws(() => resolveInstructions({ root: repo.root }), /roles.implementer.skills.available\[0\]:.*testing.*(?:frontmatter|unique|Flow sequence)/s);
    });
  }
});

test('metadata handles CRLF, BOM, UTF-8, folded descriptions, and chunk boundaries', t => {
  const repo = repository(t);
  const file = path.join(repo.root, '.agent-profiles/skills/testing/SKILL.md');
  const header = '\uFEFF---\r\nname: Vérification\r\ndescription: >-\r\n  Check behavior\r\n  and failures.\r\n---\r\n';
  writeFileSync(file, header + 'BODY-SENTINEL'.repeat(10000));
  const result = resolveInstructions({ root: repo.root });
  assert.equal(result.available[0].name, 'Vérification');
  assert.equal(result.available[0].description, 'Check behavior and failures.');
  assert.ok(!JSON.stringify(result).includes('BODY-SENTINEL'));
  const start = '---\nname: Testing\ndescription: Test.\n#';
  const boundary = start + 'x'.repeat(1020 - Buffer.byteLength(start)) + '\n---';
  assert.equal(Buffer.byteLength(boundary), 1024);
  writeFileSync(file, boundary + '\nBody');
  assert.equal(resolveInstructions({ root: repo.root }).available[0].name, 'Testing');
  writeFileSync(file, boundary);
  assert.equal(resolveInstructions({ root: repo.root }).available[0].name, 'Testing');
  writeFileSync(file, boundary + 'not-a-delimiter\nBody');
  assert.throws(() => resolveInstructions({ root: repo.root }), /expected YAML frontmatter/);
});
