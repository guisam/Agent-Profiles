import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { discoverExternalSkills, validateExternalSelection } from '../src/external-skills.js';

function fixture(t) {
  const home = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'external-skills-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, env: {} };
}
function skill(root, directory, name = directory, description = 'Useful skill.') {
  const file = path.join(root, directory, 'SKILL.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\nPRIVATE-BODY`);
  return realpathSync(file);
}

test('known user roots expose native identities and bounded metadata only', t => {
  const options = fixture(t);
  const claude = path.join(options.home, '.claude/skills');
  const codex = path.join(options.home, '.agents/skills');
  const claudeFile = skill(claude, 'review', 'Display name');
  skill(codex, 'folder', 'native-name');
  const result = discoverExternalSkills(options);
  assert.equal(result.skills.length, 2);
  assert.deepEqual(result.skills[0], {
    id: 'claude-user-review', host: 'claude', scope: 'user', hostId: 'review',
    path: claudeFile, origin: realpathSync(claude), source: 'claude-user', external: true,
    name: 'Display name', description: 'Useful skill.', availability: 'metadata-found',
    runtime: 'unverified', selectable: true,
  });
  assert.equal(result.skills[1].hostId, 'native-name');
  assert.ok(!JSON.stringify(result).includes('PRIVATE-BODY'));
  assert.deepEqual(result.warnings, []);
});

test('approved custom and plugin roots come from strict bounded local preferences', t => {
  const options = fixture(t);
  const root = path.join(options.home, 'skills with spaces');
  skill(root, 'audit');
  const sourcesFile = path.join(options.home, 'sources.json');
  writeFileSync(sourcesFile, JSON.stringify({ version: 1, roots: [{ host: 'claude', scope: 'plugin', path: root, namespace: 'team' }] }));
  const result = discoverExternalSkills({ ...options, sourcesFile });
  assert.equal(result.skills[0].hostId, 'team:audit');
  assert.equal(result.skills[0].id, 'claude-plugin-team-audit');
  assert.equal(result.skills[0].source, 'claude-plugin');
  assert.equal(discoverExternalSkills({ ...options, env: { AGENT_PROFILES_SKILL_SOURCES: sourcesFile } }).skills.length, 1);
  const defaultFile = path.join(options.home, '.config/agent-profiles/skill-sources.json');
  mkdirSync(path.dirname(defaultFile), { recursive: true });
  writeFileSync(defaultFile, JSON.stringify({ version: 1, roots: [{ host: 'codex', scope: 'user', path: root }] }));
  assert.equal(discoverExternalSkills(options).skills[0].host, 'codex');
  for (const value of [null, [], { version: 2, roots: [] }, { version: 1, roots: [], extra: true },
    { version: 1, roots: [{ host: 'codex', scope: 'plugin', path: root }] },
    { version: 1, roots: [{ host: 'claude', scope: 'plugin', path: root }] },
    { version: 1, roots: [{ host: 'claude', scope: 'user', path: '../escape' }] },
    { version: 1, roots: [{ host: 'claude', scope: 'user', path: root, enabled: true }] },
    { version: 1, roots: [{ host: 'claude', scope: 'plugin', path: root, namespace: 'Bad Name' }] }]) {
    writeFileSync(sourcesFile, JSON.stringify(value));
    assert.throws(() => discoverExternalSkills({ ...options, sourcesFile }), /skill sources/);
  }
  writeFileSync(sourcesFile, '{');
  assert.throws(() => discoverExternalSkills({ ...options, sourcesFile }), /skill sources/);
  writeFileSync(sourcesFile, ' '.repeat(65537));
  assert.throws(() => discoverExternalSkills({ ...options, sourcesFile }), /64 KiB/);
  assert.throws(() => discoverExternalSkills({ ...options, sourcesFile: options.home }), /skill sources/);
  assert.throws(() => discoverExternalSkills({ ...options, roots: [{ host: 'claude', scope: 'user', path: `${root}/../other` }] }), /traversal/);
});

test('walking is contained, deduplicated, bounded and host-specific', t => {
  const options = fixture(t);
  const claude = path.join(options.home, '.claude/skills');
  const codex = path.join(options.home, '.agents/skills');
  skill(claude, 'direct');
  skill(claude, 'nested/deep');
  skill(claude, 'synced/downloaded');
  skill(claude, 'anthropic-skills/catalog');
  skill(codex, 'category/deep', 'deep');
  const outside = path.join(options.home, 'outside');
  skill(outside, 'secret');
  const link = (target, name) => symlinkSync(target, name, process.platform === 'win32' ? 'junction' : 'dir');
  link(outside, path.join(codex, 'escape'));
  link(path.join(codex, 'category'), path.join(codex, 'alias'));
  link(codex, path.join(codex, 'category/cycle'));
  const approvedAlias = path.join(options.home, 'approved-link');
  link(outside, approvedAlias);
  const result = discoverExternalSkills(options);
  assert.deepEqual(result.skills.map(item => item.hostId).sort(), ['deep', 'direct']);
  assert.ok(result.warnings.some(item => /outside.*approved root/.test(item)));
  assert.ok(result.warnings.some(item => /synced/.test(item)));
  assert.ok(result.warnings.some(item => /anthropic-skills/.test(item)));
  const approved = discoverExternalSkills({ ...options, roots: [{ host: 'codex', scope: 'user', path: approvedAlias }] });
  assert.equal(approved.skills.find(item => item.hostId === 'secret').origin, realpathSync(outside));
  skill(codex, 'a/b/c/d/e/f/g/h/i/too-deep', 'too-deep');
  const bounded = discoverExternalSkills(options);
  assert.ok(!bounded.skills.some(item => item.hostId === 'too-deep'));
  assert.ok(bounded.warnings.some(item => /depth limit/.test(item)));
});

test('bad or invalid metadata warns without normalizing native identifiers', t => {
  const options = fixture(t);
  const root = path.join(options.home, '.agents/skills');
  const bad = skill(root, 'bad');
  writeFileSync(bad, '---\nname: [\n---\nBODY');
  skill(root, 'invalid', 'Bad Name');
  skill(root, 'padded', '" padded "');
  const huge = skill(root, 'huge');
  writeFileSync(huge, '---\nname: huge\ndescription: ' + 'x'.repeat(65536) + '\n---\nBODY');
  const bom = skill(root, 'bom');
  writeFileSync(bom, '\uFEFF---\r\nname: bom\r\ndescription: Useful.\r\n---\r\n' + 'PRIVATE-BODY'.repeat(100000));
  const missingName = skill(root, 'no-name');
  writeFileSync(missingName, '---\ndescription: Missing name.\n---\n');
  const result = discoverExternalSkills(options);
  assert.deepEqual(result.skills.map(item => item.hostId), ['bom']);
  assert.equal(result.warnings.length, 5);
  assert.ok(result.warnings.some(item => /native identifier/.test(item)));
  assert.ok(!JSON.stringify(result).includes('PRIVATE-BODY'));
});

test('duplicate native identities remain visible but are not selectable', t => {
  const options = fixture(t);
  const first = path.join(options.home, 'first');
  const second = path.join(options.home, 'second');
  skill(first, 'one', 'same');
  skill(second, 'two', 'same');
  const roots = [first, first, second].map(root => ({ host: 'codex', scope: 'user', path: root }));
  const result = discoverExternalSkills({ ...options, roots });
  assert.equal(result.skills.length, 2);
  assert.ok(result.skills.every(item => !item.selectable));
  assert.ok(result.warnings.some(item => /conflict.*same/.test(item)));
});

test('selection validation rereads approved inventory and rejects changed or forged selections', t => {
  const options = fixture(t);
  const root = path.join(options.home, 'approved');
  const file = skill(root, 'review');
  const approved = { ...options, roots: [{ host: 'claude', scope: 'user', path: root }] };
  const selection = discoverExternalSkills(approved).skills[0];
  assert.deepEqual(validateExternalSelection(selection, approved), selection);
  assert.throws(() => validateExternalSelection(selection, options), /external selection/);
  for (const [key, value] of [['host', 'codex'], ['scope', 'plugin'], ['hostId', 'other'], ['origin', options.home], ['path', root], ['name', 'Other'], ['description', 'Changed']]) {
    assert.throws(() => validateExternalSelection({ ...selection, [key]: value }, approved), /external selection/);
  }
  writeFileSync(file, '---\nname: review\ndescription: Changed.\n---\n');
  assert.throws(() => validateExternalSelection(selection, approved), /external selection/);
  rmSync(file);
  assert.throws(() => validateExternalSelection(selection, approved), /external selection/);
  assert.throws(() => validateExternalSelection(null, approved), /external selection/);
});

test('validation rejects repointed approved roots and newly ambiguous origins', t => {
  const options = fixture(t);
  const first = path.join(options.home, 'first');
  const second = path.join(options.home, 'second');
  skill(first, 'review');
  skill(second, 'review');
  const link = path.join(options.home, 'approved-link');
  symlinkSync(first, link, process.platform === 'win32' ? 'junction' : 'dir');
  const approved = { ...options, roots: [{ host: 'claude', scope: 'user', path: link }] };
  const selection = discoverExternalSkills(approved).skills[0];
  rmSync(link);
  symlinkSync(second, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateExternalSelection(selection, approved), /external selection/);
  const conflicting = { ...options, roots: [first, second].map(root => ({ host: 'claude', scope: 'user', path: root })) };
  assert.throws(() => validateExternalSelection(selection, conflicting), /external selection/);
});

test('metadata inspection never uses whole-file reads or consumes large skill bodies', t => {
  const options = fixture(t);
  for (const directory of ['.claude/skills', '.agents/skills']) {
    const file = skill(path.join(options.home, directory), 'bounded');
    writeFileSync(file, '---\nname: bounded\ndescription: Small metadata.\n---\n' + 'BODY'.repeat(1000000));
  }
  const moduleUrl = new URL('../src/external-skills.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { discoverExternalSkills } from ${JSON.stringify(moduleUrl)};
    let bytes = 0;
    const read = fs.readSync;
    fs.readSync = (...args) => { const count = read(...args); bytes += count; return count; };
    fs.readFileSync = () => { throw new Error('whole-file read forbidden'); };
    syncBuiltinESMExports();
    const result = discoverExternalSkills(${JSON.stringify(options)});
    console.log(JSON.stringify({ bytes, skills: result.skills.length, warnings: result.warnings }));
  `;
  const execution = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.skills, 2);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.bytes <= 2048, `read ${result.bytes} bytes`);
});

test('directory count is bounded and invalid root types warn actionably', t => {
  const options = fixture(t);
  const root = path.join(options.home, 'many');
  mkdirSync(root);
  for (let index = 0; index < 4200; index++) mkdirSync(path.join(root, `folder-${index}`));
  const result = discoverExternalSkills({ ...options, roots: [{ host: 'codex', scope: 'user', path: root }] });
  assert.ok(result.warnings.some(item => /directory count limit/.test(item)));
  const file = path.join(options.home, 'not-a-directory');
  writeFileSync(file, 'not a root');
  const invalid = discoverExternalSkills({ ...options, roots: [{ host: 'claude', scope: 'user', path: file }] });
  assert.equal(invalid.skills.length, 0);
  assert.ok(invalid.warnings.some(item => /cannot read root.*directory/.test(item)));
});

test('local JSON reads request at most 64 KiB even at the exact size boundary', t => {
  const options = fixture(t);
  const sourcesFile = path.join(options.home, 'sources.json');
  const json = JSON.stringify({ version: 1, roots: [] });
  writeFileSync(sourcesFile, json.padEnd(65536, ' '));
  const moduleUrl = new URL('../src/external-skills.js', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { discoverExternalSkills } from ${JSON.stringify(moduleUrl)};
    const read = fs.readSync;
    fs.readSync = (...args) => {
      if (args[3] > 65536) throw new Error('requested more than 64 KiB');
      return read(...args);
    };
    syncBuiltinESMExports();
    console.log(JSON.stringify(discoverExternalSkills(${JSON.stringify({ ...options, sourcesFile })})));
  `;
  const execution = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout).skills, []);
});

test('missing default roots are normal and never search other home directories', t => {
  const options = fixture(t);
  skill(path.join(options.home, '.codex/skills'), 'legacy');
  assert.deepEqual(discoverExternalSkills(options).skills, []);
  assert.deepEqual(discoverExternalSkills(options).warnings, []);
});
