import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { configureRoles, selectSkills } from '../src/wizard.js';
import { bootstrapAvailability, doctor, install, uninstall } from '../src/install.js';
import { formatContext } from '../src/diagnostics.js';
import { resolveInstructions } from '../src/resolve.js';
import { runPreset } from '../src/preset-wizard.js';
import { startVisualizer } from '../src/visualize.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version;
const npm = process.env.npm_execpath ?? path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-review-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  return root;
}
function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}
function change(root, edit) {
  const file = path.join(root, '.agent-profiles/agents.yaml');
  const config = parse(fs.readFileSync(file, 'utf8'));
  edit(config);
  fs.writeFileSync(file, stringify(config));
}
function nativeSkills(root) {
  change(root, config => {
    config.skills = { one: { host: 'claude', scope: 'user' }, two: { host: 'claude', scope: 'plugin', id: 'kit:two' } };
    config.roles.researcher.skills = { required: ['one'], available: ['two'] };
  });
}
function executable(root, installedVersion = version, realCLI = false) {
  write(root, 'package.json', '{"private":true}');
  const target = path.join(root, 'node_modules/agent-profiles');
  write(root, 'node_modules/agent-profiles/package.json', JSON.stringify({ name: 'agent-profiles', version: installedVersion, type: 'module', bin: { 'agent-profiles': 'bin/agent-profiles.js' } }));
  if (realCLI) {
    for (const dir of ['src', 'bin', '.agent-profiles']) fs.cpSync(path.join(project, dir), path.join(target, dir), { recursive: true });
    fs.cpSync(path.join(project, 'node_modules/yaml'), path.join(root, 'node_modules/yaml'), { recursive: true });
  } else write(root, 'node_modules/agent-profiles/bin/agent-profiles.js', `#!/usr/bin/env node\nconsole.log(${JSON.stringify(installedVersion)});\n`);
  const bin = path.join(root, 'node_modules/.bin/agent-profiles');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  if (process.platform === 'win32') {
    write(root, 'node_modules/.bin/agent-profiles', '#!/bin/sh\nexec node "$basedir/../agent-profiles/bin/agent-profiles.js" "$@"\n');
    write(root, 'node_modules/.bin/agent-profiles.cmd', '@echo off\r\nnode "%~dp0..\\agent-profiles\\bin\\agent-profiles.js" %*\r\n');
  } else {
    fs.chmodSync(path.join(target, 'bin/agent-profiles.js'), 0o755);
    fs.symlinkSync('../agent-profiles/bin/agent-profiles.js', bin);
  }
}

test('review #1: pathless host resources remain selectable and survive role editing', async t => {
  const root = fixture(t);
  nativeSkills(root);
  const result = resolveInstructions({ root, role: 'researcher' });
  const choices = [...result.required, ...result.available];
  const answers = ['1 2', ''];
  assert.deepEqual((await selectSkills({ choices, label: 'Skills', ask: async () => answers.shift(), write: () => {} })).map(s => s.id), ['one', 'two']);
  const edits = ['e', 'researcher', '', '', '', '', 'y', 'q'];
  await configureRoles({ root, ask: async () => edits.shift(), write: () => {} });
  assert.deepEqual(resolveInstructions({ root, role: 'researcher' }).available.map(s => s.id), ['two']);
});

test('review #2: availability follows the ancestor executable instead of unrelated metadata', t => {
  const parent = fixture(t);
  executable(parent, '9.9.9');
  const root = path.join(parent, 'child');
  write(root, 'package.json', '{"private":true}');
  write(root, 'node_modules/agent-profiles/package.json', JSON.stringify({ name: 'agent-profiles', version, bin: { 'agent-profiles': 'missing.js' } }));
  const actual = spawnSync(process.execPath, [npm, 'exec', '--offline', '--no', '--cache', path.join(parent, 'cache'), '--', 'agent-profiles'], { cwd: root, encoding: 'utf8' });
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(actual.stdout.trim(), '9.9.9');
  assert.equal(bootstrapAvailability(root).version, '9.9.9');
  assert.equal(bootstrapAvailability(root).runnable, false);
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  assert.equal(bootstrapAvailability(root).version, '9.9.9');
});

test('review #2: package metadata without a working executable is not runnable', t => {
  const root = fixture(t);
  write(root, 'package.json', JSON.stringify({ name: 'agent-profiles', version }));
  assert.equal(bootstrapAvailability(root).runnable, false);
});

test('review #3: the installed bootstrap resolves its non-Git installation', t => {
  const root = fixture(t);
  executable(root, version, true);
  install({ root, agents: ['codex'] });
  const block = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const line = block.split(/\r?\n/).find(value => value.trim().startsWith('npx --no'));
  assert.ok(line);
  const command = line.trim().replace(/"<exact model ID>"|'<exact model ID>'/, 'example-model');
  // Execute the generated command using npm's executable, without shell evaluation of identity input.
  const args = command.split(/\s+/).slice(3);
  const result = spawnSync(process.execPath, [npm, 'exec', '--offline', '--no', '--cache', path.join(root, 'cache'), '--', 'agent-profiles', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Profile: autonomous/);
  const nested = path.join(root, 'work/subdir');
  fs.mkdirSync(nested, { recursive: true });
  const fromNested = spawnSync(process.execPath, [npm, 'exec', '--offline', '--no', '--cache', path.join(root, 'cache'), '--', 'agent-profiles', ...args], { cwd: nested, encoding: 'utf8' });
  assert.equal(fromNested.status, 0, fromNested.stderr);
  assert.match(fromNested.stdout, /Profile: autonomous/);
});

test('review #4: Codex output never asks to read shadowed AGENTS.md', t => {
  const root = fixture(t);
  write(root, 'AGENTS.md', 'Shadowed rules');
  write(root, 'AGENTS.override.md', 'Active rules');
  install({ root, agents: ['codex'] });
  assert.ok(!formatContext(resolveInstructions({ root, host: 'codex' })).includes('Read it now'));
  assert.match(formatContext(resolveInstructions({ root, host: 'claude' })), /Read it now/);
});

test('review #5: rerun commands retain explicitly supplied family inputs', t => {
  const root = fixture(t);
  const result = resolveInstructions({ root, host: 'codex', model: 'unknown', family: 'example-family' });
  assert.match(formatContext(result), /--family ['"]?example-family/);
});

test('review #6: shell rendering round-trips identities as data', t => {
  const root = fixture(t);
  const identities = ['space identity', 'double"quote', "single'quote", '$HOME $(payload) `payload` ; & | < >', 'line\nbreak'];
  for (const model of identities) {
    const output = formatContext(resolveInstructions({ root, host: 'codex', model, family: model }));
    // Parse literal quoting, never execute an injection payload or a generated shell command.
    for (const [shell, decode] of [
      ['Bash', value => value.slice(1, -1).replaceAll("'\"'\"'", "'")],
      ['PowerShell', value => value.slice(1, -1).replaceAll("''", "'")],
    ]) {
      const command = output.match(new RegExp(`Command \\(${shell}\\): \\x60([\\s\\S]*?)\\x60(?:\\n|$)`))?.[1]
        ?? output.match(/Command: `([\s\S]*?)`(?:\n|$)/)?.[1];
      assert.ok(command, `${shell} command missing`);
      const modelArg = command.slice(command.indexOf('--model ') + 8, command.indexOf(' --family'));
      assert.ok(modelArg.startsWith("'") && modelArg.endsWith("'"), `${shell} identity is not rendered as a literal argument`);
      assert.equal(decode(modelArg), model);
      assert.equal(decode(command.slice(command.indexOf('--family ') + 9)), model);
    }
  }
  for (const key of ['model', 'family']) assert.throws(() => resolveInstructions({ root, [key]: 'nul\0value' }), /NUL/);
});

test('review #7: visualizer initial family reflects input rather than inferred routing', async t => {
  const root = fixture(t);
  change(root, config => { config.families = { alpha: { profile: 'autonomous', match: { prefixes: ['alpha-'] } }, beta: { profile: 'scaffolded', match: { prefixes: ['beta-'] } } }; });
  const app = await startVisualizer({ root, model: 'alpha-1' });
  t.after(() => { app.server.close(); app.server.closeAllConnections(); });
  const { initial } = await (await fetch(app.url + 'api/config')).json();
  assert.equal(initial.family, null);
  const query = new URLSearchParams({ model: 'beta-1' });
  if (initial.family) query.set('family', initial.family);
  assert.equal((await (await fetch(app.url + 'api/resolve?' + query)).json()).profile, 'scaffolded');
});

test('review #8: interactive export keeps native skills as references', async t => {
  const root = fixture(t);
  nativeSkills(root);
  const destination = path.join(root, 'exported');
  const messages = [];
  await runPreset({ command: 'export', location: destination, root, roles: ['researcher'], write: value => messages.push(value), ask: async prompt => prompt.startsWith('Preset ') ? 'sample' : prompt.startsWith('Export this') ? 'y' : '' });
  const exported = parse(fs.readFileSync(path.join(destination, 'preset.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(exported.skills.host), ['one', 'two']);
  assert.deepEqual(exported.skills.includes, {});
  assert.ok(!messages.some(value => value.includes('Skills to include')));
});

test('review #9: uninstall preserves pre-existing rules for selected and unselected hosts', t => {
  for (const host of ['codex', 'claude']) {
    const root = fixture(t);
    const original = '{"custom":true,"permissions":{"allow":["Bash(npx --no agent-profiles resolve:*)","Read(*)"]}}\n';
    write(root, '.claude/settings.json', original);
    install({ root, agents: [host] });
    uninstall({ root });
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude/settings.json')));
    assert.deepEqual(settings, JSON.parse(original));
  }
});

test('review #10: doctor describes host compatibility without proving invocation', t => {
  const root = fixture(t);
  nativeSkills(root);
  install({ root, agents: ['claude'] });
  const output = spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'doctor', '--root', root], { encoding: 'utf8' }).stdout;
  assert.ok(!output.includes('every role is satisfiable'));
  assert.ok(doctor(root).notes.some(value => /invocation.*not verified/i.test(value)));
});
