// Exercise the packed artifact in isolation, including its npm-generated executable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run test:package');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), fs.readFileSync(file).toString('base64')];
    }).sort(([a], [b]) => a.localeCompare(b));
}

try {
  const [artifact] = JSON.parse(run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], project));
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  assert.equal(artifact.name, 'agent-profiles');
  assert.equal(artifact.version, manifest.version);
  const files = new Set(artifact.files.map(file => file.path));
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md', 'package.json', 'bin/agent-profiles.js', 'src/configure.js', 'src/files.js',
    'src/integrations.js', 'src/install.js', 'src/resolve.js', 'src/skills.js', 'src/wizard.js', 'scripts/resolve.js',
    '.agent-profiles/agents.yaml', '.agent-profiles/BOOTSTRAP.md', 'docs/configure.md', 'src/presets.js',
    'src/preset-wizard.js', 'examples/presets/release-review/preset.yaml']) assert.ok(files.has(file), `Missing package file: ${file}`);
  for (const file of files) {
    assert.ok(/^(bin\/|src\/|docs\/|examples\/presets\/|\.agent-profiles\/|scripts\/resolve\.js$|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$|CONTRIBUTING\.md$)/.test(file), `Unexpected package file: ${file}`);
  }
  const consumer = path.join(temporary, 'consumer with spaces');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"name":"smoke-consumer","private":true}');
  run(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=false', path.join(temporary, artifact.filename)], consumer);
  const installed = path.join(consumer, 'node_modules/agent-profiles');
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(installedManifest.license, 'Apache-2.0');
  assert.equal(installedManifest.version, manifest.version);
  assert.deepEqual(Object.keys(installedManifest.dependencies), ['yaml']);
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules/typescript')), false);
  const cli = (...args) => run(process.execPath, [npm, 'exec', '--offline', '--', 'agent-profiles', ...args], consumer);
  for (const command of ['init', 'configure', 'doctor', 'uninstall']) assert.match(cli(command, '--help'), new RegExp(command));
  const { configureRoles } = await import(pathToFileURL(path.join(installed, 'src/wizard.js')).href);
  const { resolveInstructions } = await import(pathToFileURL(path.join(installed, 'src/resolve.js')).href);
  const { planPresetExport, applyPresetExport, planPresetImport, applyPresetImport } = await import(pathToFileURL(path.join(installed, 'src/presets.js')).href);
  assert.match(cli('preset', 'inspect', path.join(installed, 'examples/presets/release-review')), /Release Review/);

  for (const scenario of ['empty', 'existing instructions', 'alternate targets']) {
    const root = path.join(temporary, scenario);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
    const originals = { 'package.json': fs.readFileSync(path.join(root, 'package.json')) };
    if (scenario !== 'empty') {
      originals['AGENTS.md'] = Buffer.from('\uFEFF# Repository invariants\r\nPreserve these rules.');
      originals[scenario === 'alternate targets' ? '.claude/CLAUDE.md' : 'CLAUDE.md'] = Buffer.from('# Claude rules\nKeep these too.\n');
      if (scenario === 'alternate targets') originals['AGENTS.override.md'] = Buffer.from('# Override\nRespect repository invariants.');
    }
    for (const [file, content] of Object.entries(originals)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    cli('init', '--root', root, '--agent', 'claude', '--agent', 'codex');
    const targets = scenario === 'alternate targets' ? ['.claude/CLAUDE.md', 'AGENTS.override.md'] : ['CLAUDE.md', 'AGENTS.md'];
    for (const file of targets) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.equal(text.split('<!-- agent-profiles:start -->').length, 2);
      assert.ok(text.includes('.agent-profiles/agents.yaml') && text.includes('.agent-profiles/BOOTSTRAP.md'));
    }
    const initial = snapshot(root);
    cli('init', '--root', root, '--agent', 'codex', '--agent', 'claude');
    assert.deepEqual(snapshot(root), initial);
    for (const { model, family, profile, matchedBy } of [
      { model: 'example-model', family: 'example-family', profile: 'autonomous', matchedBy: 'model' },
      { model: 'unknown', family: 'example-family', profile: 'scaffolded', matchedBy: 'family' },
      { model: 'unknown', profile: 'constrained', matchedBy: 'default' },
    ]) {
      const resolved = resolveInstructions({ root, role: 'reviewer', model, family });
      assert.equal(resolved.profile, profile);
      assert.equal(resolved.matchedBy, matchedBy);
      assert.equal(resolved.role, 'reviewer');
      assert.ok(resolved.loaded.some(item => item.path.endsWith('code-review/SKILL.md')));
      assert.ok(!resolved.loaded.some(item => item.path.endsWith('testing/SKILL.md')));
      assert.ok(resolved.available.some(item => item.id === 'testing'));
    }
    assert.ok(resolveInstructions({ root, role: 'reviewer', skills: ['testing'] }).loaded.some(item => item.path.endsWith('testing/SKILL.md')));
    const answers = ['c', 'release-reviewer', 'Review releases.', '', '1', '', '1', '', 'y', 'q'];
    await configureRoles({ root, ask: async () => { assert.ok(answers.length); return answers.shift(); }, write: () => {} });
    assert.equal(answers.length, 0);
    const configured = resolveInstructions({ root, role: 'release-reviewer' });
    assert.deepEqual(configured.required.map(skill => skill.id), ['code-review']);
    assert.deepEqual(configured.available.map(skill => skill.id), ['testing']);
    for (const file of ['profiles/constrained.md', 'roles/release-reviewer.md']) fs.appendFileSync(path.join(root, '.agent-profiles', file), '\nUser customization.\n');
    const customized = snapshot(path.join(root, '.agent-profiles'));
    cli('init', '--root', root, '--agent', 'claude', '--agent', 'codex');
    cli('doctor', '--root', root);
    assert.deepEqual(snapshot(path.join(root, '.agent-profiles')), customized);
    cli('uninstall', '--root', root);
    assert.deepEqual(snapshot(path.join(root, '.agent-profiles')), customized);
    for (const [file, content] of Object.entries(originals)) assert.deepEqual(fs.readFileSync(path.join(root, file)), content);
    for (const file of targets) assert.ok(!fs.readFileSync(path.join(root, file), 'utf8').includes('<!-- agent-profiles:start -->'));
    const destination = path.join(temporary, `preset ${scenario}`);
    applyPresetExport(planPresetExport({ root, destination, roles: ['release-reviewer'], profiles: [],
      includeSkills: ['code-review', 'testing'],
      metadata: { name: 'smoke', display_name: 'Smoke', description: 'Package test', author: 'Test', version: '1', license: 'Apache-2.0' },
    }), true);
    assert.match(cli('preset', 'inspect', destination, '--root', root), /Conflict: roles.release-reviewer/);
    const decisions = new Map([['roles.release-reviewer', 'rename:preset-reviewer'], ['skills.code-review', 'keep'], ['skills.testing', 'keep']]);
    applyPresetImport(planPresetImport({ root, source: destination, decisions }), true);
    assert.deepEqual(resolveInstructions({ root, role: 'preset-reviewer' }).required.map(skill => skill.id), ['code-review']);
    console.log(`Packed workflow passed: ${scenario} (including preset inspect/export/import)`);
  }
  console.log(`Verified ${artifact.name}@${artifact.version}: ${files.size} package files, ${artifact.size} bytes compressed.`);
} finally {
  // Only remove the exact temporary directory created by this script.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('agent-profiles-package-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
