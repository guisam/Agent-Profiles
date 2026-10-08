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

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120000 });
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
    'src/integrations.js', 'src/install.js', 'src/resolve.js', 'src/skills.js', 'src/discovery-diagnostics.js', 'src/wizard.js', 'src/inspect.js', 'docs/setup.md', 'src/external-skills.js', 'docs/hosts/external-skill-sources.md',
    '.agent-profiles/agents.yaml', '.agent-profiles/BOOTSTRAP.md', 'docs/configure.md', 'src/presets.js',
    'src/preset-wizard.js', 'src/diagnostics.js', 'docs/proof.md', 'src/visualize.js', 'src/visualizer/index.html',
    'src/visualizer/app.js', 'src/visualizer/style.css', 'docs/visualize.md', 'docs/hosts/hermes.md', 'examples/presets/release-review/preset.yaml']) assert.ok(files.has(file), `Missing package file: ${file}`);
  for (const file of files) {
    assert.ok(/^(bin\/|src\/|docs\/|examples\/presets\/|\.agent-profiles\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$|CONTRIBUTING\.md$)/.test(file), `Unexpected package file: ${file}`);
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
  for (const command of ['inspect', 'init', 'resolve', 'configure', 'skills', 'doctor', 'uninstall', 'visualize']) assert.match(cli(command, '--help'), new RegExp(command));
  const { configureRoles } = await import(pathToFileURL(path.join(installed, 'src/wizard.js')).href);
  const { resolveInstructions } = await import(pathToFileURL(path.join(installed, 'src/resolve.js')).href);
  const { planRoleChange, applyRoleChange } = await import(pathToFileURL(path.join(installed, 'src/configure.js')).href);
  const { startVisualizer } = await import(pathToFileURL(path.join(installed, 'src/visualize.js')).href);
  const { planPresetExport, applyPresetExport, planPresetImport, applyPresetImport } = await import(pathToFileURL(path.join(installed, 'src/presets.js')).href);
  assert.match(cli('preset', 'inspect', path.join(installed, 'examples/presets/release-review')), /Release Review/);

  for (const scenario of ['empty', 'existing instructions', 'alternate targets']) {
    const root = path.join(temporary, scenario);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}\n');
    // Like a user, install the package into the target so its bootstrap command can run there.
    run(process.execPath, [npm, 'install', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', path.join(temporary, artifact.filename)], root);
    const originals = { 'package.json': fs.readFileSync(path.join(root, 'package.json')) };
    if (scenario !== 'empty') {
      originals['AGENTS.md'] = Buffer.from('\uFEFF# Repository invariants\r\nPreserve these rules.');
      originals[scenario === 'alternate targets' ? '.claude/CLAUDE.md' : 'CLAUDE.md'] = Buffer.from('# Claude rules\nKeep these too.\n');
      originals[scenario === 'alternate targets' ? 'HERMES.md' : '.hermes.md'] = Buffer.from('\uFEFF# Hermes project rules\r\nKeep runtime profiles separate.');
      if (scenario === 'alternate targets') originals['AGENTS.override.md'] = Buffer.from('# Override\nRespect repository invariants.');
    }
    for (const [file, content] of Object.entries(originals)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    for (const file of ['orchestrator.toml', 'adr-orchestrator.toml', 't3.json']) fs.writeFileSync(path.join(root, file), 'PRIVATE-WORKFLOW-CONTENT { malformed');
    const broken = path.join(root, '.claude/skills/broken/SKILL.md');
    fs.mkdirSync(path.dirname(broken), { recursive: true });
    fs.writeFileSync(broken, '---\nname: broken\ndescription: Review\nprivate_token: [PRIVATE-FRONTMATTER-CONTENT\n---\nPRIVATE-BODY');
    const beforeApproval = snapshot(root);
    const inspected = JSON.parse(cli('inspect', '--root', root, '--json'));
    assert.equal(inspected.skills.status, 'partial');
    assert.ok(inspected.skills.warnings.length);
    assert.doesNotMatch(JSON.stringify(inspected), /private_token|PRIVATE-|at line|column/);
    for (const file of ['orchestrator.toml', 'adr-orchestrator.toml', 't3.json']) assert.ok(inspected.repository.workflows.some(record => record.path === file && record.availability === 'available'));
    assert.doesNotMatch(cli('inspect', '--root', root), /private_token|PRIVATE-|at line|column/);
    assert.equal(inspected.schemaVersion, 1);
    assert.equal(inspected.repository.installation.status, 'not-installed');
    assert.equal(inspected.environment.scope, 'machine');
    assert.deepEqual(snapshot(root), beforeApproval);
    cli('init', '--root', root, '--agent', 'claude', '--agent', 'codex', '--agent', 'hermes');
    const afterApproval = snapshot(root);
    const configuredInventory = JSON.parse(cli('inspect', '--root', root, '--json'));
    assert.equal(configuredInventory.repository.configuration.status, 'valid');
    assert.ok(configuredInventory.hosts.every(host => host.configured && host.currentInvocation === 'unverified'));
    assert.deepEqual(snapshot(root), afterApproval);
    const targets = scenario === 'alternate targets' ? ['.claude/CLAUDE.md', 'AGENTS.override.md', 'HERMES.md'] : ['CLAUDE.md', 'AGENTS.md', '.hermes.md'];
    for (const file of targets) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.equal(text.split('<!-- agent-profiles:start -->').length, 2);
      const host = file.includes('CLAUDE') ? 'claude' : /hermes/i.test(file) ? 'hermes' : 'codex';
      assert.ok(text.includes(`npx --no agent-profiles resolve --host ${host} --identity-source host-stated --model`));
    }
    // The exact bootstrap command must work from the installed package without downloading anything.
    const context = run(process.execPath, [npm, 'exec', '--no', '--offline', '--', 'agent-profiles', 'resolve', '--root', root, '--host', 'claude', '--model', 'example-model', '--role', 'reviewer'], consumer);
    assert.ok(context.startsWith('# Agent Profiles context') && context.includes('## Required skill: code-review'));
    const hermesContext = run(process.execPath, [npm, 'exec', '--no', '--offline', '--', 'agent-profiles', 'resolve', '--root', root, '--host', 'hermes', '--model', 'example-model', '--role', 'reviewer', '--json', '--contents'], consumer);
    const hermes = JSON.parse(hermesContext);
    assert.equal(hermes.host, 'hermes');
    assert.equal(hermes.profile, 'autonomous');
    assert.deepEqual(hermes.required.map(skill => skill.id), ['code-review']);
    assert.ok(hermes.loaded.some(entry => entry.kind === 'required-skill' && entry.content));
    const initial = snapshot(root);
    cli('init', '--root', root, '--agent', 'codex', '--agent', 'claude', '--agent', 'hermes');
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
    cli('init', '--root', root, '--agent', 'claude', '--agent', 'codex', '--agent', 'hermes');
    cli('doctor', '--root', root);
    assert.deepEqual(snapshot(path.join(root, '.agent-profiles')), customized);
    cli('uninstall', '--root', root);
    assert.deepEqual(snapshot(path.join(root, '.agent-profiles')), customized.filter(([file]) => file !== 'permissions.json'));
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
    const proof = JSON.parse(cli('proof', '--root', root, '--role', 'preset-reviewer', '--json'));
    const requested = JSON.parse(cli('proof', '--root', root, '--role', 'preset-reviewer', '--skill', 'testing', '--json', '--contents'));
    assert.equal(requested.diagnostics.managed.total.bytes - proof.diagnostics.managed.total.bytes, proof.diagnostics.availableNotLoaded.bytes);
    assert.equal(requested.diagnostics.availableNotLoaded.files, 0);
    assert.ok(proof.loaded.every(entry => !Object.hasOwn(entry, 'content') && typeof entry.characters === 'number'));
    assert.match(cli('proof', '--root', root, '--role', 'preset-reviewer'), /Host context:.*unobserved/);
    const visualizer = await startVisualizer({ root, role: 'preset-reviewer' });
    try {
      for (const asset of ['', 'app.js', 'style.css']) assert.equal((await fetch(visualizer.url + asset)).status, 200);
      const visual = await (await fetch(visualizer.url + 'api/resolve?role=preset-reviewer&skill=testing')).json();
      assert.deepEqual(visual, requested);
    } finally {
      await new Promise(resolve => { visualizer.server.close(resolve); visualizer.server.closeAllConnections(); });
    }
    const externalHome = path.join(temporary, `skill home ${scenario}`);
    const externalFile = path.join(externalHome, '.agents/skills/packaged-audit/SKILL.md');
    fs.mkdirSync(path.dirname(externalFile), { recursive: true });
    fs.writeFileSync(externalFile, '---\nname: packaged-audit\ndescription: Packed native audit.\n---\nEXTERNAL-BODY-NOT-INJECTED\n');
    const sourcesFile = path.join(externalHome, 'sources.json');
    fs.writeFileSync(sourcesFile, JSON.stringify({ version: 1, roots: [] }));
    const externalEnv = { ...process.env, USERPROFILE: externalHome, HOME: externalHome,
      CLAUDE_CONFIG_DIR: path.join(externalHome, '.claude'), CODEX_HOME: path.join(externalHome, '.codex'), AGENT_PROFILES_SKILL_SOURCES: sourcesFile };
    const beforeInventory = snapshot(root);
    const inventory = JSON.parse(run(process.execPath, [npm, 'exec', '--offline', '--', 'agent-profiles', 'skills', '--root', root, '--external', '--sources', sourcesFile, '--json'], consumer, externalEnv));
    const setupInventory = JSON.parse(run(process.execPath, [npm, 'exec', '--offline', '--', 'agent-profiles', 'inspect', '--root', root, '--sources', sourcesFile, '--json'], consumer, externalEnv));
    assert.ok(setupInventory.skills.skills.some(skill => skill.host === 'codex' && skill.hostId === 'packaged-audit'));
    assert.ok(!JSON.stringify(setupInventory).includes('EXTERNAL-BODY-NOT-INJECTED'));
    const native = inventory.skills.find(skill => skill.host === 'codex' && skill.hostId === 'packaged-audit');
    assert.ok(native, 'Packed executable must discover native external metadata');
    assert.ok(!JSON.stringify(inventory).includes('EXTERNAL-BODY-NOT-INJECTED'));
    assert.deepEqual(snapshot(root), beforeInventory);
    const sourceOptions = { home: externalHome, env: externalEnv, sourcesFile };
    applyRoleChange(planRoleChange({ root, action: 'create', id: 'external-qa', available: [native], sourceOptions }));
    const nativeResolution = resolveInstructions({ root, role: 'external-qa', host: 'codex' });
    assert.equal(nativeResolution.available[0].hostId, 'packaged-audit');
    assert.equal(nativeResolution.available[0].bytes, null);
    assert.ok(!fs.readFileSync(path.join(root, '.agent-profiles/agents.yaml'), 'utf8').includes(externalHome));
    assert.ok(!JSON.stringify(nativeResolution).includes('EXTERNAL-BODY-NOT-INJECTED'));
    console.log(`Packed workflow passed: ${scenario} (including pre/post-approval inspect, presets, proof, visualizer, and external inventory)`);
  }
  console.log(`Verified ${artifact.name}@${artifact.version}: ${files.size} package files, ${artifact.size} bytes compressed.`);
} finally {
  // Only remove the exact temporary directory created by this script.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('agent-profiles-package-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
