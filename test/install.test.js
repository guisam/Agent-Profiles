import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { detectAgents, doctor, findRoot, install, uninstall } from '../src/install.js';
import { bootstrapBlock, END, START } from '../src/integrations.js';

const project = fileURLToPath(new URL('../', import.meta.url));

function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-install-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-profiles-install-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.git'));
  return root;
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), fs.readFileSync(file).toString('base64')];
    }).sort(([a], [b]) => a.localeCompare(b));
}

test('fresh multi-agent installation validates, detects the root, and is idempotent', t => {
  const root = repository(t);
  fs.mkdirSync(path.join(root, 'src/deep'), { recursive: true });
  assert.equal(findRoot(path.join(root, 'src/deep')), fs.realpathSync(root));
  assert.ok(detectAgents(root).every(agent => !agent.detected));
  const result = install({ root, agents: ['claude', 'codex'] });
  assert.equal(result.valid, true);
  assert.equal(result.profile, 'constrained');
  assert.equal(result.role, 'implementer');
  assert.equal(result.modified.length, 12);
  assert.ok(result.agents.every(agent => agent.installed));
  assert.equal(doctor(root).valid, true);
  const before = snapshot(root);
  assert.deepEqual(install({ root, agents: ['claude', 'codex', 'codex'] }).modified, []);
  assert.deepEqual(snapshot(root), before);
});

test('insertion and removal preserve every unrelated byte, including BOM, CRLF, and no final newline', t => {
  const root = repository(t);
  const originals = {
    'CLAUDE.md': Buffer.from('\uFEFF# Existing\r\n\r\nKeep these instructions.\r\n'),
    'AGENTS.md': Buffer.from('# Project rules\nNever discard these'),
  };
  for (const [file, content] of Object.entries(originals)) fs.writeFileSync(path.join(root, file), content);
  install({ root, agents: ['claude', 'codex'] });
  for (const [file, content] of Object.entries(originals)) {
    assert.ok(fs.readFileSync(path.join(root, file)).subarray(0, content.length).equals(content));
    fs.appendFileSync(path.join(root, file), '\nUser additions after the block.\n');
  }
  const result = uninstall({ root });
  assert.equal(result.configurationRetained, true);
  for (const [file, content] of Object.entries(originals)) {
    assert.deepEqual(fs.readFileSync(path.join(root, file)), Buffer.concat([content, Buffer.from('\nUser additions after the block.\n')]));
  }
  assert.deepEqual(uninstall({ root }).modified, []);
});

test('user-edited configuration and profiles survive reinstallation and integration-only uninstall', t => {
  const root = repository(t);
  install({ root, agents: ['codex'] });
  for (const file of ['agents.yaml', 'profiles/constrained.md', 'roles/implementer.md', 'BOOTSTRAP.md']) {
    fs.appendFileSync(path.join(root, '.agent-profiles', file), '\n# User-owned addition\n');
  }
  const before = snapshot(path.join(root, '.agent-profiles'));
  install({ root, agents: ['codex', 'claude'] });
  assert.deepEqual(snapshot(path.join(root, '.agent-profiles')), before);
  uninstall({ root });
  assert.deepEqual(snapshot(path.join(root, '.agent-profiles')), before);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '');
  assert.match(doctor(root).errors.join('\n'), /No active Agent Profiles integration/);
});

test('adapters honor existing alternate files and Codex override precedence', t => {
  const root = repository(t);
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude/CLAUDE.md'), 'Claude rules');
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), 'Codex override');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Shared repository rules');
  const result = install({ root, agents: ['claude', 'codex'] });
  assert.deepEqual(result.agents.map(agent => agent.file), ['.claude/CLAUDE.md', 'AGENTS.override.md']);
  assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), 'Shared repository rules');
  uninstall({ root });
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), '');
  install({ root, agents: ['codex'] });
  assert.equal(doctor(root).agents.find(agent => agent.id === 'codex').file, 'AGENTS.md');
  fs.writeFileSync(path.join(root, 'AGENTS.override.md'), 'New overriding instructions');
  assert.match(doctor(root).errors.join('\n'), /shadowed/);
  assert.throws(() => install({ root, agents: ['codex'] }), /shadowed/);
  uninstall({ root });
  install({ root, agents: ['codex'] });
  assert.equal(doctor(root).valid, true);
});

test('doctor reuses routing validation for broken profiles, roles, and skills without modifying files', async t => {
  for (const file of ['profiles/constrained.md', 'roles/reviewer.md', 'skills/testing/SKILL.md']) {
    await t.test(file, t => {
      const root = repository(t);
      install({ root, agents: ['codex'] });
      fs.unlinkSync(path.join(root, '.agent-profiles', file));
      const before = snapshot(root);
      const report = doctor(root);
      assert.equal(report.valid, false);
      assert.ok(report.errors.some(error => error.includes(file)));
      assert.match(report.errors.join('\n'), /restore the file or correct this reference.*agent-profiles doctor/);
      assert.throws(() => install({ root, agents: ['claude'] }), /cannot access/);
      assert.deepEqual(snapshot(root), before);
      uninstall({ root }); // Invalid configuration does not prevent integration removal.
    });
  }
});

test('preflight rejects partial installations, malformed blocks, and duplicate markers without changes', async t => {
  const cases = [START, END, END + START, START + END + START + END];
  for (const content of cases) {
    await t.test(content, t => {
      const root = repository(t);
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), content);
      const before = snapshot(root);
      assert.throws(() => install({ root, agents: ['claude', 'codex'] }), /markers/);
      assert.throws(() => uninstall({ root }), /markers/);
      assert.equal(fs.existsSync(path.join(root, '.agent-profiles')), false);
      assert.deepEqual(snapshot(root), before);
    });
  }
  const root = repository(t);
  fs.mkdirSync(path.join(root, '.agent-profiles'));
  fs.writeFileSync(path.join(root, '.agent-profiles/custom.md'), 'Do not replace');
  assert.throws(() => install({ root, agents: ['codex'] }), /without agents.yaml/);
  assert.throws(() => install({ root, agents: [] }), /at least one/);
  assert.throws(() => install({ root, agents: ['unknown'] }), /Unknown agent/);
});

test('configuration deletion requires confirmation and is restricted to the exact local directory', t => {
  const root = repository(t);
  install({ root, agents: ['codex'] });
  const before = snapshot(root);
  assert.throws(() => uninstall({ root, deleteConfig: true }), /explicit confirmation/);
  assert.throws(() => uninstall({ root, deleteConfig: true, confirmed: 'yes' }), /must be booleans/);
  assert.deepEqual(snapshot(root), before);
  const result = uninstall({ root, deleteConfig: true, confirmed: true });
  assert.equal(result.configurationRetained, false);
  assert.equal(fs.existsSync(path.join(root, '.agent-profiles')), false);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), '');
});

test('linked integration and configuration paths are refused before writes or deletion', t => {
  const root = repository(t);
  const outside = repository(t);
  fs.writeFileSync(path.join(outside, 'CLAUDE.md'), 'Outside rules');
  fs.symlinkSync(outside, path.join(root, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => install({ root, agents: ['claude'] }), /linked/);
  assert.equal(fs.existsSync(path.join(root, '.agent-profiles')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'CLAUDE.md'), 'utf8'), 'Outside rules');
  const other = repository(t);
  install({ root: other, agents: ['codex'] });
  fs.symlinkSync(outside, path.join(other, '.agent-profiles/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => uninstall({ root: other, deleteConfig: true, confirmed: true }), /Unsupported template entry|linked/);
  assert.ok(fs.readFileSync(path.join(other, 'AGENTS.md'), 'utf8').includes(START));
});

test('a write failure rolls back completed changes and preserves original instruction files', t => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Original instructions');
  const before = snapshot(root);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === path.join(root, 'CLAUDE.md')) throw new Error('simulated write failure');
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => install({ root, agents: ['codex', 'claude'] }), /simulated write failure.*\nNo file changes retained/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, '.agent-profiles')), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('CLI supports explicit agents, root detection, doctor exit codes, and safe noninteractive removal', t => {
  const root = repository(t);
  fs.mkdirSync(path.join(root, 'nested'));
  const run = (...args) => spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), ...args], { cwd: path.join(root, 'nested'), encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  for (const command of ['init', 'configure', 'doctor', 'uninstall']) {
    assert.match(help.stdout, new RegExp(`  ${command} +[A-Z]`));
    assert.equal(run(command, '--help').status, 0);
  }
  const missing = run('doctor');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /agents.yaml.*run agent-profiles init/);
  const fresh = run('init', '--agent', 'claude', '--agent', 'codex');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /Configuration validated/);
  assert.equal(run('doctor').status, 0);
  assert.match(run('init', '--agent', 'codex').stdout, /No changes required/);
  for (const args of [['init'], ['uninstall', '--delete-config'], ['doctor', '--agent', 'codex'], ['init', '--delete-config'], ['unknown']]) {
    const before = snapshot(root);
    assert.equal(run(...args).status, 1);
    assert.deepEqual(snapshot(root), before);
  }
  const removed = run('uninstall');
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(removed.stdout, /Configuration retained/);
  assert.equal(run('doctor').status, 1);
  const explicit = run('init', '--root', root, '--agent', 'codex');
  assert.equal(explicit.status, 0, explicit.stderr);
});

test('an existing managed block is left untouched and older configuration can acquire the protocol', t => {
  const root = repository(t);
  install({ root, agents: ['codex'] });
  const file = path.join(root, 'AGENTS.md');
  const custom = Buffer.concat([Buffer.from('Rules\n'), bootstrapBlock('codex'), Buffer.from('\nMore rules')]);
  fs.writeFileSync(file, custom);
  fs.unlinkSync(path.join(root, '.agent-profiles/BOOTSTRAP.md'));
  assert.match(doctor(root).errors.join('\n'), /BOOTSTRAP.md is missing/);
  const result = install({ root, agents: ['codex'] });
  assert.deepEqual(result.modified, ['.agent-profiles/BOOTSTRAP.md']);
  assert.deepEqual(fs.readFileSync(file), custom);
});

test('root detection accepts Git worktree files and explicit roots support non-Git directories', t => {
  const root = repository(t);
  fs.rmdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /example/worktree');
  assert.equal(findRoot(root), fs.realpathSync(root));
  fs.unlinkSync(path.join(root, '.git'));
  const result = install({ root, agents: ['codex'] });
  assert.equal(result.valid, true);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});
