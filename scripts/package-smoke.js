// Exercise the packed artifact in isolation, including its npm-generated executable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run with npm run test:package');
const environment = { ...process.env };
for (const key of Object.keys(environment)) if (/^npm_config_/i.test(key)) delete environment[key];
delete environment.NODE_OPTIONS;
delete environment.AGENT_PROFILES_SKILL_SOURCES;

function run(command, args, cwd, env = environment) {
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
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  const userconfig = path.join(temporary, 'npm-user.npmrc'), globalconfig = path.join(temporary, 'npm-global.npmrc');
  fs.writeFileSync(userconfig, ''); fs.writeFileSync(globalconfig, '');
  Object.assign(environment, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'), AGENT_PROFILES_STORE: path.join(home, 'unused-store'),
    TMP: temporary, TEMP: temporary, TMPDIR: temporary,
    npm_config_cache: path.join(temporary, 'npm-cache'), npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' });
  const [artifact] = JSON.parse(run(process.execPath, [npm, 'pack', '--offline', '--json', '--ignore-scripts', '--pack-destination', temporary], project));
  const yamlRoot = path.join(project, 'node_modules/yaml');
  assert.equal(JSON.parse(fs.readFileSync(path.join(yamlRoot, 'package.json'), 'utf8')).version, '2.9.1');
  const [yamlArtifact] = JSON.parse(run(process.execPath, [npm, 'pack', '--offline', '--json', '--ignore-scripts', '--pack-destination', temporary], yamlRoot));
  assert.equal(yamlArtifact.name, 'yaml'); assert.equal(yamlArtifact.version, '2.9.1');
  const tarballs = [artifact, yamlArtifact].map(packed => path.join(temporary, packed.filename));
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  assert.equal(artifact.name, 'agent-profiles');
  assert.equal(artifact.version, manifest.version);
  const files = new Set(artifact.files.map(file => file.path));
  const versionedFiles = ['src/packages.js', 'src/package-store.js', 'src/package-lock.js', 'src/stamps.js', 'src/materialize.js',
    'docs/versioned-packages.md', 'docs/migrations/README.md', 'docs/migrations/config-v1-to-v2.md',
    'docs/migrations/prompts/config-v1-to-v2.md'];
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md', 'package.json', 'bin/agent-profiles.js', 'src/configure.js', 'src/files.js',
    'src/integrations.js', 'src/install.js', 'src/resolve.js', 'src/skills.js', 'src/discovery-diagnostics.js', 'src/wizard.js', 'src/inspect.js', 'docs/setup.md', 'src/external-skills.js', 'docs/hosts/external-skill-sources.md',
    '.agent-profiles/agents.yaml', '.agent-profiles/BOOTSTRAP.md', 'docs/configure.md', 'src/presets.js',
    'src/preset-wizard.js', 'src/diagnostics.js', 'docs/proof.md', 'src/visualize.js', 'src/visualizer/index.html',
    'src/visualizer/app.js', 'src/visualizer/style.css', 'docs/visualize.md', 'docs/hosts/hermes.md', 'examples/presets/release-review/preset.yaml',
    ...versionedFiles]) assert.ok(files.has(file), `Missing package file: ${file}`);
  for (const file of files) {
    assert.ok(/^(bin\/|src\/|docs\/|examples\/presets\/|\.agent-profiles\/|package\.json$|README\.md$|LICENSE$|CHANGELOG\.md$|CONTRIBUTING\.md$)/.test(file), `Unexpected package file: ${file}`);
  }
  const consumer = path.join(temporary, 'consumer with spaces');
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), '{"name":"smoke-consumer","private":true}');
  run(process.execPath, [npm, 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--package-lock=false', ...tarballs], consumer);
  const installed = path.join(consumer, 'node_modules/agent-profiles');
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  assert.equal(installedManifest.license, 'Apache-2.0');
  assert.equal(installedManifest.version, manifest.version);
  assert.deepEqual(Object.keys(installedManifest.dependencies), ['yaml']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(consumer, 'node_modules/yaml/package.json'), 'utf8')).version, '2.9.1');
  for (const file of versionedFiles) assert.deepEqual(fs.readFileSync(path.join(installed, file)), fs.readFileSync(path.join(project, file)), `Installed bytes: ${file}`);
  assert.equal(fs.existsSync(path.join(consumer, 'node_modules/typescript')), false);
  const cli = (...args) => run(process.execPath, [npm, 'exec', '--offline', '--', 'agent-profiles', ...args], consumer);
  for (const command of ['inspect', 'init', 'resolve', 'configure', 'skills', 'doctor', 'uninstall', 'visualize',
    'add', 'install', 'stamp', 'verify', 'diff', 'materialize']) assert.match(cli(command, '--help'), new RegExp(command));
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
    run(process.execPath, [npm, 'install', '--save-dev', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], root);
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
    const externalEnv = { ...environment, USERPROFILE: externalHome, HOME: externalHome,
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
    const portablePath = '.agents/skills/portable-check/SKILL.md';
    const portableBody = '---\nname: portable-check\ndescription: Portable evidence review.\n---\nPreserve the supplied evidence.\n';
    fs.mkdirSync(path.dirname(path.join(root, portablePath)), { recursive: true });
    fs.writeFileSync(path.join(root, portablePath), portableBody);
    const configPath = path.join(root, '.agent-profiles/agents.yaml');
    const portableConfig = parse(fs.readFileSync(configPath, 'utf8'));
    portableConfig.skills ??= {};
    portableConfig.skills['portable-check'] = { file: portablePath };
    portableConfig.roles['portable-check'] = { file: 'roles/portable-check.md', skills: { required: ['portable-check'], available: [] } };
    fs.writeFileSync(path.join(root, '.agent-profiles/roles/portable-check.md'), '# Portable check\nReview evidence without changing authority.\n');
    fs.writeFileSync(configPath, stringify(portableConfig));
    const portableConfiguration = fs.readFileSync(configPath);
    cli('init', '--root', root, '--agent', 'claude', '--agent', 'codex', '--agent', 'hermes');
    const portableInstalled = snapshot(root);
    cli('doctor', '--root', root);
    for (const host of ['claude', 'codex', 'hermes']) {
      const routed = JSON.parse(cli('resolve', '--root', root, '--host', host, '--role', 'portable-check', '--json', '--contents'));
      assert.deepEqual(routed.required.map(skill => skill.id), ['portable-check']);
      assert.equal(routed.loaded.find(entry => entry.kind === 'required-skill').content, portableBody);
    }
    cli('init', '--root', root, '--agent', 'claude', '--agent', 'codex', '--agent', 'hermes');
    assert.deepEqual(snapshot(root), portableInstalled);
    assert.deepEqual(fs.readFileSync(configPath), portableConfiguration);
    console.log(`Packed workflow passed: ${scenario} (including pre/post-approval inspect, presets, proof, visualizer, external inventory, and portable instruction mappings)`);
  }
  // One package workflow, separate from the three unchanged legacy scenarios.
  {
    const root = path.join(temporary, 'versioned project'), store = path.join(temporary, 'package store');
    const sources = path.join(temporary, 'package sources'), outputs = path.join(temporary, 'package exports');
    const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
    fs.mkdirSync(root); fs.mkdirSync(outputs);
    const name = '@example/smoke-profile', role = Buffer.from('# Reviewer\r\nKeep exact evidence.\r\n');
    const revisions = ['1.0.0', '2.0.0'].map((version, i) => {
      const directory = path.join(sources, version);
      const members = {
        'entry.md': Buffer.from(`\uFEFF# Profile ${version}\r\nRevision ${i + 1}.\r\n\r\n `),
        'package.yaml': Buffer.from(stringify({ schema_version: 1, package: { name, version, type: 'instruction' },
          entrypoint: 'entry.md', behavior: { delivery: 'instruction', hosts: [], effects: [] } })),
        'support/data.bin': Buffer.from([0, 255, i + 1, 13, 10]),
      };
      for (const [file, bytes] of Object.entries(members)) put(path.join(directory, file), bytes);
      const added = JSON.parse(cli('add', `${name}@${version}`, '--root', root, '--source', directory, '--store', store, '--json'));
      assert.deepEqual(added.identity, { name, version }); assert.equal(added.status, 'published');
      assert.match(added.sha256, /^[a-f0-9]{64}$/);
      const original = snapshot(directory);
      assert.deepEqual(snapshot(path.join(store, 'objects/sha256', added.sha256, 'tree')), original);
      return { version, directory, members, original, digest: added.sha256, stamp: '' };
    });
    assert.notEqual(revisions[0].digest, revisions[1].digest);
    const configFile = path.join(root, '.agent-profiles/agents.yaml');
    const config = { version: 2, default_profile: 'base', default_role: 'reviewer', models: {}, families: {},
      profiles: { base: { package: name, version: '1.0.0' } },
      roles: { reviewer: { file: 'roles/reviewer.md', skills: { required: [], available: [] } } }, skills: {} };
    put(path.join(root, '.agent-profiles/roles/reviewer.md'), role);
    for (const revision of revisions) {
      config.profiles.base.version = revision.version;
      put(configFile, stringify(config));
      assert.deepEqual(JSON.parse(cli('install', '--root', root, '--store', store, '--offline', '--json')), { lockState: 'valid', installRequired: false });
      const selected = JSON.parse(cli('resolve', '--root', root, '--store', store, '--host', 'codex', '--json', '--contents'));
      assert.equal(selected.lockState, 'valid'); assert.equal(selected.profile, 'base'); assert.equal(selected.role, 'reviewer');
      assert.deepEqual(selected.loaded.map(e => e.kind), ['profile', 'role']);
      assert.deepEqual(selected.loaded[0].package, { binding: 'profiles.base', name, version: revision.version,
        sha256: revision.digest, selectedBy: 'binding-default', selectors: {} });
      assert.equal(selected.loaded[0].content, revision.members['entry.md'].toString('utf8'));
      revision.stamp = JSON.parse(cli('stamp', '--root', root, '--store', store, '--host', 'codex', '--json')).digest;
      assert.match(revision.stamp, /^[a-f0-9]{64}$/);
      const verified = JSON.parse(cli('verify', revision.stamp, '--store', store, '--json'));
      assert.equal(verified.managedReproducible, true); assert.equal(verified.completeRuntimeReproducible, false);
    }
    assert.notEqual(revisions[0].stamp, revisions[1].stamp);
    const diff = JSON.parse(cli('diff', revisions[0].stamp, revisions[1].stamp, '--store', store, '--json'));
    assert.equal(diff.complete, true); assert.ok(diff.changes.length > 0);
    assert.deepEqual(diff.changes.find(change => change.path === '/packages/0/version'),
      { path: '/packages/0/version', kind: 'changed', before: '1.0.0', after: '2.0.0' });
    assert.deepEqual(diff.changes.find(change => change.path === '/packages/0/sha256'),
      { path: '/packages/0/sha256', kind: 'changed', before: revisions[0].digest, after: revisions[1].digest });

    const fresh = path.join(temporary, 'fresh package project'), freshStore = path.join(temporary, 'fresh package store');
    fs.cpSync(root, fresh, { recursive: true });
    const lockFile = path.join(fresh, '.agent-profiles/agent-profiles.lock'), lockBytes = fs.readFileSync(lockFile);
    assert.equal(fs.existsSync(freshStore), false, 'fresh store has no cached objects');
    assert.deepEqual(JSON.parse(cli('install', '--root', fresh, '--store', freshStore, '--frozen-lockfile', '--offline',
      '--source', name, '2.0.0', revisions[1].directory, '--json')), { lockState: 'valid', installRequired: false });
    assert.deepEqual(fs.readFileSync(lockFile), lockBytes);
    const freshSelection = JSON.parse(cli('resolve', '--root', fresh, '--store', freshStore, '--host', 'codex', '--json', '--contents'));
    assert.equal(freshSelection.lockState, 'valid');
    assert.equal(freshSelection.loaded[0].package.sha256, revisions[1].digest);
    assert.equal(freshSelection.loaded[0].package.version, '2.0.0');
    assert.equal(freshSelection.loaded[0].content, revisions[1].members['entry.md'].toString('utf8'));
    assert.deepEqual(snapshot(path.join(freshStore, 'objects/sha256', revisions[1].digest, 'tree')), revisions[1].original);
    const freshStamp = JSON.parse(cli('stamp', '--root', fresh, '--store', freshStore, '--host', 'codex', '--json')).digest;
    assert.equal(freshStamp, revisions[1].stamp, 'fresh exact bytes and selection reproduce the stamp');
    for (const revision of revisions) assert.deepEqual(snapshot(revision.directory), revision.original, 'imports preserve sources');
    fs.rmSync(root, { recursive: true }); fs.rmSync(sources, { recursive: true });
    assert.equal(fs.existsSync(configFile), false); assert.equal(fs.existsSync(sources), false);

    const { reconstructStamp } = await import(pathToFileURL(path.join(installed, 'src/stamps.js')).href);
    const { verifyMaterialization } = await import(pathToFileURL(path.join(installed, 'src/materialize.js')).href);
    const storeBefore = snapshot(store), freshBefore = snapshot(fresh), freshStoreBefore = snapshot(freshStore);
    for (const [index, revision] of revisions.entries()) {
      const rebuilt = reconstructStamp({ digest: revision.stamp, storeRoot: store });
      assert.deepEqual(rebuilt.composition.map(e => e.bytes), [revision.members['entry.md'], role]);
      assert.deepEqual(rebuilt.packages.map(p => [p.name, p.version, p.sha256]), [[name, revision.version, revision.digest]]);
      assert.deepEqual(rebuilt.packages[0].files.map(file => [file.path, file.bytes]), Object.entries(revision.members));
      const destination = path.join(outputs, `revision-${index + 1}`);
      const receipt = JSON.parse(cli('materialize', revision.stamp, '--root', fresh, '--store', store, '--adapter', 'filesystem-v1',
        '--output-root', outputs, '--destination', destination, '--json'));
      assert.equal(receipt.status, 'committed'); assert.equal(receipt.stampDigest, revision.stamp);
      assert.deepEqual(verifyMaterialization({ destination, expectedStampDigest: revision.stamp, storeRoot: store }), { verified: true, findings: [] });
      assert.deepEqual(fs.readFileSync(path.join(destination, 'content/instructions/0000.md')), revision.members['entry.md']);
      assert.deepEqual(fs.readFileSync(path.join(destination, 'content/instructions/0001.md')), role);
      assert.deepEqual(snapshot(path.join(destination, 'content/packages/sha256', revision.digest)), revision.original);
    }
    const freshDestination = path.join(outputs, 'fresh');
    cli('materialize', freshStamp, '--root', fresh, '--store', freshStore, '--adapter', 'filesystem-v1',
      '--output-root', outputs, '--destination', freshDestination, '--json');
    assert.deepEqual(verifyMaterialization({ destination: freshDestination, expectedStampDigest: freshStamp, storeRoot: freshStore }), { verified: true, findings: [] });
    assert.deepEqual(fs.readFileSync(path.join(freshDestination, 'content/instructions/0000.md')), revisions[1].members['entry.md']);
    assert.deepEqual(snapshot(path.join(freshDestination, 'content/packages/sha256', revisions[1].digest)), revisions[1].original);
    assert.deepEqual(snapshot(store), storeBefore); assert.deepEqual(snapshot(freshStore), freshStoreBefore);
    assert.deepEqual(snapshot(fresh), freshBefore); assert.deepEqual(fs.readFileSync(lockFile), lockBytes);
    console.log('Packed package workflow passed: two pins, retained stamps/diff/exports, and fresh offline frozen installation.');
  }
  console.log(`Verified ${artifact.name}@${artifact.version}: ${files.size} package files, ${artifact.size} bytes compressed.`);
} finally {
  // Only remove the exact temporary directory created by this script.
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('agent-profiles-package-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
