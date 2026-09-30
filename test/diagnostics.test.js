import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { resolveInstructions } from '../src/resolve.js';
import { formatProof } from '../src/diagnostics.js';

const project = fileURLToPath(new URL('../', import.meta.url));
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-proof-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-profiles-proof-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  return root;
}
const count = content => ({ bytes: Buffer.byteLength(content, 'utf8'), characters: Array.from(content).length });

test('exact profile, role, skill and category totals use resolved text and exclude repository/host context', t => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, '.agent-profiles/profiles/autonomous.md'), '\uFEFFé😀\r\ne\u0301');
  fs.writeFileSync(path.join(root, '.agent-profiles/roles/reviewer.md'), '角色\n');
  const result = resolveInstructions({ root, model: 'example-model', role: 'reviewer' });
  assert.equal(result.loaded[0].bytes, 14);
  assert.equal(result.loaded[0].characters, 7);
  assert.equal(result.loaded[1].bytes, 7);
  assert.equal(result.loaded[1].characters, 3);
  assert.deepEqual(result.loaded.map(entry => entry.kind), ['profile', 'role', 'required-skill']);
  assert.equal(result.loaded[2].id, 'code-review');
  for (const entry of result.loaded) assert.deepEqual({ bytes: entry.bytes, characters: entry.characters }, count(entry.content));
  const groups = { profile: 'profile', role: 'role', requiredSkills: 'required-skill', requestedSkills: 'requested-skill' };
  for (const [group, kind] of Object.entries(groups)) {
    const entries = result.loaded.filter(entry => entry.kind === kind);
    assert.deepEqual(result.diagnostics.managed[group], {
      files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), characters: entries.reduce((sum, entry) => sum + entry.characters, 0),
    });
  }
  assert.deepEqual(result.diagnostics.managed.total, {
    files: result.loaded.length, bytes: result.loaded.reduce((sum, entry) => sum + entry.bytes, 0), characters: result.loaded.reduce((sum, entry) => sum + entry.characters, 0),
  });
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'HOST-ONLY-CONTENT'.repeat(1000));
  // Host instructions change only the existence flag, never managed context or measurements.
  assert.deepEqual(resolveInstructions({ root, model: 'example-model', role: 'reviewer' }), { ...result, repository: { ...result.repository, exists: true } });
  assert.equal(result.diagnostics.repository.bytes, null);
  assert.equal(result.diagnostics.repository.injection, 'host-controlled');
  assert.ok(Object.values(result.diagnostics.host).every(entry => entry.status === 'unobserved' && !Object.hasOwn(entry, 'bytes')));
  assert.deepEqual(result.diagnostics.tokens, { value: null, kind: 'not-calculated', method: null });
});

test('available bodies are measured separately; requests move exact counts without double-counting repeated IDs', t => {
  const root = repository(t);
  const skill = path.join(root, '.agent-profiles/skills/testing/SKILL.md');
  fs.appendFileSync(skill, '\nUNLOADED-BODY-SENTINEL café 🧪\r\n');
  const base = resolveInstructions({ root, role: 'reviewer' });
  const sizes = count(fs.readFileSync(skill, 'utf8'));
  assert.deepEqual(base.diagnostics.availableNotLoaded, { files: 1, ...sizes });
  assert.equal(base.available[0].bytes, sizes.bytes);
  assert.equal(base.available[0].characters, sizes.characters);
  assert.ok(!JSON.stringify(base).includes('UNLOADED-BODY-SENTINEL'));
  const requested = resolveInstructions({ root, role: 'reviewer', skills: ['testing', 'testing', 'code-review'] });
  assert.deepEqual(requested.available, base.available);
  assert.deepEqual(requested.diagnostics.managed.requestedSkills, { files: 1, ...sizes });
  assert.deepEqual(requested.diagnostics.managed.requiredSkills, base.diagnostics.managed.requiredSkills);
  assert.equal(requested.diagnostics.managed.total.bytes - base.diagnostics.managed.total.bytes, sizes.bytes);
  assert.equal(requested.diagnostics.managed.total.characters - base.diagnostics.managed.total.characters, sizes.characters);
  assert.deepEqual(requested.diagnostics.availableNotLoaded, { files: 0, bytes: 0, characters: 0 });
  assert.equal(requested.loaded.at(-1).kind, 'requested-skill');
  assert.equal(requested.loaded.at(-1).id, 'testing');
  const empty = resolveInstructions({ root, role: 'researcher' });
  assert.deepEqual(empty.diagnostics.managed.requiredSkills, { files: 0, bytes: 0, characters: 0 });
  assert.deepEqual(empty.diagnostics.availableNotLoaded, { files: 0, bytes: 0, characters: 0 });
});

test('streamed UTF-8 counts match loaded text across chunk boundaries and malformed input', t => {
  const root = repository(t);
  const file = path.join(root, '.agent-profiles/skills/testing/SKILL.md');
  const header = fs.readFileSync(file);
  // Put an emoji across the 64 KiB read boundary; retain CRLF, combining marks and invalid UTF-8.
  const content = Buffer.concat([header, Buffer.alloc(65535 - header.length, 97), Buffer.from('😀é\r\ne\u0301'), Buffer.from([0xff, 0xe2, 0x82])]);
  fs.writeFileSync(file, content);
  const available = resolveInstructions({ root, role: 'reviewer' });
  const requested = resolveInstructions({ root, role: 'reviewer', skills: ['testing'] });
  assert.deepEqual(available.diagnostics.availableNotLoaded, { files: 1, ...count(content.toString('utf8')) });
  assert.deepEqual(requested.diagnostics.managed.requestedSkills, available.diagnostics.availableNotLoaded);
});

test('configuration previews and distinct skill aliases are accounted using the unchanged resolution semantics', t => {
  const root = repository(t);
  const configuration = path.join(root, '.agent-profiles/agents.yaml');
  const config = parse(fs.readFileSync(configuration, 'utf8'));
  config.skills = { 'testing-alias': { file: '.agent-profiles/skills/testing/SKILL.md' } };
  config.roles.reviewer.skills.available.push('testing-alias');
  fs.writeFileSync(configuration, stringify(config));
  const result = resolveInstructions({ root, role: 'reviewer', skills: ['testing', 'testing-alias'] });
  assert.equal(result.diagnostics.managed.requestedSkills.files, 2);
  assert.equal(result.diagnostics.managed.requestedSkills.bytes, result.available[0].bytes * 2);
  const content = '# Preview\n😀\n';
  const preview = new Map([[path.join(root, '.agent-profiles/profiles/constrained.md'), Buffer.from(content)]]);
  const proposed = resolveInstructions({ root, role: 'reviewer', preview, newRoleFile: { path: 'roles/reviewer.md', content } });
  assert.deepEqual(proposed.diagnostics.managed.profile, { files: 1, ...count(content) });
  assert.deepEqual(proposed.diagnostics.managed.role, { files: 1, ...count(content) });
});

test('proof human/JSON output and debug contents mode agree; invalid flags and requests fail cleanly', t => {
  const root = repository(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'proof', '--root', root, ...args], { encoding: 'utf8' });
  const brief = run('--model', 'example-model', '--role', 'reviewer', '--json');
  assert.equal(brief.status, 0, brief.stderr);
  const json = JSON.parse(brief.stdout);
  assert.ok(json.loaded.every(entry => !Object.hasOwn(entry, 'content') && typeof entry.bytes === 'number'));
  const full = run('--model', 'example-model', '--role', 'reviewer', '--json', '--contents');
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual(JSON.parse(full.stdout).diagnostics, json.diagnostics);
  const debug = spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'resolve', '--json', '--root', root, '--model', 'example-model', '--role', 'reviewer'], { encoding: 'utf8' });
  assert.equal(debug.status, 0, debug.stderr);
  assert.deepEqual(JSON.parse(debug.stdout), json);
  const human = run('--model', 'example-model', '--role', 'reviewer');
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, new RegExp(`managed context: ${json.diagnostics.managed.total.bytes} B`));
  assert.match(human.stdout, /host controlled; not measured/);
  assert.match(human.stdout, /runtime context unobserved/);
  const requested = run('--role', 'reviewer', '--skill', 'testing', '--json');
  assert.equal(JSON.parse(requested.stdout).diagnostics.availableNotLoaded.files, 0);
  for (const args of [['--role', 'missing'], ['--role', 'reviewer', '--role', 'implementer'], ['--skill', 'unknown'], ['--model'], ['--agent', 'codex']]) {
    const result = run('--json', ...args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  assert.equal(run('--contents').status, 1);
  const safe = formatProof({ ...json, model: '\u001b[31mBAD\nMODEL' });
  assert.ok(!safe.includes('\u001b') && !safe.includes('BAD\nMODEL'));
});
