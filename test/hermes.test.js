import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { detectAgents, doctor, install, uninstall } from '../src/install.js';
import { bootstrapBlock } from '../src/integrations.js';
import { formatContext } from '../src/diagnostics.js';
import { parseYaml, resolveInstructions } from '../src/resolve.js';

const project = fileURLToPath(new URL('../', import.meta.url));

function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-hermes-')));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-profiles-hermes-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.git'));
  // A standard npm package/shim fixture; packed-package tests exercise the real executable.
  const { version } = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
  fs.mkdirSync(path.join(root, 'node_modules/agent-profiles/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/agent-profiles/package.json'), JSON.stringify({ name: 'agent-profiles', version, bin: { 'agent-profiles': 'bin/agent-profiles.js' } }));
  const executable = path.join(root, 'node_modules/agent-profiles/bin/agent-profiles.js');
  fs.writeFileSync(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'node_modules/.bin'));
  const bin = path.join(root, 'node_modules/.bin/agent-profiles');
  if (process.platform === 'win32') {
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.writeFileSync(bin + '.cmd', '@echo off\r\nnode "%~dp0..\\agent-profiles\\bin\\agent-profiles.js" %*\r\n');
  } else fs.symlinkSync('../agent-profiles/bin/agent-profiles.js', bin);
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

test('Hermes resolves model instruction profiles and roles without selecting a Hermes runtime profile', () => {
  const result = resolveInstructions({ root: project, host: 'hermes', model: 'example-model', identitySource: 'host-stated', role: 'reviewer' });
  assert.equal(result.host, 'hermes');
  assert.equal(result.profile, 'autonomous');
  assert.equal(result.role, 'reviewer');
  assert.deepEqual(result.required.map(skill => skill.id), ['code-review']);
  assert.deepEqual(result.loaded.map(entry => entry.id), ['autonomous', 'reviewer', 'code-review']);
  assert.equal(Object.hasOwn(result, 'hermesProfile'), false);
});

test('Hermes installation preserves shared rules and explains the runtime-profile boundary', t => {
  const root = repository(t);
  const rules = Buffer.from('\uFEFF# Shared rules\r\nKeep repository invariants.');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), rules);
  const result = install({ root, agents: ['hermes'] });
  assert.equal(result.valid, true, [...result.errors, ...result.bootstrap].join('\n'));
  assert.equal(result.agents.find(agent => agent.id === 'hermes').file, '.hermes.md');
  assert.deepEqual(fs.readFileSync(path.join(root, 'AGENTS.md')), rules);
  const block = fs.readFileSync(path.join(root, '.hermes.md'), 'utf8');
  assert.match(block, /resolve --host hermes --identity-source host-stated --model/);
  assert.match(block, /model instruction profile/);
  assert.match(block, /Hermes runtime profile/);
  assert.match(block, /AGENTS\.override\.md/);
  assert.match(block, /CLAUDE\.md/);
  assert.match(block, /\.cursorrules/);
  assert.match(block, /SOUL\.md/);
  assert.equal(fs.existsSync(path.join(root, 'SOUL.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.hermes/config.yaml')), false);
});

test('Hermes shared-rule guidance preserves empty-file fallback and discovery boundaries', () => {
  const block = bootstrapBlock('hermes').toString('utf8');
  assert.match(block, /Git root through the working directory; outside Git, working directory only/);
  assert.match(block, /first readable nonempty file in order:/);
  assert.match(block, /AGENTS\.override\.md, AGENTS\.md, agents\.md/);
  assert.match(block, /Skip empty or unreadable files and try the next name/);
  assert.match(block, /If the entire AGENTS chain has no nonempty content, try the working directory's/);
  assert.match(block, /CLAUDE\.md then claude\.md, again skipping empty or unreadable files/);
  assert.match(block, /If neither has content, read all readable nonempty \.cursorrules and/);
  assert.match(block, /\.cursor\/rules\/\*\.mdc files in the working directory only/);
});

test('Hermes honors existing HERMES.md and reports shadowing by even an empty .hermes.md', t => {
  const root = repository(t);
  const original = Buffer.from('# Hermes project rules\nKeep these.');
  fs.writeFileSync(path.join(root, 'HERMES.md'), original);
  assert.equal(detectAgents(root).find(agent => agent.id === 'hermes').detected, true);
  assert.equal(install({ root, agents: ['hermes'] }).agents.find(agent => agent.id === 'hermes').file, 'HERMES.md');
  assert.equal(fs.existsSync(path.join(root, '.hermes.md')), false);
  fs.writeFileSync(path.join(root, '.hermes.md'), '');
  assert.match(doctor(root).errors.join('\n'), /Hermes Agent: bootstrap in HERMES.md is shadowed by .hermes.md/);
  const before = snapshot(root);
  assert.throws(() => install({ root, agents: ['hermes'] }), /shadowed/);
  assert.deepEqual(snapshot(root), before);
  uninstall({ root });
  assert.deepEqual(fs.readFileSync(path.join(root, 'HERMES.md')), original);
  const next = install({ root, agents: ['hermes'] });
  assert.equal(next.agents.find(agent => agent.id === 'hermes').file, '.hermes.md');
  assert.equal(next.valid, true);
});

test('Hermes lower-case filename has priority when both spellings already exist', t => {
  const root = repository(t);
  fs.writeFileSync(path.join(root, '.hermes.md'), '');
  fs.writeFileSync(path.join(root, 'HERMES.md'), '# Alternate rules\n');
  const result = install({ root, agents: ['hermes'] });
  assert.equal(result.agents.find(agent => agent.id === 'hermes').file, '.hermes.md');
  assert.equal(fs.readFileSync(path.join(root, 'HERMES.md'), 'utf8'), '# Alternate rules\n');
});

test('Hermes reruns are idempotent and uninstall preserves BOM, CRLF, and later user additions', t => {
  const root = repository(t);
  const original = Buffer.from('\uFEFF# Hermes rules\r\nNo final newline');
  fs.writeFileSync(path.join(root, '.hermes.md'), original);
  install({ root, agents: ['hermes'] });
  const installed = snapshot(root);
  assert.deepEqual(install({ root, agents: ['hermes'] }).modified, []);
  assert.deepEqual(snapshot(root), installed);
  const file = path.join(root, '.hermes.md');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(bootstrapBlock('hermes', '\r\n').toString('utf8')));
  const addition = Buffer.from('\r\n# User addition\r\n');
  fs.appendFileSync(file, addition);
  uninstall({ root });
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([original, addition]));
  assert.deepEqual(uninstall({ root }).modified, []);
});

test('Hermes, Claude, and Codex coexist without rewriting unrelated settings', t => {
  const root = repository(t);
  fs.mkdirSync(path.join(root, '.hermes'));
  const original = Buffer.from('user-owned runtime settings\n');
  fs.writeFileSync(path.join(root, '.hermes/config.yaml'), original);
  const result = install({ root, agents: ['claude', 'codex', 'hermes'] });
  assert.equal(result.valid, true, [...result.errors, ...result.bootstrap].join('\n'));
  assert.deepEqual(result.agents.filter(agent => agent.installed).map(agent => agent.id), ['claude', 'codex', 'hermes']);
  const before = snapshot(root);
  assert.deepEqual(install({ root, agents: ['hermes', 'claude', 'codex'] }).modified, []);
  assert.deepEqual(snapshot(root), before);
  uninstall({ root });
  assert.deepEqual(fs.readFileSync(path.join(root, '.hermes/config.yaml')), original);
  for (const file of ['.hermes.md', 'CLAUDE.md', 'AGENTS.md']) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), '');
});

test('Hermes composes existing portable skills and rejects requests outside the assigned role', t => {
  const root = repository(t);
  install({ root, agents: ['hermes'] });
  const skillPath = '.agents/skills/local-check/SKILL.md';
  fs.mkdirSync(path.dirname(path.join(root, skillPath)), { recursive: true });
  fs.writeFileSync(path.join(root, skillPath), '---\nname: local-check\ndescription: Check the local task.\n---\nPORTABLE-SKILL-BODY\n');
  const configuration = parseYaml(fs.readFileSync(path.join(root, '.agent-profiles/agents.yaml'), 'utf8'));
  configuration.set('skills', new Map([['local-check', new Map([['file', skillPath]])]]));
  configuration.get('roles').get('reviewer').get('skills').get('available').push('local-check');
  const resolve = options => resolveInstructions({ root, host: 'hermes', role: 'reviewer', configuration, ...options });
  const initial = resolve({});
  assert.equal(initial.profile, 'constrained');
  assert.equal(initial.identity.raw, null);
  assert.ok(!initial.loaded.some(entry => entry.content.includes('PORTABLE-SKILL-BODY')));
  assert.ok(initial.available.some(entry => entry.id === 'local-check'));
  const requested = resolve({ skills: ['local-check'] });
  assert.ok(requested.loaded.some(entry => entry.path === skillPath && entry.content.includes('PORTABLE-SKILL-BODY')));
  assert.throws(() => resolve({ skills: ['not-assigned'] }), /not required or available to this role/);
});

test('Hermes does not expose Claude-only skills or silently satisfy their required capabilities', t => {
  const root = repository(t);
  install({ root, agents: ['hermes'] });
  const configuration = parseYaml(fs.readFileSync(path.join(root, '.agent-profiles/agents.yaml'), 'utf8'));
  configuration.set('skills', new Map([['host-check', new Map([['host', 'claude'], ['scope', 'user']])]]));
  const reviewer = configuration.get('roles').get('reviewer').get('skills');
  reviewer.get('available').push('host-check');
  const available = resolveInstructions({ root, host: 'hermes', role: 'reviewer', configuration });
  assert.equal(available.available.find(skill => skill.id === 'host-check').usable, false);
  assert.ok(!formatContext(available).includes('Invoke the claude skill'));
  reviewer.get('available').pop();
  reviewer.get('required').push('host-check');
  const required = resolveInstructions({ root, host: 'hermes', role: 'reviewer', configuration });
  assert.equal(required.unsatisfied.length, 1);
  assert.match(required.unsatisfied[0].reason, /cannot be invoked by Hermes Agent/);
  assert.match(formatContext(required), /## Unsatisfied requirements/);
});

test('Hermes CLI accepts the host, preserves identity provenance, and exposes its choice in help', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), ...args], { cwd: project, encoding: 'utf8' });
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Select claude, codex, hermes/);
  const result = cli('resolve', '--root', project, '--host', 'hermes', '--model', 'example-model', '--identity-source', 'host-stated', '--role', 'reviewer', '--json', '--contents');
  assert.equal(result.status, 0, result.stderr);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.host, 'hermes');
  assert.equal(resolved.identity.source, 'host-stated');
  assert.equal(resolved.profile, 'autonomous');
  assert.ok(resolved.loaded.some(entry => entry.kind === 'required-skill' && entry.content));
});
