import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { parseDocument } from 'yaml';
import { inspectRepository, formatInventory } from '../src/inspect.js';
import { discoverSkills } from '../src/skills.js';
import { install, doctor } from '../src/install.js';
import { planRoleChange, applyRoleChange } from '../src/configure.js';
import { resolveInstructions } from '../src/resolve.js';
import { planPresetExport, applyPresetExport } from '../src/presets.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const cliFile = path.join(project, 'bin/agent-profiles.js');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-inspect-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  return { root, write };
}
function snapshot(root) {
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = path.join(entry.parentPath, entry.name);
    return [path.relative(root, file), fs.readFileSync(file).toString('base64')];
  }).sort(([a], [b]) => a.localeCompare(b));
}
function cli(root, ...args) {
  return spawnSync(process.execPath, [cliFile, 'inspect', '--root', root, ...args], { encoding: 'utf8' });
}

test('inspect emits deterministic JSON and text before init in an empty non-Git directory without writes', t => {
  const { root } = fixture(t);
  const first = cli(root, '--json');
  assert.equal(first.status, 0, first.stderr);
  const inventory = JSON.parse(first.stdout);
  assert.equal(inventory.schemaVersion, 1);
  assert.equal(inventory.repository.root, root);
  assert.equal(inventory.repository.installation.status, 'not-installed');
  assert.equal(inventory.repository.configuration.status, 'missing');
  assert.deepEqual(inventory.skills.skills, []);
  assert.equal(cli(root, '--json').stdout, first.stdout);
  const text = cli(root);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Read-only inventory/);
  assert.match(text.stdout, /not-installed/);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('installed inventory exposes configuration references and relevant file metadata, never instruction bodies or arbitrary package data', t => {
  const { root, write } = fixture(t);
  write('AGENTS.md', 'SECRET-INSTRUCTION-BODY');
  write('package.json', JSON.stringify({ name: 'fixture', engines: { node: '>=22' }, packageManager: 'npm@10', scripts: { test: 'node --test', deploy: 'SECRET-COMMAND' }, privateData: 'SECRET-PACKAGE' }));
  write('.github/workflows/check.yml', 'SECRET-WORKFLOW-BODY');
  write('docs/random.md', 'Not authoritative');
  install({ root, agents: ['hermes'] });
  const result = inspectRepository({ root });
  assert.equal(result.repository.installation.status, 'installed');
  assert.equal(result.repository.configuration.status, 'valid');
  assert.equal(result.repository.configuration.defaultProfile, 'constrained');
  assert.ok(result.repository.configuration.roles.some(role => role.id === 'reviewer' && role.required.includes('code-review')));
  assert.ok(result.repository.configuration.models.some(model => model.id === 'example-model' && model.profile === 'autonomous'));
  assert.ok(result.repository.configuration.profiles.some(profile => profile.id === 'constrained' && profile.path.endsWith('profiles/constrained.md')));
  assert.ok(result.repository.instructions.some(file => file.path === 'AGENTS.md' && file.availability === 'available' && file.bytes === 23));
  assert.ok(result.repository.workflows.some(file => file.path === '.github/workflows/check.yml'));
  assert.ok(!result.repository.workflows.some(file => file.path === 'docs/random.md'));
  assert.deepEqual(result.repository.package.scriptNames, ['deploy', 'test']);
  assert.equal(result.repository.package.node, '>=22');
  assert.ok(!JSON.stringify(result).includes('SECRET-'));
  assert.equal(JSON.parse(cli(root, '--json').stdout).repository.configuration.status, 'valid');
});

test('machine facts and safe fixed PATH tool checks remain separate from configured host and runtime qualification', t => {
  const { root, write } = fixture(t);
  const marker = path.join(root, 'EXECUTED');
  const binary = write('bin/claude.cmd', `@echo SECRET-OUTPUT > "${marker}"`);
  write('bin/npm.EXE', 'Not a real binary');
  write('bin/not-allowlisted.cmd', 'SECRET-TOOL');
  install({ root, agents: ['hermes'] });
  const system = { ...os, cpus: () => [], totalmem: () => 0, arch: () => 'ia32' };
  const result = inspectRepository({ root, environmentOptions: { platform: 'win32', env: { Path: path.join(root, 'bin'), PATHEXT: '.EXE;.CMD', SECRET_TOKEN: 'SECRET-ENV' }, system } });
  assert.equal(result.environment.node.compiledArchitecture, 'ia32');
  assert.equal(result.environment.shell.status, 'unknown');
  assert.equal(result.environment.cpu.status, 'unknown');
  assert.equal(result.environment.memory.status, 'unknown');
  assert.equal(result.environment.gpu.status, 'unknown');
  assert.equal(result.environment.localModels.status, 'unknown');
  const claude = result.hosts.find(host => host.id === 'claude');
  assert.equal(claude.configured, false);
  assert.equal(claude.executable.path, binary);
  assert.equal(claude.executable.availability, 'found');
  assert.equal(claude.currentInvocation, 'unverified');
  const hermes = result.hosts.find(host => host.id === 'hermes');
  assert.equal(hermes.configured, true);
  assert.equal(hermes.executable.availability, 'not-found');
  assert.equal(hermes.nativeInventory, 'unsupported-unobserved');
  assert.equal(hermes.currentInvocation, 'unverified');
  assert.ok(claude.historicalAdapterObservations.verified);
  assert.ok(!result.hosts.some(host => host.id === 't3'));
  assert.ok(!JSON.stringify(result).includes('SECRET-'));
  assert.equal(fs.existsSync(marker), false);
  assert.ok(!result.environment.tools.some(tool => tool.id === 'not-allowlisted'));
});

test('incomplete installation and failed optional metadata are reported rather than absent success', t => {
  const { root, write } = fixture(t);
  write('.agent-profiles/roles/orphan.md', 'PRIVATE');
  write('package.json', '{"secret":"DO-NOT-ECHO"');
  const partial = inspectRepository({ root });
  assert.equal(partial.repository.installation.status, 'incomplete');
  assert.equal(partial.repository.configuration.status, 'missing');
  assert.equal(partial.repository.package.status, 'invalid');
  assert.ok(!JSON.stringify(partial).includes('DO-NOT-ECHO'));
  for (const text of ['version: [', 'version: 1\nmodels: {}', ' '.repeat(65537)]) {
    write('.agent-profiles/agents.yaml', text);
    const result = inspectRepository({ root });
    assert.equal(result.repository.configuration.status, 'invalid');
    assert.ok(result.repository.configuration.problem);
    assert.equal(result.skills.status, 'partial');
  }
  write('.agent-profiles/agents.yaml', 'SECRET-YAML: [');
  assert.ok(!JSON.stringify(inspectRepository({ root })).includes('SECRET-YAML'));
  write('package.json', ' '.repeat(65537));
  assert.match(inspectRepository({ root }).repository.package.problem, /64 KiB/);
  fs.rmSync(path.join(root, 'package.json'));
  fs.mkdirSync(path.join(root, 'package.json'));
  assert.equal(inspectRepository({ root }).repository.package.availability, 'unavailable');
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  for (let index = 0; index < 130; index++) write(`.github/workflows/${index}.yml`, 'PRIVATE');
  const bounded = inspectRepository({ root });
  assert.equal(bounded.repository.workflows.filter(file => file.path.startsWith('.github')).length, 128);
  assert.match(bounded.warnings.join(' '), /128/);
});

test('pre-init project and opt-in custom-home native catalogs reuse discovery with explicit source and verification metadata', t => {
  const { root, write } = fixture(t);
  const home = write('home/keep', 'SECRET-HOME');
  const homeRoot = path.dirname(home);
  write('.claude/skills/project-audit/SKILL.md', '---\nname: Project audit\ndescription: Review project changes.\n---\nSECRET-NATIVE-BODY');
  write('home/.agents/skills/nested/user-audit/SKILL.md', '---\nname: user-audit\ndescription: Review user changes.\n---\nSECRET-NATIVE-BODY');
  write('home/custom-claude/skills/personal/SKILL.md', '---\ndescription: Personal procedure.\n---\nSECRET-NATIVE-BODY');
  write('home/custom-claude/settings.json', '{"secret":"SECRET-SETTINGS"}');
  const sourcesFile = write('home/sources.json', JSON.stringify({ version: 1, roots: [{ host: 'claude', scope: 'plugin', namespace: 'team', path: path.join(root, 'missing-plugin') }] }));
  const sourceOptions = { home: homeRoot, env: { CLAUDE_CONFIG_DIR: path.join(homeRoot, 'custom-claude') }, sourcesFile };
  const local = inspectRepository({ root, sourceOptions });
  assert.deepEqual(local.skills.skills.map(skill => skill.id), ['project-audit']);
  const projectSkill = local.skills.skills[0];
  assert.equal(projectSkill.host, 'claude');
  assert.equal(projectSkill.scope, 'project');
  assert.equal(projectSkill.source, 'claude');
  assert.equal(projectSkill.availability, 'metadata-found');
  assert.equal(projectSkill.verification, 'metadata-only');
  assert.equal(projectSkill.runtime, 'unverified');
  const external = inspectRepository({ root, external: true, sourceOptions });
  assert.ok(external.skills.skills.some(skill => skill.host === 'codex' && skill.hostId === 'user-audit' && skill.scope === 'user'));
  assert.ok(external.skills.skills.some(skill => skill.host === 'claude' && skill.hostId === 'personal' && skill.scope === 'user'));
  assert.ok(external.skills.roots.some(source => source.scope === 'plugin' && source.availability === 'missing'));
  assert.ok(!JSON.stringify(external).includes('SECRET-'));
  const invalid = write('home/invalid.json', '{');
  const failed = cli(root, '--json', '--sources', invalid);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /skill sources/);
  const env = { ...process.env, USERPROFILE: homeRoot, HOME: homeRoot, CLAUDE_CONFIG_DIR: path.join(homeRoot, 'custom-claude') };
  const implied = spawnSync(process.execPath, [cliFile, 'inspect', '--root', root, '--json', '--sources', sourcesFile], { encoding: 'utf8', env });
  assert.equal(implied.status, 0, implied.stderr);
  assert.ok(JSON.parse(implied.stdout).skills.skills.some(skill => skill.hostId === 'user-audit'));
});

test('inspection bounds repository metadata reads and inventories cursor rules without loading full instruction or skill bodies', t => {
  const { root, write } = fixture(t);
  install({ root, agents: ['hermes'] });
  write('.cursor/rules/workflow.mdc', 'PRIVATE-RULE-BODY');
  write('.cursor/rules/nested/hidden.mdc', 'PRIVATE-NESTED-BODY');
  const original = fs.readFileSync;
  const forbidden = [];
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    const name = String(file);
    if (name.startsWith(root)) forbidden.push(name);
    return original.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = inspectRepository({ root });
  assert.deepEqual(forbidden, []);
  assert.ok(result.repository.instructions.some(file => file.path === '.cursor/rules/workflow.mdc'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
  assert.ok(!result.repository.instructions.some(file => file.path.includes('hidden.mdc')));
  assert.equal(result.repository.installation.bootstrap.path, '.agent-profiles/BOOTSTRAP.md');
});

test('malformed selected package fields are not accepted as valid metadata', t => {
  const { root, write } = fixture(t);
  for (const value of [{ name: 2 }, { engines: [] }, { engines: { node: false } }, { scripts: [] }, { scripts: { test: 5 } }, { packageManager: {} }]) {
    write('package.json', JSON.stringify(value));
    const result = inspectRepository({ root, environmentOptions: { env: {} } });
    assert.equal(result.repository.package.status, 'invalid', JSON.stringify(value));
    assert.ok(result.repository.package.problem);
  }
});

test('existing approved APIs preserve instructions, native references, fallback and preset portability after read-only inspection', t => {
  const { root, write } = fixture(t);
  const instructions = 'Independent review and human approval are mandatory. No orchestration is implied.\n';
  write('AGENTS.md', instructions);
  write('.claude/skills/native-review/SKILL.md', '---\ndescription: Independent review procedure.\n---\nNATIVE-BODY-KEEP-NATIVE');
  const before = snapshot(root);
  const preinit = JSON.parse(cli(root, '--json').stdout);
  assert.equal(preinit.repository.installation.status, 'not-installed');
  assert.deepEqual(snapshot(root), before);
  // This explicit test step represents user approval; inventory never calls the installer.
  install({ root, agents: ['claude'] });
  const inventory = inspectRepository({ root, environmentOptions: { env: { SHELL: path.join(root, 'LOCAL-SHELL-ONLY') }, system: { ...os, cpus: () => [{ model: 'LOCAL-CPU-ONLY' }] } } });
  const native = inventory.skills.skills.find(skill => skill.id === 'native-review');
  const installed = snapshot(root);
  const plan = planRoleChange({ root, action: 'create', id: 'independent-reviewer', description: 'Review independently; do not implement.', required: [native], available: ['testing'] });
  assert.deepEqual(snapshot(root), installed);
  assert.ok(plan.changes.some(change => change.file === '.agent-profiles/agents.yaml'));
  const applied = applyRoleChange(plan); // Only after reviewing this separate plan.
  assert.deepEqual(applied.resolution.required.map(skill => skill.hostId), ['native-review']);
  assert.deepEqual(applyRoleChange(planRoleChange({ root, action: 'edit', id: 'independent-reviewer' })).modified, []);
  assert.deepEqual(install({ root, agents: ['claude'] }).modified, []);
  assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), instructions);
  const report = doctor(root);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.capabilities, []);
  assert.ok(report.bootstrap.length, 'Source-only fixture truthfully reports missing local package; packed tests verify runnable bootstrap');
  const compatible = resolveInstructions({ root, host: 'claude', role: 'independent-reviewer', model: 'unknown-model' });
  const incompatible = resolveInstructions({ root, host: 'hermes', role: 'independent-reviewer', model: 'unknown-model' });
  assert.equal(compatible.profile, 'constrained');
  assert.equal(compatible.required[0].delivery, 'invoke');
  assert.equal(compatible.required[0].bytes, null);
  assert.equal(compatible.unsatisfied.length, 0);
  assert.equal(incompatible.unsatisfied.length, 1);
  const proof = spawnSync(process.execPath, [cliFile, 'proof', '--root', root, '--host', 'claude', '--role', 'independent-reviewer', '--model', 'unknown-model', '--json'], { encoding: 'utf8' });
  assert.equal(proof.status, 0, proof.stderr);
  assert.deepEqual(JSON.parse(proof.stdout).diagnostics, compatible.diagnostics);
  assert.ok(!JSON.stringify(compatible).includes('NATIVE-BODY-KEEP-NATIVE'));
  const destination = path.join(root, 'exported');
  const beforeExport = snapshot(root);
  const exportPlan = planPresetExport({ root, destination, roles: ['independent-reviewer'], profiles: [], includeSkills: ['testing'], metadata: { name: 'review', display_name: 'Review', description: 'Independent review', author: 'Test', version: '1', license: 'Apache-2.0' } });
  assert.deepEqual(snapshot(root), beforeExport);
  applyPresetExport(exportPlan, true);
  const exported = snapshot(destination).map(([, bytes]) => Buffer.from(bytes, 'base64').toString('utf8')).join('\n');
  for (const excluded of ['LOCAL-CPU-ONLY', 'LOCAL-SHELL-ONLY', 'NATIVE-BODY-KEEP-NATIVE', root]) assert.ok(!exported.includes(excluded));
  assert.match(exported, /native-review/);
});

test('repository and external escapes remain unobserved while errors distinguish unsafe links from missing files', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const external = fixture(t);
  external.write('CLAUDE.md', 'PRIVATE-ESCAPE');
  external.write('agents.yaml', 'PRIVATE-ESCAPE');
  external.write('escape/SKILL.md', '---\nname: escape\ndescription: PRIVATE-ESCAPE\n---');

  fs.symlinkSync(external.root, path.join(root, '.claude/skills'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(external.root, path.join(root, '.agent-profiles'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(external.root, path.join(root, '.github'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = inspectRepository({ root, environmentOptions: { env: {} } });
  assert.equal(result.repository.configuration.status, 'invalid');
  assert.equal(result.repository.installation.status, 'incomplete');
  assert.equal(result.skills.status, 'partial');
  assert.ok(result.skills.warnings.length);
  assert.ok(result.warnings.length);
  assert.ok(!JSON.stringify(result).includes('PRIVATE-ESCAPE'));
  assert.deepEqual(result.skills.skills, []);
});

test('POSIX PATH permissions, omitted and relative entries, shell evidence and unavailable CPU are handled without execution', t => {
  const { root, write } = fixture(t);
  const file = write('tools/git', 'NEVER-EXECUTE');
  fs.chmodSync(file, 0o755);
  const nonexecutable = write('tools/ollama', 'NEVER-EXECUTE');
  fs.chmodSync(nonexecutable, 0o644);
  // A virtual POSIX directory avoids Windows drive letters in colon-delimited PATH.
  // Translate only this fixture's stat calls; cwd and temporary files may be on different drives.
  const directory = process.platform === 'win32' ? '/agent-profiles-posix-tools' : path.dirname(file);
  if (process.platform === 'win32') {
    const original = fs.statSync;
    t.mock.method(fs, 'statSync', function(target, ...args) {
      if (path.dirname(String(target)).replaceAll('\\', '/') !== directory) return original.call(this, target, ...args);
      const name = path.basename(String(target));
      const stat = original.call(this, path.join(path.dirname(file), name), ...args);
      stat.mode = (stat.mode & ~0o111) | (name === 'git' ? 0o111 : 0);
      return stat;
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  }
  const result = inspectRepository({ root, environmentOptions: { platform: 'linux', env: { PATH: `:relative:${directory}:${directory}`, SHELL: '/bin/zsh', RANDOM_SECRET: 'SECRET-ENV' }, system: { ...os, cpus: () => { throw new Error(); } } } });
  assert.equal(result.environment.tools.find(tool => tool.id === 'git').availability, 'found');
  // POSIX runners use real execute permissions; Windows emulates them only for these fixture files.
  assert.equal(result.environment.tools.find(tool => tool.id === 'ollama').availability, 'not-found');
  assert.equal(result.environment.shell.evidence, 'SHELL');
  assert.equal(result.environment.shell.currentShell, 'unverified');
  assert.equal(result.environment.cpu.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('SECRET-ENV'));
  const missing = inspectRepository({ root, environmentOptions: { env: {} } });
  assert.ok(missing.environment.tools.every(tool => tool.availability === 'not-found'));
});

test('opaque configured native references remain unobserved rather than claiming metadata verification', t => {
  const { root, write } = fixture(t);
  install({ root, agents: ['hermes'] });
  const file = path.join(root, '.agent-profiles/agents.yaml');
  const document = parseDocument(fs.readFileSync(file, 'utf8'));
  document.set('skills', { personal: { host: 'claude', scope: 'user', id: 'personal' } });
  document.setIn(['roles', 'reviewer', 'skills', 'available'], ['personal']);
  write('.agent-profiles/agents.yaml', document.toString());
  const result = inspectRepository({ root, environmentOptions: { env: {} } });
  assert.equal(result.repository.configuration.status, 'valid');
  const skill = result.skills.skills.find(skill => skill.id === 'personal');
  assert.equal(skill.path, null);
  assert.equal(skill.availability, 'host-provided-unverified');
  assert.equal(skill.verification, 'unobserved');
  assert.equal(skill.runtime, 'unverified');
});

test('optional inaccessible sources and malformed or oversized host surfaces are reported as unverified, not absent', t => {
  const { root, write } = fixture(t);
  write('CLAUDE.md', '<!-- agent-profiles:start -->');
  write('AGENTS.md', ' '.repeat(65537));
  const home = path.join(root, 'custom-home');
  const inaccessible = path.join(home, '.claude/skills');
  write('custom-home/.claude/skills/audit/SKILL.md', '---\ndescription: Review.\n---\nPRIVATE-BODY');
  const original = fs.statSync;
  t.mock.method(fs, 'statSync', function(file, ...args) {
    if (path.resolve(String(file)) === inaccessible) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = inspectRepository({ root, external: true, sourceOptions: { home, env: {} }, environmentOptions: { env: {} } });
  assert.equal(result.hosts.find(host => host.id === 'claude').configured, null);
  assert.equal(result.hosts.find(host => host.id === 'codex').configured, null);
  assert.ok(result.hosts.filter(host => ['claude', 'codex'].includes(host.id)).every(host => host.problems.length && host.currentInvocation === 'unverified'));
  assert.equal(result.skills.status, 'partial');
  assert.ok(result.skills.warnings.some(warning => /EACCES|access|permissions/.test(warning)));
  assert.equal(result.skills.roots.find(source => source.path === inaccessible).availability, 'unavailable');
});

for (const source of ['repository', 'project', 'configured', 'claude-user', 'codex-user', 'codex-conflict']) {
  test(`inspection diagnostics exclude private parser excerpts for ${source} skills`, t => {
    const { root, write } = fixture(t);
    const home = path.join(root, 'home');
    const external = source.includes('user') || source === 'codex-conflict';
    const files = {
      repository: '.agent-profiles/skills/broken/SKILL.md',
      project: '.claude/skills/broken/SKILL.md',
      configured: '.agent-profiles/skills/code-review/SKILL.md',
      'claude-user': 'home/.claude/skills/broken/SKILL.md',
      'codex-user': 'home/.agents/skills/broken/SKILL.md',
      'codex-conflict': '.agents/skills/broken/SKILL.md',
    };
    if (source === 'configured') install({ root, agents: ['hermes'] });
    write('.claude/skills/good/SKILL.md', '---\nname: Good review\ndescription: Approved description\nprivate_token: VALID-PRIVATE-VALUE\n---\nPRIVATE-BODY');
    for (const invalid of ['private_token: [SECRET-NOT-AN-ALLOWED-METADATA-FIELD', 'private_token: {other: SECRET-OTHER-PRIVATE-VALUE', 'private_token: SECRET-DUPLICATE-VALUE\nprivate_token: SECRET-SECOND-VALUE']) {
      write(files[source], `---\nname: broken\ndescription: Review changes\n${invalid}\n---\nPRIVATE-BODY`);
      const before = snapshot(root);
      const result = inspectRepository({ root, external, sourceOptions: { home, env: {} }, environmentOptions: { env: {} } });
      assert.equal(result.skills.status, 'partial');
      assert.ok(result.skills.warnings.length);
      assert.ok(result.skills.warnings.some(warning => warning.includes(files[source].replaceAll('/', path.sep)) || warning.includes(files[source])));
      assert.match(result.skills.warnings.join(' '), /metadata|frontmatter|syntax/i);
      assert.match(result.skills.warnings.join(' '), /repair|check|review/i);
      const good = result.skills.skills.find(skill => skill.id === 'good');
      assert.equal(good.name, 'Good review');
      assert.equal(good.description, 'Approved description');
      for (const output of [JSON.stringify(result), formatInventory(result)]) {
        assert.doesNotMatch(output, /private_token|SECRET-|PRIVATE-BODY|VALID-PRIVATE-VALUE|at line|column|\^/);
      }
      assert.deepEqual(snapshot(root), before);
    }
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
    for (const args of [[], ['--json']]) {
      const output = external
        ? spawnSync(process.execPath, [cliFile, 'inspect', '--root', root, '--external', ...args], { encoding: 'utf8', env })
        : cli(root, ...args);
      assert.equal(output.status, 0, output.stderr);
      assert.doesNotMatch(output.stdout + output.stderr, /private_token|SECRET-|PRIVATE-BODY|at line|column|\^/);
    }
  });
}

test('configured discovery diagnostic opt-in preserves default API warnings and safe metadata', t => {
  const { root, write } = fixture(t);
  const file = 'procedures/custom/SKILL.md';
  write(file, '---\nname: custom\ndescription: Review\nprivate_token: [SECRET-CONFIGURED-EXCERPT\n---\nPRIVATE-BODY');
  const configuration = new Map([['skills', new Map([['custom', new Map([['file', file]])]])]]);
  const legacy = discoverSkills(root, configuration);
  assert.match(legacy.warnings.join(' '), /private_token/);
  const bounded = discoverSkills(root, configuration, { metadataOnly: true });
  assert.equal(bounded.warnings.length, legacy.warnings.length);
  assert.deepEqual(bounded.skills, legacy.skills);
  assert.match(bounded.warnings[0], /configured: custom/);
  assert.ok(bounded.warnings[0].includes(file));
  assert.doesNotMatch(JSON.stringify(bounded), /private_token|SECRET-|PRIVATE-BODY|at line|column/);
});

test('inspection source-preferences parse failures remain actionable without JSON source excerpts', t => {
  const { root, write } = fixture(t);
  for (const content of ['{"private_token":"SECRET-ROOTS-VALUE",', '{"version":1,"roots":[{"host":"claude","path":"SECRET-ROOTS-VALUE"}]}']) {
    const file = write('sources.json', content);
    for (const args of [[], ['--json']]) {
      const result = cli(root, '--sources', file, ...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /skill sources/);
      assert.ok(result.stderr.includes(file));
      assert.match(result.stderr, /repair|review|check/);
      assert.doesNotMatch(result.stdout + result.stderr, /private_token|SECRET-ROOTS-VALUE|position|Unexpected/);
    }
  }
});

for (const file of ['orchestrator.toml', 'adr-orchestrator.toml', 't3.json']) {
  test(`inspection locates ${file} as metadata only without conferring workflow authority`, t => {
    const { root, write } = fixture(t);
    for (const body of ['SECRET-WORKFLOW-CONTENT { malformed', 'SECRET-HUGE-WORKFLOW'.repeat(4000)]) {
      write(file, body);
      write('docs/arbitrary-workflow.md', 'SECRET-ARBITRARY-AUTHORITY');
      const before = snapshot(root);
      const original = fs.openSync;
      t.mock.method(fs, 'openSync', function(target, ...args) {
        assert.notEqual(path.resolve(String(target)), path.join(root, file), 'Locator contents must never be opened');
        return original.call(this, target, ...args);
      });
      syncBuiltinESMExports();
      const result = inspectRepository({ root, environmentOptions: { env: {} } });
      t.mock.restoreAll(); syncBuiltinESMExports();
      const locator = result.repository.workflows.find(record => record.path === file);
      assert.deepEqual(locator, { path: file, source: 'recognized-workflow', host: null, scope: 'repository', availability: 'available', bytes: Buffer.byteLength(body) });
      assert.ok(!result.repository.workflows.some(record => record.path.includes('arbitrary')));
      assert.doesNotMatch(JSON.stringify(result) + formatInventory(result), /SECRET-/);
      assert.deepEqual(snapshot(root), before);
    }
    fs.rmSync(path.join(root, file));
    fs.mkdirSync(path.join(root, file));
    const unavailable = inspectRepository({ root, environmentOptions: { env: {} } }).repository.workflows.find(record => record.path === file);
    assert.equal(unavailable.availability, 'unavailable');
    assert.match(unavailable.problem, /regular file/);
    fs.rmSync(path.join(root, file), { recursive: true });
    assert.ok(!inspectRepository({ root }).repository.workflows.some(record => record.path === file));
  });
}

test('unreadable bounded metadata is distinguished from malformed syntax', t => {
  const { root, write } = fixture(t);
  install({ root, agents: ['hermes'] });
  write('package.json', '{}');
  write('CLAUDE.md', 'Preserve rules');
  const original = fs.openSync;
  t.mock.method(fs, 'openSync', function(file, ...args) {
    if (['package.json', 'CLAUDE.md', 'agents.yaml'].includes(path.basename(String(file)))) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = inspectRepository({ root, environmentOptions: { env: {} } });
  assert.equal(result.repository.package.availability, 'unavailable');
  assert.equal(result.repository.configuration.availability, 'unavailable');
  assert.match(result.repository.package.problem, /EACCES|read/i);
  assert.match(result.hosts.find(host => host.id === 'claude').problems.join(' '), /unreadable|EACCES/i);
});
