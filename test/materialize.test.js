import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify } from 'yaml';
import { createStamp, verifyStamp, reconstructStamp } from '../src/stamps.js';
import { importPackage, lookupPackage, encodeComponent, decodeComponent } from '../src/package-store.js';
import { canonicalJSON, hashRecord, hashTree, readPackage, validateMembers } from '../src/packages.js';
import { installDependencies } from '../src/package-lock.js';

// C18/C19, M01-M14. Runtime boundaries are operational inputs, never hashed data.
const target = new URL('../src/materialize.js', import.meta.url);
let sut;
try { sut = await import(target.href); }
catch (error) {
  if (!(error.code === 'ERR_MODULE_NOT_FOUND' && error.url === target.href && !fs.existsSync(fileURLToPath(target)))) throw error;
}
const behavior = (name, body) => test(name, { skip: sut ? false : 'src/materialize.js absent: business body unexecuted' }, body);
const WORKER = fileURLToPath(new URL('./fixtures/issue-20/materialize-worker.mjs', import.meta.url));
const CONFIG = '.agent-profiles/agents.yaml';
const PLAN_DOMAIN = 'agent-profiles/materialization-plan/v1';
const TREE_DOMAIN = 'agent-profiles/materialized-tree/v1';
const adapter = { id: 'filesystem-v1', contractVersion: 1 };
const capabilities = { bytePreservation: 'verified', filesystemIsolation: 'verified', nativeLayout: 'unsupported', nativeInvocation: 'unsupported', hostVisibilityIsolation: 'unverified', runtimeRendering: 'unverified' };
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const E = s => 'x-' + Buffer.from(s).toString('hex');
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const clone = value => structuredClone(value);
const binary = Buffer.from([0, 255, 192, 175, 13, 10, 239, 187, 191]);
const skill = id => Buffer.from(`\uFEFF---\r\nname: ${id}\r\ndescription: ${id} description\r\n---\r\nExact ${id}\r\n\r\n`);
const profileBytes = Buffer.from('\uFEFF# Profile\r\n\r\n');
const roleBytes = Buffer.from('# Role\r\n\r\n');
const sharedBytes = Buffer.from('\uFEFF# Shared\r\n\r\n');

// Independent framing/encoding oracle for finite fixture records; no production hash helpers.
function J(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return '"' + Array.from(value, c => c.charCodeAt(0) < 32
    ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : JSON.stringify(c).slice(1, -1)).join('') + '"';
  if (Array.isArray(value)) return '[' + value.map(J).join(',') + ']';
  return '{' + Object.keys(value).sort(cmp).map(k => `${J(k)}:${J(value[k])}`).join(',') + '}';
}
function U(n) { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; }
function record(value, domain = PLAN_DOMAIN) {
  const bytes = Buffer.from(J(value));
  return sha(Buffer.concat([Buffer.from(domain + '\0'), U(bytes.length), bytes]));
}
function tree(files, domain = TREE_DOMAIN) {
  const parts = [Buffer.from(domain + '\0'), U(files.length)];
  for (const f of [...files].sort((a, b) => cmp(a.path, b.path))) {
    const name = Buffer.from(f.path);
    parts.push(Buffer.from([70]), U(name.length), name, U(f.bytes.length), f.bytes);
  }
  return sha(Buffer.concat(parts));
}
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p8-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// Does not follow links. Labels alone normalize; file bytes remain raw.
function fingerprint(root) {
  if (!fs.existsSync(root)) return null;
  const rows = [];
  function visit(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort(cmp)) {
      const label = prefix + name, full = path.join(dir, name), stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) rows.push([label, 'link', fs.readlinkSync(full)]);
      else if (stat.isDirectory()) { rows.push([label, 'dir']); visit(full, label + '/'); }
      else rows.push([label, 'file', stat.nlink, sha(fs.readFileSync(full))]);
    }
  }
  visit(root); return rows;
}
function files(root) {
  return fingerprint(root).filter(r => r[1] === 'file').map(r => ({ path: r[0], bytes: fs.readFileSync(path.join(root, r[0])) }));
}
function env(t, values) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}
function packageFiles(name, version, type, native = false, label = 'explicit') {
  const manifest = { schema_version: 1, package: { name, version, type }, entrypoint: type === 'instruction' ? 'ENTRY.md' : 'SKILL.md',
    behavior: { delivery: native ? 'native' : 'instruction', hosts: native ? ['codex'] : [], effects: native ? ['commands', 'substitution', 'external-references', 'host-configuration'] : [] } };
  return [
    { path: 'package.yaml', bytes: Buffer.from(stringify(manifest)) },
    { path: manifest.entrypoint, bytes: type === 'instruction' ? Buffer.from(`\uFEFF${label} ${version}\r\n`) : Buffer.from(`---\nname: package-skill\ndescription: package description\n---\n${label} ${version}\r\n${native ? '!`never-run`\n$ARGUMENTS\n@inert\n' : ''}`) },
    { path: 'assets/data.bin', bytes: Buffer.from([0, 255, Number(version[0]), label.length]) },
    { path: '.hidden', bytes: Buffer.alloc(0) },
    { path: 'support/run.js', bytes: Buffer.from('throw new Error("archived bytes must never execute");\r\n') },
    ...(native ? [{ path: 'hooks/inert.json', bytes: Buffer.from('{"inert":true}\r\n') }] : []),
  ].sort((a, b) => cmp(a.path, b.path));
}

function fixture(t, { packaged = false, version = '1.0.0', requested = true } = {}) {
  const dir = scratch(t), root = path.join(dir, 'project'), storeRoot = path.join(dir, 'store'), outputRoot = path.join(dir, 'out');
  const home = path.join(dir, 'home'), empty = path.join(dir, 'empty'), misleading = path.join(dir, 'misleading');
  for (const p of [root, storeRoot, outputRoot, home, empty, misleading]) fs.mkdirSync(p);
  env(t, { HOME: home, USERPROFILE: home, AGENT_PROFILES_STORE: misleading });
  const config = { version: 2, default_profile: 'con', default_role: 'nul', models: {}, families: {},
    profiles: { con: { file: 'mapped/profile.md', resources: ['assets/profile.bin'] } },
    roles: { nul: { file: 'roles/nul-safe.md', resources: ['assets/role.bin'], skills: { required: ['req'], available: ['con', 'x-636f6e'] } } },
    skills: { req: { file: 'instructions/req.md', resources: ['assets/req.bin'] },
      con: { file: 'instructions/con-safe.md', resources: ['assets/requested.bin'] },
      'x-636f6e': { file: 'instructions/idle.md', resources: ['assets/idle.bin'] } } };
  const local = {
    '.agent-profiles/mapped/profile.md': profileBytes, '.agent-profiles/roles/nul-safe.md': roleBytes,
    'instructions/req.md': skill('req'), 'instructions/con-safe.md': skill('con'), 'instructions/idle.md': skill('idle'),
    'assets/profile.bin': binary, 'assets/role.bin': Buffer.from([128, 0, 13, 10]), 'assets/req.bin': Buffer.alloc(0),
    'assets/requested.bin': Buffer.from('requested\r\n'), 'assets/idle.bin': Buffer.from([255, 0]), 'AGENTS.md': sharedBytes,
  };
  const packages = [];
  if (packaged) {
    // One instruction revision has two owners; one skill revision has required+available owners.
    config.profiles.con = { package: '@con/review', version };
    config.roles.nul = { package: '@con/review', version, skills: { required: ['req', 'pkg'], available: ['con', 'x-636f6e', 'idle-pkg', 'native'] } };
    config.skills.pkg = { package: '@team/nul', version };
    config.skills['idle-pkg'] = { package: '@team/nul', version };
    config.skills.native = { package: '@team/native', version };
    delete local['.agent-profiles/mapped/profile.md']; delete local['.agent-profiles/roles/nul-safe.md'];
    for (const [name, type, native, owners] of [
      ['@con/review', 'instruction', false, ['profiles.con', 'roles.nul']],
      ['@team/nul', 'skill', false, ['skills.pkg', 'skills.idle-pkg']],
      ['@team/native', 'skill', true, ['skills.native']],
    ]) {
      const members = packageFiles(name, version, type, native), digest = tree(members, 'agent-profiles/package-tree/v1');
      for (const [selected, label] of [[storeRoot, 'explicit'], [misleading, 'ambient']]) {
        const source = path.join(dir, label + '-sources', E(name));
        const sourceFiles = label === 'explicit' ? members : packageFiles(name, version, type, native, label);
        for (const member of sourceFiles) put(path.join(source, member.path), member.bytes);
        assert.deepEqual(readPackage({ root: source }).files, sourceFiles);
        const imported = importPackage({ sourceDirectory: source, storeRoot: selected });
        assert.equal(imported.sha256, tree(sourceFiles, 'agent-profiles/package-tree/v1'));
      }
      packages.push({ name, digest, members, owners });
    }
  }
  for (const [p, bytes] of Object.entries(local)) put(path.join(root, p), bytes);
  put(path.join(root, CONFIG), stringify(config));
  if (packaged) installDependencies({ root, storeRoot });
  const stamp = createStamp({ root, storeRoot, host: 'codex', skills: requested ? ['con'] : [], sharedFiles: ['AGENTS.md'] });
  assert.equal(stamp.digest, record(stamp.snapshot, 'agent-profiles/stamp/v1'));
  const report = verifyStamp({ digest: stamp.digest, storeRoot });
  assert.equal(report.managedReproducible, true, report.findings.join('\n'));
  const reconstructed = reconstructStamp({ digest: stamp.digest, storeRoot });
  assert.equal(reconstructed.composition.length, (packaged ? 5 : 4) - (requested ? 0 : 1));
  const entryBytes = p => p.members.find(m => /^(ENTRY|SKILL)\.md$/.test(m.path)).bytes;
  assert.deepEqual(reconstructed.composition.map(e => e.bytes), [
    ...packaged ? [entryBytes(packages[0]), entryBytes(packages[0])] : [profileBytes, roleBytes],
    skill('req'), ...packaged ? [entryBytes(packages[1])] : [], ...requested ? [skill('con')] : [],
  ]);
  const resourceOwners = [...packaged ? [] : [['profiles.con', 'assets/profile.bin'], ['roles.nul', 'assets/role.bin']],
    ['skills.req', 'assets/req.bin'], ['skills.con', 'assets/requested.bin'], ['skills.x-636f6e', 'assets/idle.bin']];
  assert.deepEqual(reconstructed.resources.map(r => [r.binding, r.backing.path, r.bytes]), resourceOwners.map(([binding, p]) => [binding, p, local[p]]));
  const expectedFiles = [], mappings = [], content = [];
  // Finite table of authored expected outputs, independent of reconstruction traversal.
  const row = (outputPath, backing, binding, bytes) => {
    expectedFiles.push({ path: outputPath, backing });
    content.push({ path: outputPath.slice('content/'.length), bytes });
    mappings.push({ binding, sourceKind: backing.type, sourceDigest: backing.sha256,
      packageDigest: backing.type === 'package' ? backing.sha256 : null, sourcePath: backing.type === 'snapshot' ? 'snapshot.json' : backing.path, outputPath, hostName: null });
  };
  const blob = (output, source, binding) => row('content/' + output, { type: 'blob', sha256: sha(local[source]), bytes: local[source].length, path: source }, binding, local[source]);
  const pkg = (output, p, binding) => {
    const member = p.members.find(m => /^(ENTRY|SKILL)\.md$/.test(m.path));
    row('content/' + output, { type: 'package', sha256: p.digest, path: member.path }, binding, member.bytes);
  };
  row('content/snapshot.json', { type: 'snapshot', sha256: stamp.digest }, null, Buffer.from(J(stamp.snapshot)));
  if (packaged) {
    pkg('instructions/0000.md', packages[0], 'profiles.con'); pkg('instructions/0001.md', packages[0], 'roles.nul');
  } else {
    blob('instructions/0000.md', '.agent-profiles/mapped/profile.md', 'profiles.con');
    blob('instructions/0001.md', '.agent-profiles/roles/nul-safe.md', 'roles.nul');
    blob(`resources/${E('profiles.con')}/assets/profile.bin`, 'assets/profile.bin', 'profiles.con');
    blob(`resources/${E('roles.nul')}/assets/role.bin`, 'assets/role.bin', 'roles.nul');
  }
  blob('instructions/0002.md', 'instructions/req.md', 'skills.req');
  if (packaged) pkg('instructions/0003.md', packages[1], 'skills.pkg');
  blob(requested ? `instructions/${packaged ? '0004' : '0003'}.md` : `available/${E('con')}/entry.md`, 'instructions/con-safe.md', 'skills.con');
  blob(`available/${E('x-636f6e')}/entry.md`, 'instructions/idle.md', 'skills.x-636f6e');
  for (const [id, source] of [['req', 'assets/req.bin'], ['con', 'assets/requested.bin'], ['x-636f6e', 'assets/idle.bin']]) blob(`resources/${E('skills.' + id)}/${source}`, source, 'skills.' + id);
  if (packaged) {
    pkg(`available/${E('idle-pkg')}/entry.md`, packages[1], 'skills.idle-pkg');
    for (const p of packages) for (const member of p.members) {
      const outputPath = `content/packages/sha256/${p.digest}/${member.path}`;
      row(outputPath, { type: 'package', sha256: p.digest, path: member.path }, p.owners[0], member.bytes);
      for (const binding of p.owners.slice(1)) mappings.push({ ...mappings.at(-1), binding });
    }
  }
  blob('shared/AGENTS.md', 'AGENTS.md', null);
  expectedFiles.sort((a, b) => cmp(a.path, b.path));
  const nullable = (a, b) => a === b ? 0 : a === null ? -1 : b === null ? 1 : cmp(a, b);
  mappings.sort((a, b) => cmp(a.outputPath, b.outputPath) || nullable(a.binding, b.binding) || cmp(a.sourcePath, b.sourcePath) || cmp(a.sourceKind, b.sourceKind) || cmp(a.sourceDigest, b.sourceDigest));
  content.sort((a, b) => cmp(a.path, b.path));
  const expectedPlan = { planVersion: 1, stampDigest: stamp.digest, adapter: clone(adapter), options: {}, files: expectedFiles, mappings, capabilities: clone(capabilities) };
  const expectedReceipt = { receiptVersion: 1, stampDigest: stamp.digest, planDigest: record(expectedPlan), adapter: clone(adapter), options: {}, outputDigest: tree(content), mappings: clone(mappings), capabilities: clone(capabilities), status: 'committed' };
  const f = { dir, root, storeRoot, outputRoot, empty, misleading, home, local, stamp, packages, reconstructed, expectedPlan, expectedReceipt, content };
  f.planInput = { stampDigest: stamp.digest, storeRoot, adapterId: adapter.id, adapterContractVersion: 1 };
  f.args = { plan: expectedPlan, storeRoot, destination: path.join(outputRoot, 'run'), outputRoot, deniedRoots: [root, path.join(dir, 'explicit-sources'), home] };
  f.verify = destination => sut.verifyMaterialization({ destination: destination ?? f.args.destination, expectedStampDigest: stamp.digest, storeRoot });
  return f;
}

async function plan(f) { const p = await sut.planMaterialization(f.planInput); assert.deepEqual(p, f.expectedPlan); return p; }
async function exported(f) {
  const p = await plan(f), r = await sut.materialize({ ...f.args, plan: p });
  assert.deepEqual(r, f.expectedReceipt); exactOutput(f); return r;
}
function exactOutput(f, destination = f.args.destination) {
  assert.deepEqual(files(path.join(destination, 'content')), f.content);
  assert.deepEqual(files(destination).map(m => m.path), [...f.content.map(m => 'content/' + m.path), 'receipt.json'].sort(cmp));
  assert.deepEqual(fs.readFileSync(path.join(destination, 'receipt.json')), Buffer.from(J(f.expectedReceipt)));
  for (const row of fingerprint(destination)) assert.notEqual(row[1], 'link');
  assert.equal(tree(files(path.join(destination, 'content'))), f.expectedReceipt.outputDigest);
}
async function refuses(run, pattern) { await assert.rejects(async () => run(), error => { assert.match(error.message, pattern); return true; }); }
async function finding(f, code, relevant = '') {
  const before = fingerprint(f.dir), result = await f.verify();
  assert.deepEqual(Object.keys(result).sort(), ['findings', 'verified']);
  assert.equal(result.verified, false);
  assert.ok(result.findings.some(s => s.startsWith(code) && s.includes(relevant)), JSON.stringify(result));
  assert.deepEqual(fingerprint(f.dir), before, 'verification must be read-only');
}
async function noDispatch(body) {
  const saved = []; let calls = 0;
  for (const [object, keys] of [[childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
    [net, ['connect', 'createConnection']], [http, ['request', 'get']], [https, ['request', 'get']], [globalThis, ['fetch']]]) {
    for (const key of keys) { saved.push([object, key, object[key]]); object[key] = () => { calls++; throw new Error('forbidden dispatch'); }; }
  }
  syncBuiltinESMExports();
  try { await body(); } finally { for (const [o, k, v] of saved) o[k] = v; syncBuiltinESMExports(); }
  assert.equal(calls, 0, 'archived code/native/network must remain inert');
}

function child(t, dir, request, noRequest = false, preload = []) {
  const c = spawn(process.execPath, [...preload, WORKER, ...noRequest ? [] : [JSON.stringify({ ownedRoot: dir, ...request })]], {
    env: { ...process.env, TMP: dir, TEMP: dir, TMPDIR: dir, HOME: path.join(dir, 'home'), USERPROFILE: path.join(dir, 'home'), AGENT_PROFILES_STORE: path.join(dir, 'empty') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  c.stdout.on('data', b => { stdout += b; }); c.stderr.on('data', b => { stderr += b; });
  const closed = new Promise((resolve, reject) => { c.once('error', reject); c.once('close', (code, signal) => {
    try { resolve({ code, signal, stdout, stderr, data: stdout.trim() ? JSON.parse(stdout) : null }); }
    catch (error) { reject(new Error(`invalid child response: ${stdout}; ${stderr}`, { cause: error })); }
  }); });
  closed.catch(() => {});
  t.after(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); });
  return { c, closed };
}
async function result(run) { const r = await run.closed; assert.equal(r.code, 0, JSON.stringify(r)); assert.equal(r.stderr, ''); assert.ok(r.data); return r.data; }
async function paused(t, f, phase, extra = {}, name = 'writer') {
  const marker = path.join(f.dir, name + '.marker'), release = path.join(f.dir, name + '.release');
  const run = child(t, f.dir, { args: f.args, storeRoot: f.storeRoot, ...extra, barrier: { phase, marker, release } });
  let ended; run.closed.then(r => { ended = r; });
  for (const start = Date.now(); !fs.existsSync(marker); await delay(10)) {
    if (ended) assert.fail(`child ended before ${phase}: ${JSON.stringify(ended)}`);
    assert.ok(Date.now() - start < 20000, `barrier ${phase} not reached`);
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), phase);
  return { ...run, release: async () => { fs.writeFileSync(release, 'release'); return result(run); }, kill: async () => {
    assert.ok(run.c.pid > 0 && run.c.pid !== process.pid); assert.equal(run.c.kill('SIGKILL'), true);
    const r = await run.closed;
    assert.ok(r.signal === 'SIGKILL' || process.platform === 'win32' && r.code !== 0, JSON.stringify(r));
    assert.equal(r.data, null, 'no success acknowledgment before actual termination'); return r;
  } };
}

test('C18 seam exports the four materialization operations', () => {
  assert.ok(sut, 'missing src/materialize.js: C18/C19 production interface absent');
  for (const name of ['planMaterialization', 'materialize', 'verifyMaterialization', 'recoverMaterialization']) assert.equal(typeof sut[name], 'function', name);
});

test('M01 independent canonical framing controls exercise existing primitives', () => {
  const value = { z: ['\u0000', 'é', 1], a: true };
  assert.equal(J(value), '{"a":true,"z":["\\u0000","é",1]}');
  assert.deepEqual(canonicalJSON(value), Buffer.from(J(value)));
  assert.equal(hashRecord(PLAN_DOMAIN, value), record(value));
  const members = [{ path: 'Z', bytes: Buffer.from([0, 255]) }, { path: 'a', bytes: Buffer.alloc(0) }];
  assert.equal(hashTree(members, TREE_DOMAIN), tree(members));
  assert.equal(tree([...members].reverse()), tree(members));
  assert.notEqual(tree(members), tree(members, 'agent-profiles/package-tree/v1'));
  assert.notEqual(record(value), record(value, 'agent-profiles/stamp/v1'));
  assert.notEqual(tree(members), tree([{ ...members[0], bytes: Buffer.from([0, 254]) }, members[1]]));
});

for (const packaged of [false, true]) test(`M01/M03 independent ${packaged ? 'package' : 'local'} complete fixture and golden controls`, t => {
  const f = fixture(t, { packaged });
  assert.ok(f.expectedPlan.files.length > 0 && f.expectedPlan.mappings.length > 0);
  assert.equal(f.expectedPlan.files.length, packaged ? 28 : 12);
  assert.equal(f.content.length, f.expectedPlan.files.length);
  assert.equal(new Set(f.expectedPlan.files.map(m => m.path)).size, f.content.length);
  assert.equal(new Set(f.expectedPlan.mappings.map(J)).size, f.expectedPlan.mappings.length);
  assert.equal(f.expectedPlan.mappings.length, packaged ? 38 : 12);
  for (const m of f.expectedPlan.mappings) assert.ok(f.expectedPlan.files.some(file => file.path === m.outputPath));
  assert.deepEqual(canonicalJSON(f.expectedPlan), Buffer.from(J(f.expectedPlan)));
  assert.deepEqual(canonicalJSON(f.expectedReceipt), Buffer.from(J(f.expectedReceipt)));
  assert.equal(hashRecord(PLAN_DOMAIN, f.expectedPlan), f.expectedReceipt.planDigest);
  assert.equal(hashTree(f.content, TREE_DOMAIN), f.expectedReceipt.outputDigest);
  assert.ok(f.content.some(m => m.path === 'snapshot.json'));
  assert.equal(f.content.some(m => m.path === 'receipt.json'), false);
  assert.notEqual(tree([...f.content, { path: 'receipt.json', bytes: Buffer.from(J(f.expectedReceipt)) }]), f.expectedReceipt.outputDigest);
  if (packaged) for (const p of f.packages) {
    assert.deepEqual(lookupPackage({ storeRoot: f.storeRoot, name: p.name, version: '1.0.0' }).files, p.members);
    for (const binding of p.owners) assert.deepEqual(f.expectedPlan.mappings.filter(m => m.outputPath.startsWith(`content/packages/sha256/${p.digest}/`) && m.binding === binding).map(m => m.sourcePath), p.members.map(m => m.path));
  }
});

for (const packaged of [false, true]) test(`M05/M06 independent ${packaged ? 'package' : 'local'} reconstruction survives deleted sources`, async t => {
  await noDispatch(async () => {
    const f = fixture(t, { packaged });
    const expected = f.reconstructed;
    fs.rmSync(f.root, { recursive: true }); fs.rmSync(path.join(f.dir, 'explicit-sources'), { recursive: true, force: true });
    assert.deepEqual(reconstructStamp({ digest: f.stamp.digest, storeRoot: f.storeRoot }), expected);
    assert.equal(verifyStamp({ digest: f.stamp.digest, storeRoot: f.storeRoot }).managedReproducible, true);
    for (const p of f.packages) assert.deepEqual(expected.packages.find(r => r.sha256 === p.digest).files, p.members);
  });
});

test('M04 independent encoded identities and portable descriptor controls', () => {
  for (const [s, encoded] of [['con', 'x-636f6e'], ['nul', 'x-6e756c'], ['skills.con', 'x-736b696c6c732e636f6e']]) {
    assert.equal(encodeComponent(s), encoded); assert.equal(decodeComponent(encoded), s);
  }
  assert.notEqual(E('con'), E('x-636f6e'));
  for (const bad of ['x-6E756C', 'x-0', 'x-zz', 'x-ff']) assert.throws(() => decodeComponent(bad));
  for (const members of [
    [{ path: 'con.txt', type: 'file', nlink: 1 }], [{ path: 'nul', type: 'file', nlink: 1 }],
    [{ path: 'a', type: 'file', nlink: 2 }], [{ path: 'a', type: 'symlink', nlink: 1 }],
    [{ path: 'A/x', type: 'file', nlink: 1 }, { path: 'a/y', type: 'file', nlink: 1 }],
    [{ path: 'a', type: 'file', nlink: 1 }, { path: 'a/b', type: 'file', nlink: 1 }],
  ]) assert.throws(() => validateMembers(members), /reserved|hard-linked|unsupported member|case collision|prefix collision/);
});

test('M07 independent preservation fingerprint detects protected raw-byte changes', t => {
  const root = scratch(t); put(path.join(root, 'nested/allowed'), 'a'); put(path.join(root, 'protected'), binary);
  const without = () => fingerprint(root).filter(r => r[0] !== 'nested/allowed');
  const before = without(); put(path.join(root, 'nested/allowed'), 'b'); assert.deepEqual(without(), before);
  put(path.join(root, 'protected'), Buffer.from([1])); assert.notDeepEqual(without(), before);
});

test('M11 child helper default discovery is a safe no-request no-op', async t => {
  const dir = scratch(t), before = fingerprint(dir), r = await child(t, dir, {}, true).closed;
  assert.equal(r.code, 0); assert.equal(r.stdout, ''); assert.equal(r.stderr, ''); assert.deepEqual(fingerprint(dir), before);
});
for (const entry of ['sync', 'promise', 'callback']) test(`M11/M13 native ${entry} interception control reaches actual rename and readback`, async t => {
  const dir = scratch(t), destination = path.join(dir, 'control-final');
  const r = await result(child(t, dir, { op: 'control', entry, args: { destination, outputRoot: dir } }));
  assert.equal(r.ok, true); assert.deepEqual(r.result, [0, 255, 13, 10]);
  assert.equal(r.counts.renames, 1); assert.ok(r.counts.reads > 0); assert.equal(r.counts.removals, 1);
  assert.deepEqual(r.phases, ['before-rename', 'after-rename']); assert.equal(r.committed, true); assert.equal(fs.existsSync(destination), false);
});
for (const phase of ['before-rename', 'after-rename']) test(`M11 independent actual child kill control ${phase}`, async t => {
  const dir = scratch(t), destination = path.join(dir, 'control-final');
  const f = { dir, args: { destination, outputRoot: dir } };
  const writer = await paused(t, f, phase, { op: 'control' });
  assert.equal(fs.existsSync(destination), phase === 'after-rename');
  await writer.kill();
  assert.equal(fs.existsSync(destination), phase === 'after-rename');
  assert.deepEqual(fs.readFileSync(path.join(phase === 'after-rename' ? destination : path.join(dir, 'control-stage'), 'bytes')), Buffer.from([0, 255, 13, 10]));
});
for (const mode of ['rename-error', 'readback-error', 'release-error']) test(`M10/M14 independent native ${mode} interception control`, async t => {
  const dir = scratch(t), destination = path.join(dir, 'control-final');
  const r = await result(child(t, dir, { op: 'control', mode, code: 'EIO', args: { destination, outputRoot: dir } }));
  assert.equal(r.ok, false); assert.equal(r.counts.renames, 1);
  assert.equal(r.committed, mode !== 'rename-error'); assert.equal(fs.existsSync(destination), mode !== 'rename-error');
  assert.ok(r.causes.some(c => c.code === (mode === 'release-error' ? 'EACCES' : 'EIO')));
  if (mode !== 'rename-error') assert.deepEqual(fs.readFileSync(path.join(destination, 'bytes')), Buffer.from([0, 255, 13, 10]));
});
for (const mismatch of [false, true]) test(`M13 independent native publication device control ${mismatch ? 'mismatch' : 'same-device'}`, async t => {
  const dir = scratch(t), destination = path.join(dir, 'control-final');
  const r = await result(child(t, dir, { op: 'control', mode: 'device', mismatch, args: { destination, outputRoot: dir } }));
  assert.ok(r.counts.deviceReads > 0); assert.equal(r.ok, !mismatch); assert.equal(r.counts.renames, mismatch ? 0 : 1);
  if (mismatch) assert.match(r.message, /unsupported-filesystem/); else assert.deepEqual(r.result, [0, 255, 13, 10]);
});

for (const packaged of [false, true]) behavior(`M01/M03/M06 exact ${packaged ? 'package' : 'local'} Plan Receipt members bytes owners and honest capabilities`, async t => {
  const f = fixture(t, { packaged }), before = [fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(f.misleading), fingerprint(f.home)];
  await noDispatch(() => exported(f));
  assert.deepEqual(await f.verify(), { verified: true, findings: [] });
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(f.misleading), fingerprint(f.home)], before);
  assert.deepEqual(f.expectedPlan.capabilities, capabilities);
  assert.equal(f.expectedPlan.files.some(m => m.path === `content/available/${E('con')}/entry.md`), false, 'requested skill emitted only in composition');
  if (packaged) {
    assert.equal(f.expectedPlan.files.some(m => m.path === `content/available/${E('native')}/entry.md`), false);
    for (const p of f.packages) for (const binding of p.owners) {
      assert.deepEqual((await plan(f)).mappings.filter(m => m.binding === binding && m.outputPath.startsWith('content/packages/')).map(m => m.sourcePath), p.members.map(m => m.path));
    }
  }
});

behavior('M02 omitted options equal explicit empty options', async t => {
  const f = fixture(t); assert.deepEqual(await plan(f), await sut.planMaterialization({ ...f.planInput, options: {} }));
});
const planInputs = [
  ['null options', { options: null }, /options/], ['scalar options', { options: 1 }, /options/], ['list options', { options: [] }, /options/],
  ['unknown options', { options: { force: true } }, /options|force/], ['unknown API field', { force: true }, /force|unknown/],
  ['unknown adapter', { adapterId: 'native' }, /adapter/], ['wrong adapter contract', { adapterContractVersion: 2 }, /adapter|contract/],
  ['typed adapter contract', { adapterContractVersion: '1' }, /adapter|contract/], ['short digest', { stampDigest: 'a' }, /digest|stampDigest/],
  ['uppercase digest', { stampDigest: 'A'.repeat(64) }, /digest|stampDigest/],
];
for (const [name, mutation, diagnostic] of planInputs) behavior(`M02 planning rejects ${name} unchanged`, async t => {
  const f = fixture(t), before = fingerprint(f.dir);
  await refuses(() => sut.planMaterialization({ ...f.planInput, ...mutation }), diagnostic);
  assert.deepEqual(fingerprint(f.dir), before);
});
const planEdits = [
  ['missing options', p => { delete p.options; }], ['extra field', p => { p.planDigest = 'a'.repeat(64); }],
  ['wrong version', p => { p.planVersion = 2; }], ['null adapter', p => { p.adapter = null; }],
  ['adapter extra', p => { p.adapter.force = true; }], ['capability extra', p => { p.capabilities.extra = 'verified'; }],
  ['capability claim', p => { p.capabilities.nativeInvocation = 'verified'; }], ['missing capability', p => { delete p.capabilities.bytePreservation; }],
  ['file extra', p => { p.files[0].bytes = 'arbitrary'; }], ['missing backing', p => { delete p.files[0].backing; }],
  ['blob size type', p => { p.files.find(f => f.backing.type === 'blob').backing.bytes = '0'; }],
  ['backing extra', p => { p.files[0].backing.extra = 1; }], ['snapshot digest', p => { p.files.find(f => f.backing.type === 'snapshot').backing.sha256 = 'b'.repeat(64); }],
  ['backing read redirect', p => { p.files.find(f => f.backing.type === 'blob').backing.path = 'elsewhere.md'; }],
  ['output redirect', p => { p.files[0].path = 'content/elsewhere.md'; }], ['escape path', p => { p.files[0].path = '../outside'; }],
  ['duplicate files', p => { p.files.push(clone(p.files[0])); }], ['file order', p => { p.files.reverse(); }],
  ['empty files', p => { p.files = []; }], ['missing mapping owner', p => { delete p.mappings[0].binding; }],
  ['mapping extra', p => { p.mappings[0].extra = true; }], ['mapping owner', p => { p.mappings[0].binding = 'roles.foreign'; }],
  ['blob packageDigest', p => { p.mappings.find(m => m.sourceKind === 'blob').packageDigest = 'b'.repeat(64); }],
  ['host name', p => { p.mappings[0].hostName = 'fake'; }], ['source kind', p => { p.mappings[0].sourceKind = 'live'; }],
  ['mapping duplicate', p => { p.mappings.push(clone(p.mappings[0])); }], ['mapping order', p => { p.mappings.reverse(); }],
  ['null files', p => { p.files = null; }], ['mapping object', p => { p.mappings = {}; }],
  ['null file', p => { p.files[0] = null; }], ['typed file path', p => { p.files[0].path = 1; }],
  ['null backing', p => { p.files[0].backing = null; }], ['unknown backing type', p => { p.files[0].backing.type = 'live'; }],
  ['backing short digest', p => { p.files[0].backing.sha256 = 'a'; }], ['null mapping', p => { p.mappings[0] = null; }],
  ['typed owner', p => { p.mappings[0].binding = 1; }], ['null capabilities', p => { p.capabilities = null; }],
];
for (const [name, edit] of planEdits) behavior(`M02 supplied Plan refuses ${name} before staging`, async t => {
  const f = fixture(t), p = clone(await plan(f)); edit(p);
  const before = fingerprint(f.dir);
  await refuses(() => sut.materialize({ ...f.args, plan: p }), /plan-mismatch|plan|backing|mapping|capabilit|options|adapter|path|field|version/);
  assert.deepEqual(fingerprint(f.dir), before, 'no staging or arbitrary backing read writes');
});

behavior('M04 encoded package and logical IDs remain exact and distinct', async t => {
  const f = fixture(t, { packaged: true }); await exported(f);
  assert.ok(fs.existsSync(path.join(f.storeRoot, 'identities/x-636f6e/x-726576696577/1.0.0.json')));
  assert.ok(fs.existsSync(path.join(f.storeRoot, 'identities/x-7465616d/x-6e756c/1.0.0.json')));
  assert.ok(fs.existsSync(path.join(f.args.destination, 'content/available', E('x-636f6e'), 'entry.md')));
  assert.ok(fs.existsSync(path.join(f.args.destination, 'content/resources', E('skills.con'), 'assets/requested.bin')));
  assert.equal((await plan(f)).mappings.some(m => m.binding === 'skills.x-636f6e'), true);
});
behavior('M04 generated binding path length refuses without truncation or publication', async t => {
  const f = fixture(t);
  // Rename an otherwise valid logical skill; keep a short physical source path.
  const { parse } = await import('yaml');
  const config = parse(fs.readFileSync(path.join(f.root, CONFIG), 'utf8'));
  const id = 'a'.repeat(128); config.skills[id] = config.skills['x-636f6e']; delete config.skills['x-636f6e'];
  config.roles.nul.skills.available = ['con', id]; put(path.join(f.root, CONFIG), stringify(config));
  const stamp = createStamp({ root: f.root, storeRoot: f.storeRoot, host: 'codex', skills: ['con'], sharedFiles: ['AGENTS.md'] });
  const before = fingerprint(f.dir);
  await refuses(async () => {
    const p = await sut.planMaterialization({ ...f.planInput, stampDigest: stamp.digest });
    await sut.materialize({ ...f.args, plan: p });
  }, /path-length|ENAMETOOLONG/);
  assert.deepEqual(fingerprint(f.dir), before);
});

behavior('M05 relocation and source deletion preserve Plan and output identities with explicit store', async t => {
  const a = fixture(t, { packaged: true }), b = fixture(t, { packaged: true });
  assert.equal(a.stamp.digest, b.stamp.digest); assert.deepEqual(await plan(a), await plan(b));
  for (const f of [a, b]) {
    fs.rmSync(f.root, { recursive: true }); fs.rmSync(path.join(f.dir, 'explicit-sources'), { recursive: true });
    const before = [fingerprint(f.storeRoot), fingerprint(f.misleading), fingerprint(f.home)];
    await exported(f); assert.deepEqual(await f.verify(), { verified: true, findings: [] });
    assert.deepEqual([fingerprint(f.storeRoot), fingerprint(f.misleading), fingerprint(f.home)], before);
  }
  assert.deepEqual(files(a.args.destination), files(b.args.destination));
  env(t, { AGENT_PROFILES_STORE: a.empty }); assert.deepEqual(await plan(a), a.expectedPlan);
});
behavior('M05 local profile and role binary resources survive complete project deletion', async t => {
  const f = fixture(t); fs.rmSync(f.root, { recursive: true });
  await exported(f); assert.deepEqual(await f.verify(), { verified: true, findings: [] });
});

// Native-fs observations are synchronized and restored even on assertion failures.
async function intercept(methods, body) {
  const originals = Object.fromEntries(Object.keys(methods).map(k => [k, fs[k]]));
  for (const [k, wrap] of Object.entries(methods)) fs[k] = wrap(originals[k]);
  syncBuiltinESMExports();
  try { await body(); } finally { Object.assign(fs, originals); syncBuiltinESMExports(); }
}
const boundaryCases = [
  ['existing file', f => { put(f.args.destination, binary); }, /destination-exists/],
  ['empty directory', f => { fs.mkdirSync(f.args.destination); }, /destination-exists/],
  ['nonempty directory', f => { put(path.join(f.args.destination, 'keep'), binary); }, /destination-exists/],
  ['escape', f => { f.args.destination = path.join(f.dir, 'escape'); }, /destination|boundary|outside|child/],
  ['nested child', f => { f.args.destination = path.join(f.outputRoot, 'nested/run'); }, /destination|direct.child/],
  ['source output', f => { f.args.outputRoot = f.root; f.args.destination = path.join(f.root, 'run'); }, /overlap|protected|denied/],
  ['store output', f => { f.args.outputRoot = f.storeRoot; f.args.destination = path.join(f.storeRoot, 'run'); }, /overlap|protected|denied/],
  ['ancestor output', f => { f.args.outputRoot = f.dir; f.args.destination = path.join(f.dir, 'run'); }, /overlap|protected|denied/],
  ['known host output', f => { const host = path.join(f.dir, 'known-host'); fs.mkdirSync(host); f.args.deniedRoots.push(host); f.args.outputRoot = host; f.args.destination = path.join(host, 'run'); }, /overlap|protected|denied/],
  ['deleted source boundary', f => { const retained = path.join(f.outputRoot, 'retained'); f.args.deniedRoots.push(retained); f.args.destination = retained; }, /overlap|protected|denied/],
  ['missing denied context', f => { delete f.args.deniedRoots; }, /boundary-context-required/],
  ['null denied context', f => { f.args.deniedRoots = null; }, /boundary|deniedRoots/],
  ['empty denied context', f => { f.args.deniedRoots = []; }, /boundary|deniedRoots/],
  ['scalar denied context', f => { f.args.deniedRoots = f.root; }, /boundary|deniedRoots/],
  ['typed denied member', f => { f.args.deniedRoots = [1]; }, /boundary|deniedRoots/],
  ['relative denied member', f => { f.args.deniedRoots = ['relative']; }, /boundary|deniedRoots/],
  ['remote denied member', f => { f.args.deniedRoots = ['https://invalid.example/root']; }, /boundary|deniedRoots|unsupported-filesystem/],
  ['blank denied member', f => { f.args.deniedRoots = ['']; }, /boundary|deniedRoots/],
  ['NUL denied member', f => { f.args.deniedRoots = [f.root + '\0']; }, /boundary|deniedRoots/],
  ['missing output root', f => { f.args.outputRoot = path.join(f.dir, 'missing'); f.args.destination = path.join(f.args.outputRoot, 'run'); }, /outputRoot|output root|boundary|directory/],
  ['file output root', f => { const file = path.join(f.dir, 'file'); put(file, binary); f.args.outputRoot = file; f.args.destination = path.join(file, 'run'); }, /outputRoot|output root|directory/],
];
for (const [name, setup, diagnostic] of boundaryCases) behavior(`M07 ${name} denies before missing stamp or backing reads`, async t => {
  const f = fixture(t); setup(f);
  const missing = clone(f.expectedPlan); missing.stampDigest = '0'.repeat(64); f.args.plan = missing;
  const before = fingerprint(f.dir); let backingReads = 0;
  await intercept({ openSync: original => (file, ...args) => {
    if (typeof file === 'string' && path.resolve(file).startsWith(f.storeRoot + path.sep)) backingReads++;
    return original(file, ...args);
  }, readFileSync: original => (file, ...args) => {
    if (typeof file === 'string' && path.resolve(file).startsWith(f.storeRoot + path.sep)) backingReads++;
    return original(file, ...args);
  } }, async () => { await refuses(() => sut.materialize(f.args), diagnostic); });
  assert.equal(backingReads, 0, 'boundary denial precedes backing access'); assert.deepEqual(fingerprint(f.dir), before);
});
for (const backing of ['blob', 'package']) behavior(`M07 existing destination denial precedes missing ${backing}`, async t => {
  const f = fixture(t, { packaged: true });
  const missing = backing === 'blob' ? path.join(f.storeRoot, 'blobs/sha256', sha(binary)) : path.join(f.storeRoot, 'objects/sha256', f.packages[0].digest);
  // Use a selected local required resource for the blob variant.
  fs.rmSync(backing === 'blob' ? path.join(f.storeRoot, 'blobs/sha256', sha(Buffer.alloc(0))) : missing, { recursive: true });
  fs.mkdirSync(f.args.destination); const before = fingerprint(f.dir);
  await refuses(() => sut.materialize(f.args), /destination-exists/); assert.deepEqual(fingerprint(f.dir), before);
});

for (const type of ['destination-junction', 'root-junction', 'destination-hardlink']) behavior(`M07 native ${type} refuses without following target`, async t => {
  const f = fixture(t), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside); put(path.join(outside, 'keep'), binary);
  if (type === 'destination-hardlink') fs.linkSync(path.join(outside, 'keep'), f.args.destination);
  else if (type === 'root-junction') {
    const link = path.join(f.dir, 'linked-root'); fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); f.args.outputRoot = link; f.args.destination = path.join(link, 'run');
  } else fs.symlinkSync(outside, f.args.destination, process.platform === 'win32' ? 'junction' : 'dir');
  const before = fingerprint(f.dir);
  f.args.plan = { ...f.expectedPlan, stampDigest: '0'.repeat(64) };
  await refuses(() => sut.materialize(f.args), /link|junction|reparse|destination-exists/);
  assert.deepEqual(fingerprint(f.dir), before);
});

behavior('M04/M06 unrequested con uses safe encoded available entry and retains binary resources', async t => {
  const f = fixture(t, { requested: false }); await exported(f);
  assert.deepEqual(fs.readFileSync(path.join(f.args.destination, 'content/available/x-636f6e/entry.md')), skill('con'));
  assert.deepEqual(fs.readFileSync(path.join(f.args.destination, `content/resources/${E('profiles.con')}/assets/profile.bin`)), binary);
  assert.deepEqual(fs.readFileSync(path.join(f.args.destination, `content/resources/${E('roles.nul')}/assets/role.bin`)), Buffer.from([128, 0, 13, 10]));
});

// Minimal operational-record proposal, for parent disposition before freeze.
// These records are not authenticated ownership against a malicious writer.
const lockName = destination => `.materialize-${E(path.basename(destination))}.lock`;
const lockPath = f => path.join(f.outputRoot, lockName(f.args.destination));
function owner(f) { return JSON.parse(fs.readFileSync(path.join(lockPath(f), 'owner.json'), 'utf8')); }
function checkOwner(f) {
  const o = owner(f);
  assert.deepEqual(Object.keys(o).sort(), ['operation', 'staging', 'stampDigest', 'target']);
  assert.match(o.operation, /^[a-zA-Z0-9-]+$/);
  assert.equal(o.target, path.basename(f.args.destination)); assert.equal(o.stampDigest, f.stamp.digest);
  assert.equal(o.staging, `.materialize-${E(o.target)}-${o.operation}.stage`);
  assert.equal(path.basename(o.staging), o.staging); return o;
}
const recoveryArgs = f => ({ destination: f.args.destination, outputRoot: f.outputRoot, expectedStampDigest: f.stamp.digest, storeRoot: f.storeRoot, deniedRoots: f.args.deniedRoots, confirmNoActiveWriter: true });

for (const surface of ['lock', 'stage']) behavior(`M07 hostile ${surface} is preflighted without external mutation`, async t => {
  const f = fixture(t), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside); put(path.join(outside, 'keep'), binary);
  if (surface === 'lock') fs.symlinkSync(outside, lockPath(f), process.platform === 'win32' ? 'junction' : 'dir');
  else {
    // Replace the newly allocated stage before the caller can approve/use it.
    let attacked = false;
    const before = fingerprint(outside);
    await intercept({ mkdirSync: original => (file, ...args) => {
      const result = original(file, ...args);
      if (!attacked && typeof file === 'string' && file.endsWith('.stage')) {
        fs.rmSync(file, { recursive: true }); fs.symlinkSync(outside, file, process.platform === 'win32' ? 'junction' : 'dir'); attacked = true;
      }
      return result;
    } }, async () => { await refuses(() => sut.materialize(f.args), /link|junction|reparse|identity|changed|unsafe/); });
    assert.equal(attacked, true); assert.deepEqual(fingerprint(outside), before); assert.equal(fs.existsSync(f.args.destination), false);
    // The unsafe stage may remain for explicit operator inspection; never traverse it.
  }
  if (surface === 'lock') {
    const before = fingerprint(f.dir); f.args.plan = { ...f.expectedPlan, stampDigest: '0'.repeat(64) };
    await refuses(() => sut.materialize(f.args), /link|junction|reparse|unsafe/); assert.deepEqual(fingerprint(f.dir), before);
  }
});
behavior('M07 destination created after staging is rechecked and preserved before publication', async t => {
  const f = fixture(t); let receiptFd, edited = false;
  const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  await intercept({ openSync: original => (file, flags, ...args) => {
    const fd = original(file, flags, ...args);
    if (typeof file === 'string' && file.endsWith(path.sep + 'receipt.json') && file.includes('.stage')) receiptFd = fd;
    return fd;
  }, closeSync: original => fd => {
    original(fd);
    if (fd === receiptFd && !edited) { edited = true; put(path.join(f.args.destination, 'user-edit'), binary); }
  } }, async () => { await refuses(() => sut.materialize(f.args), /destination-exists/); });
  assert.equal(edited, true); assert.deepEqual(files(f.args.destination), [{ path: 'user-edit', bytes: binary }]);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
  assert.deepEqual(fs.readdirSync(f.outputRoot), ['run']);
});

behavior('M08 two real revision exports overlap at native rename barriers independently', async t => {
  const a = fixture(t, { packaged: true }), b = fixture(t, { packaged: true, version: '2.0.0' });
  // Share store and output root: a store-wide export lock would prevent the second barrier.
  const originalBStore = b.storeRoot;
  fs.cpSync(originalBStore, a.storeRoot, { recursive: true });
  b.storeRoot = a.storeRoot; b.args.storeRoot = a.storeRoot; b.planInput.storeRoot = a.storeRoot;
  b.verify = () => sut.verifyMaterialization({ destination: b.args.destination, expectedStampDigest: b.stamp.digest, storeRoot: a.storeRoot });
  b.args.outputRoot = a.outputRoot; b.args.destination = path.join(a.outputRoot, 'second'); b.outputRoot = a.outputRoot;
  const before = [fingerprint(a.root), fingerprint(a.storeRoot), fingerprint(b.root), fingerprint(originalBStore)];
  const first = await paused(t, a, 'before-rename', {}, 'first');
  const second = await paused(t, { ...b, dir: a.dir }, 'before-rename', {}, 'second');
  assert.equal(fs.existsSync(a.args.destination), false); assert.equal(fs.existsSync(b.args.destination), false);
  assert.notEqual(lockPath(a), lockPath(b)); checkOwner(a); checkOwner(b);
  assert.equal((await first.release()).ok, true); exactOutput(a); const committed = fingerprint(a.args.destination);
  assert.equal((await second.release()).ok, true); exactOutput(b);
  assert.deepEqual(fingerprint(a.args.destination), committed);
  assert.deepEqual([fingerprint(a.root), fingerprint(a.storeRoot), fingerprint(b.root), fingerprint(originalBStore)], before);
  assert.deepEqual(await a.verify(), { verified: true, findings: [] }); assert.deepEqual(await b.verify(), { verified: true, findings: [] });
});

behavior('M09 same target native barrier yields one winner and one refusal without ownership clobber', async t => {
  const f = fixture(t), writer = await paused(t, f, 'before-rename'); checkOwner(f);
  const locked = fingerprint(lockPath(f));
  const loser = await result(child(t, f.dir, { args: f.args }));
  assert.equal(loser.ok, false); assert.match(loser.message, /materialization-busy|destination-busy|target-busy/);
  assert.deepEqual(fingerprint(lockPath(f)), locked); assert.equal(fs.existsSync(f.args.destination), false);
  const winner = await writer.release(); assert.equal(winner.ok, true); assert.deepEqual(winner.result, f.expectedReceipt); exactOutput(f);
  await refuses(() => sut.materialize(f.args), /destination-exists/); exactOutput(f);
});

for (const mode of ['write-error', 'cleanup-error']) behavior(`M10 caught precommit ${mode} preserves unrelated source store and output`, async t => {
  const f = fixture(t); put(path.join(f.outputRoot, 'unrelated-stage/keep'), binary);
  const before = [fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(path.join(f.outputRoot, 'unrelated-stage'))];
  const r = await result(child(t, f.dir, { args: f.args, mode }));
  assert.equal(r.ok, false); assert.ok(r.counts.stagingWrites > 1, JSON.stringify(r)); assert.equal(r.counts.renames, 0);
  assert.match(r.message, /EIO|injected/); assert.equal(fs.existsSync(f.args.destination), false);
  assert.ok(r.causes.some(c => c.code === 'EIO'), JSON.stringify(r));
  if (mode === 'cleanup-error') assert.match(JSON.stringify(r), /EACCES|cleanup/i);
  else assert.deepEqual(fs.readdirSync(f.outputRoot), ['unrelated-stage']);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot), fingerprint(path.join(f.outputRoot, 'unrelated-stage'))], before);
});

for (const phase of ['before-rename', 'after-rename']) behavior(`M11 actual owned child kill ${phase} preserves commit boundary and confirmed recovery`, async t => {
  const f = fixture(t, { packaged: true }); const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  put(path.join(f.outputRoot, 'ordinary-sibling/keep'), binary);
  const ordinary = fingerprint(path.join(f.outputRoot, 'ordinary-sibling'));
  const writer = await paused(t, f, phase); const o = checkOwner(f);
  if (phase === 'before-rename') { assert.equal(fs.existsSync(f.args.destination), false); assert.ok(fs.existsSync(path.join(f.outputRoot, o.staging, 'receipt.json'))); }
  else exactOutput(f);
  await writer.kill();
  if (phase === 'before-rename') assert.equal(fs.existsSync(f.args.destination), false); else exactOutput(f);
  fs.utimesSync(lockPath(f), new Date('2000-01-01'), new Date('2000-01-01'));
  fs.utimesSync(path.join(lockPath(f), 'owner.json'), new Date('2000-01-01'), new Date('2000-01-01'));
  const stale = fingerprint(f.outputRoot);
  await refuses(() => sut.materialize(f.args), phase === 'before-rename' ? /materialization-busy|destination-busy|target-busy/ : /destination-exists/);
  assert.deepEqual(fingerprint(f.outputRoot), stale);
  const r = await sut.recoverMaterialization(recoveryArgs(f));
  assert.deepEqual([...r.removed].sort(cmp), [lockName(f.args.destination), ...phase === 'before-rename' ? [o.staging] : []].sort(cmp));
  assert.deepEqual(r.verification, phase === 'before-rename' ? null : { verified: true, findings: [] });
  assert.deepEqual(fingerprint(path.join(f.outputRoot, 'ordinary-sibling')), ordinary);
  if (phase === 'after-rename') { exactOutput(f); await refuses(() => sut.materialize(f.args), /destination-exists/); }
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

for (const packaged of [false, true]) test(`M03/M06 independent ${packaged ? 'package' : 'local'} unrequested fixture retains available con`, t => {
  const f = fixture(t, { packaged, requested: false });
  assert.deepEqual(f.stamp.snapshot.requested, []);
  assert.equal(f.reconstructed.composition.some(e => e.id === 'con' && e.kind === 'requested-skill'), false);
  assert.deepEqual(f.reconstructed.available.find(e => e.id === 'con').bytes, skill('con'));
  assert.equal(f.expectedPlan.files.length, packaged ? 28 : 12);
  assert.equal(f.expectedPlan.mappings.length, packaged ? 38 : 12);
  assert.deepEqual(f.expectedPlan.files.find(e => e.path === 'content/available/x-636f6e/entry.md').backing,
    { type: 'blob', sha256: sha(skill('con')), bytes: skill('con').length, path: 'instructions/con-safe.md' });
  assert.deepEqual(f.content.find(e => e.path === 'available/x-636f6e/entry.md').bytes, skill('con'));
  assert.deepEqual(f.reconstructed.resources.find(r => r.binding === 'skills.con').bytes, f.local['assets/requested.bin']);
});

test('M08 independent two-version shared store verifies both exact retained closures', t => {
  const a = fixture(t, { packaged: true }), b = fixture(t, { packaged: true, version: '2.0.0' });
  const protectedBefore = [fingerprint(a.root), fingerprint(b.root), fingerprint(b.storeRoot)];
  fs.cpSync(b.storeRoot, a.storeRoot, { recursive: true });
  const mergedBefore = fingerprint(a.storeRoot);
  assert.notEqual(a.stamp.digest, b.stamp.digest);
  assert.deepEqual(fs.readdirSync(path.join(a.storeRoot, 'objects/sha256')).sort(cmp),
    [...a.packages, ...b.packages].map(p => p.digest).sort(cmp));
  assert.deepEqual(fs.readdirSync(path.join(a.storeRoot, 'stamps/sha256')).sort(cmp), [a.stamp.digest, b.stamp.digest].sort(cmp));
  for (const [f, version] of [[a, '1.0.0'], [b, '2.0.0']]) {
    assert.equal(verifyStamp({ digest: f.stamp.digest, storeRoot: a.storeRoot }).managedReproducible, true);
    assert.deepEqual(reconstructStamp({ digest: f.stamp.digest, storeRoot: a.storeRoot }), f.reconstructed);
    assert.deepEqual(f.stamp.snapshot.packages.map(p => [p.name, p.version, p.sha256]),
      f.packages.map(p => [p.name, version, p.digest]).sort((x, y) => cmp(x[0], y[0])));
    for (const p of f.packages) {
      const found = lookupPackage({ storeRoot: a.storeRoot, name: p.name, version });
      assert.deepEqual(found.identity, { name: p.name, version });
      assert.equal(found.sha256, p.digest); assert.deepEqual(found.files, p.members);
    }
  }
  assert.deepEqual(fingerprint(a.storeRoot), mergedBefore);
  assert.deepEqual([fingerprint(a.root), fingerprint(b.root), fingerprint(b.storeRoot)], protectedBefore);
});

test('M04 independent long logical ID captures valid backing before generated-path refusal', async t => {
  const f = fixture(t), { parse } = await import('yaml');
  const config = parse(fs.readFileSync(path.join(f.root, CONFIG), 'utf8'));
  const id = 'a'.repeat(128); config.skills[id] = config.skills['x-636f6e']; delete config.skills['x-636f6e'];
  config.roles.nul.skills.available = ['con', id]; put(path.join(f.root, CONFIG), stringify(config));
  const stamp = createStamp({ root: f.root, storeRoot: f.storeRoot, host: 'codex', skills: ['con'], sharedFiles: ['AGENTS.md'] });
  assert.equal(stamp.digest, record(stamp.snapshot, 'agent-profiles/stamp/v1'));
  const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  assert.equal(verifyStamp({ digest: stamp.digest, storeRoot: f.storeRoot }).managedReproducible, true);
  const restored = reconstructStamp({ digest: stamp.digest, storeRoot: f.storeRoot });
  const available = restored.available.find(e => e.id === id);
  assert.ok(available); assert.deepEqual(available.bytes, skill('idle'));
  assert.equal(available.backing.path, 'instructions/idle.md');
  assert.deepEqual(restored.resources.find(r => r.binding === `skills.${id}`).bytes, f.local['assets/idle.bin']);
  assert.equal(E(id).length, 258); assert.equal(E(`skills.${id}`).length, 272);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

for (const mode of ['write-error', 'cleanup-error']) test(`M10 independent native writeFlushed ${mode} reaches staged IO and preserves unrelated bytes`, async t => {
  const dir = scratch(t), outputRoot = path.join(dir, 'out'), destination = path.join(outputRoot, 'final');
  put(path.join(outputRoot, 'unrelated/keep'), binary); put(path.join(dir, 'outside/keep'), sharedBytes);
  const unrelated = fingerprint(path.join(outputRoot, 'unrelated')), outside = fingerprint(path.join(dir, 'outside'));
  const r = await result(child(t, dir, { op: 'write-control', mode, args: { destination, outputRoot } }));
  assert.equal(r.ok, false); assert.equal(r.counts.stagingWrites, 2); assert.equal(r.counts.removals, 1);
  assert.equal(r.counts.renames, 0); assert.equal(r.committed, false); assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(r.phases, ['first-file-flushed']);
  assert.ok(r.causes.some(c => c.code === 'EIO' && c.message === 'owned injected EIO'), JSON.stringify(r));
  assert.match(r.message, /owned injected EIO/);
  assert.equal(r.stage, path.join(outputRoot, 'control.stage'));
  if (mode === 'cleanup-error') {
    assert.equal(r.code, 'EACCES'); assert.match(r.message, /cleanup: owned injected EACCES/);
    assert.deepEqual(files(r.stage), [{ path: 'first.bin', bytes: Buffer.from([0, 255, 13, 10]) }]);
    assert.deepEqual(fs.readdirSync(outputRoot).sort(cmp), ['control.stage', 'unrelated']);
  } else {
    assert.equal(r.code, 'EIO'); assert.equal(fs.existsSync(r.stage), false);
    assert.deepEqual(fs.readdirSync(outputRoot), ['unrelated']);
  }
  assert.deepEqual(fingerprint(path.join(outputRoot, 'unrelated')), unrelated);
  assert.deepEqual(fingerprint(path.join(dir, 'outside')), outside);
});

behavior('M12 recovery absent state is an explicit no-op', async t => {
  const f = fixture(t), before = fingerprint(f.dir);
  assert.deepEqual(await sut.recoverMaterialization(recoveryArgs(f)), { removed: [], verification: null });
  assert.deepEqual(fingerprint(f.dir), before);
});
behavior('M12 ordinary committed final verifies and remains byte-identical with no leftovers', async t => {
  const f = fixture(t); await exported(f); const before = fingerprint(f.dir);
  assert.deepEqual(await sut.recoverMaterialization(recoveryArgs(f)), { removed: [], verification: { verified: true, findings: [] } });
  assert.deepEqual(fingerprint(f.dir), before);
});
for (const confirmation of [undefined, false, 'true', 1]) behavior(`M12 recovery rejects confirmation ${String(confirmation)}`, async t => {
  const f = fixture(t), before = fingerprint(f.dir);
  await refuses(() => sut.recoverMaterialization({ ...recoveryArgs(f), confirmNoActiveWriter: confirmation }), /confirmNoActiveWriter|confirmation/);
  assert.deepEqual(fingerprint(f.dir), before);
});
for (const expected of [undefined, 'a', 'A'.repeat(64)]) behavior(`M12 recovery rejects malformed independent expectation ${String(expected)}`, async t => {
  const f = fixture(t), before = fingerprint(f.dir);
  await refuses(() => sut.recoverMaterialization({ ...recoveryArgs(f), expectedStampDigest: expected }), /expectedStampDigest|digest|expectation/);
  assert.deepEqual(fingerprint(f.dir), before);
});

const ownerEdits = [
  ['unknown field', o => { o.pid = 2147483646; }], ['wrong target', o => { o.target = 'foreign'; }],
  ['wrong stamp', o => { o.stampDigest = 'b'.repeat(64); }], ['escaped stage', o => { o.staging = '../outside'; }],
  ['foreign stage', o => { o.staging = '.materialize-other.stage'; }], ['missing operation', o => { delete o.operation; }],
];
for (const [name, edit] of ownerEdits) behavior(`M12 recovery preflights ${name} owner unchanged`, async t => {
  const f = fixture(t), writer = await paused(t, f, 'before-rename'); const o = checkOwner(f); await writer.kill();
  edit(o); put(path.join(lockPath(f), 'owner.json'), J(o)); const before = fingerprint(f.dir);
  await refuses(() => sut.recoverMaterialization(recoveryArgs(f)), /owner|ownership|staging|target|stamp|recovery|field/);
  assert.deepEqual(fingerprint(f.dir), before);
});
for (const state of ['malformed-owner', 'linked-stage', 'linked-owner', 'unknown-lock-member']) behavior(`M12 recovery refuses ${state} before any deletion`, async t => {
  const f = fixture(t), writer = await paused(t, f, 'before-rename'); const o = checkOwner(f); await writer.kill();
  const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside); put(path.join(outside, 'keep'), binary);
  if (state === 'malformed-owner') put(path.join(lockPath(f), 'owner.json'), '{');
  if (state === 'linked-stage') { const stage = path.join(f.outputRoot, o.staging); fs.rmSync(stage, { recursive: true }); fs.symlinkSync(outside, stage, process.platform === 'win32' ? 'junction' : 'dir'); }
  if (state === 'linked-owner') { fs.unlinkSync(path.join(lockPath(f), 'owner.json')); fs.linkSync(path.join(outside, 'keep'), path.join(lockPath(f), 'owner.json')); }
  if (state === 'unknown-lock-member') put(path.join(lockPath(f), 'foreign'), 'keep');
  const before = fingerprint(f.dir);
  await refuses(() => sut.recoverMaterialization(recoveryArgs(f)), /owner|ownership|link|junction|unsafe|recovery|record|JSON/);
  assert.deepEqual(fingerprint(f.dir), before);
});
for (const damage of ['output', 'stamp', 'blob', 'package']) behavior(`M12 invalid final ${damage} preserves complete stale state and reports findings`, async t => {
  const f = fixture(t, { packaged: true }), writer = await paused(t, f, 'after-rename'); checkOwner(f); await writer.kill();
  if (damage === 'output') put(path.join(f.args.destination, 'content/instructions/0000.md'), 'tampered');
  if (damage === 'stamp') fs.rmSync(path.join(f.storeRoot, 'stamps/sha256', f.stamp.digest), { recursive: true });
  if (damage === 'blob') fs.unlinkSync(path.join(f.storeRoot, 'blobs/sha256', sha(Buffer.alloc(0))));
  if (damage === 'package') fs.rmSync(path.join(f.storeRoot, 'objects/sha256', f.packages[0].digest), { recursive: true });
  const before = fingerprint(f.dir), r = await sut.recoverMaterialization(recoveryArgs(f));
  assert.deepEqual(r.removed, []); assert.equal(r.verification.verified, false); assert.ok(r.verification.findings.length > 0);
  const code = damage === 'output' ? 'output-mismatch' : damage === 'stamp' ? 'stamp-missing' : 'backing-missing';
  const relative = damage === 'output' ? 'instructions/0000.md' : damage === 'stamp' ? f.stamp.digest : damage === 'blob' ? sha(Buffer.alloc(0)) : f.packages[0].digest;
  assert.ok(r.verification.findings.some(s => s.startsWith(code) && s.includes(relative)), JSON.stringify(r));
  assert.deepEqual(fingerprint(f.dir), before);
});

for (const [code, diagnostic] of [['EXDEV', /unsupported-filesystem/], ['ENOTSUP', /unsupported-filesystem/], ['EOPNOTSUPP', /unsupported-filesystem/], ['EPERM', /publication-denied/], ['EACCES', /publication-denied/], ['EIO', /EIO/]]) behavior(`M13 observed rename ${code} retains cause without visible copy fallback`, async t => {
  const f = fixture(t), before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  const r = await result(child(t, f.dir, { args: f.args, mode: 'rename-error', code }));
  assert.equal(r.ok, false); assert.equal(r.counts.renames, 1); assert.match(r.message, diagnostic);
  assert.ok(r.causes.some(c => c.code === code && c.message === `owned injected ${code}`), JSON.stringify(r));
  if (code === 'EIO') assert.doesNotMatch(r.message, /unsupported-filesystem|publication-denied/);
  assert.equal(fs.existsSync(f.args.destination), false); assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});
for (const mismatch of [false, true]) behavior(`M13 native device descriptor ${mismatch ? 'mismatch' : 'same-device positive control'}`, async t => {
  const f = fixture(t), r = await result(child(t, f.dir, { args: f.args, mode: 'device', mismatch }));
  assert.ok(r.counts.deviceReads > 0, JSON.stringify(r));
  assert.equal(r.ok, !mismatch);
  if (mismatch) { assert.match(r.message, /unsupported-filesystem/); assert.equal(r.counts.renames, 0); assert.equal(fs.existsSync(f.args.destination), false); }
  else { assert.equal(r.counts.renames, 1); exactOutput(f); }
});
behavior('M13 nonlocal output refuses before native filesystem dispatch', async t => {
  const f = fixture(t), before = fingerprint(f.dir); let remote = 0;
  await intercept(Object.fromEntries(['lstatSync', 'realpathSync', 'openSync', 'mkdirSync'].map(k => [k, original => (file, ...args) => {
    if (typeof file === 'string' && /^[\\/]{2}|^[a-z]+:\/\//i.test(file)) { remote++; throw new Error('forbidden remote dispatch'); }
    return original(file, ...args);
  }])), async () => { await refuses(() => sut.materialize({ ...f.args, outputRoot: '//invalid.example/share', destination: '//invalid.example/share/run' }), /unsupported-filesystem/); });
  assert.equal(remote, 0); assert.deepEqual(fingerprint(f.dir), before);
});

behavior('M14 valid verification is read-only on existing destination with explicit store', async t => {
  const f = fixture(t, { packaged: true }); await exported(f);
  const before = fingerprint(f.dir); assert.deepEqual(await f.verify(), { verified: true, findings: [] });
  assert.deepEqual(fingerprint(f.dir), before);
  env(t, { AGENT_PROFILES_STORE: f.empty }); assert.deepEqual(await f.verify(), { verified: true, findings: [] });
});
const receiptEdits = [
  ['missing options', r => { delete r.options; }, 'receipt-schema'], ['missing status', r => { delete r.status; }, 'receipt-schema'],
  ['unknown field', r => { r.destination = 'irrelevant'; }, 'receipt-schema'], ['wrong version', r => { r.receiptVersion = 2; }, 'receipt-schema'],
  ['typed version', r => { r.receiptVersion = '1'; }, 'receipt-schema'], ['wrong status', r => { r.status = 'staged'; }, 'receipt-schema'],
  ['null options', r => { r.options = null; }, 'receipt-schema'], ['list options', r => { r.options = []; }, 'receipt-schema'],
  ['nonempty options', r => { r.options.force = true; }, 'receipt-schema'], ['adapter extra', r => { r.adapter.extra = true; }, 'receipt-schema'],
  ['unknown adapter', r => { r.adapter.id = 'native'; }, 'receipt-schema'], ['adapter version', r => { r.adapter.contractVersion = 2; }, 'receipt-schema'],
  ['uppercase stamp', r => { r.stampDigest = 'A'.repeat(64); }, 'receipt-schema'], ['short plan digest', r => { r.planDigest = 'a'; }, 'receipt-schema'],
  ['null mappings', r => { r.mappings = null; }, 'receipt-schema'], ['missing mapping field', r => { delete r.mappings[0].hostName; }, 'receipt-schema'],
  ['mapping extra', r => { r.mappings[0].extra = 1; }, 'receipt-schema'], ['typed mapping digest', r => { r.mappings[0].sourceDigest = 1; }, 'receipt-schema'],
  ['mapping path escape', r => { r.mappings[0].sourcePath = '../escape'; }, 'receipt-schema'],
  ['false blob package digest', r => { r.mappings.find(m => m.sourceKind === 'blob').packageDigest = 'b'.repeat(64); }, 'receipt-schema'],
  ['missing capability', r => { delete r.capabilities.runtimeRendering; }, 'receipt-schema'], ['unknown capability', r => { r.capabilities.extra = 'unverified'; }, 'receipt-schema'],
  ['false native claim', r => { r.capabilities.nativeInvocation = 'verified'; }, 'receipt-schema'],
  ['false plan digest', r => { r.planDigest = 'b'.repeat(64); }, 'plan-mismatch'], ['wrong owner', r => { r.mappings[0].binding = 'roles.foreign'; }, 'plan-mismatch'],
  ['omitted mapping', r => { r.mappings.pop(); }, 'plan-mismatch'], ['mapping duplicate', r => { r.mappings.push(clone(r.mappings[0])); }, 'receipt-schema'],
  ['mapping order', r => { r.mappings.reverse(); }, 'receipt-schema'], ['false output digest', r => { r.outputDigest = 'b'.repeat(64); }, 'output-digest-mismatch'],
];
for (const [name, edit, code] of receiptEdits) behavior(`M14 strict Receipt ${name} yields ${code} read-only`, async t => {
  const f = fixture(t); await exported(f); const r = clone(f.expectedReceipt); edit(r);
  put(path.join(f.args.destination, 'receipt.json'), J(r)); await finding(f, code, code.startsWith('receipt-') ? 'receipt.json' : '');
});
for (const [name, bytes, code] of [
  ['missing', null, 'receipt-missing'], ['invalid JSON', '{', 'receipt-malformed'], ['noncanonical whitespace', ' {}\n', 'receipt-malformed'],
  ['scalar', '1', 'receipt-schema'], ['null', 'null', 'receipt-schema'], ['array', '[]', 'receipt-schema'],
]) behavior(`M14 ${name} receipt has precise named finding`, async t => {
  const f = fixture(t); await exported(f); const receipt = path.join(f.args.destination, 'receipt.json');
  if (bytes === null) fs.unlinkSync(receipt); else put(receipt, bytes);
  await finding(f, code, 'receipt.json');
});
for (const malformed of ['duplicate', 'exponent', 'BOM', 'newline']) behavior(`M14 ${malformed} otherwise complete Receipt is refused`, async t => {
  const f = fixture(t); await exported(f); let bytes = J(f.expectedReceipt);
  if (malformed === 'duplicate') bytes = bytes.replace('"receiptVersion":1', '"receiptVersion":1,"receiptVersion":1');
  if (malformed === 'exponent') bytes = bytes.replace('"receiptVersion":1', '"receiptVersion":1e0');
  if (malformed === 'BOM') bytes = '\uFEFF' + bytes;
  if (malformed === 'newline') bytes += '\n';
  put(path.join(f.args.destination, 'receipt.json'), bytes); await finding(f, 'receipt-malformed', 'receipt.json');
});
const byteEdits = [
  ['snapshot', 'snapshot.json'], ['profile', 'instructions/0000.md'], ['role', 'instructions/0001.md'],
  ['required', 'instructions/0002.md'], ['requested', 'instructions/0003.md'],
  ['available', `available/${E('x-636f6e')}/entry.md`], ['profile binary', `resources/${E('profiles.con')}/assets/profile.bin`],
  ['role binary', `resources/${E('roles.nul')}/assets/role.bin`], ['zero byte', `resources/${E('skills.req')}/assets/req.bin`],
  ['unrequested binary', `resources/${E('skills.x-636f6e')}/assets/idle.bin`], ['shared', 'shared/AGENTS.md'],
];
for (const [name, relative] of byteEdits) behavior(`M14 changed ${name} bytes fails independently even with recomputed TREE receipt`, async t => {
  const f = fixture(t); await exported(f);
  const file = path.join(f.args.destination, 'content', relative); fs.appendFileSync(file, Buffer.from([0, 255]));
  // Keep outputDigest internally correct so checking only self-consistent receipt/tree cannot pass.
  const r = clone(f.expectedReceipt); r.outputDigest = tree(files(path.join(f.args.destination, 'content')));
  put(path.join(f.args.destination, 'receipt.json'), J(r)); await finding(f, 'output-mismatch', relative);
});
for (const kind of ['missing', 'extra-content', 'extra-outside', 'package-member']) behavior(`M14 ${kind} output membership fails read-only`, async t => {
  const f = fixture(t, { packaged: true }); await exported(f);
  let code, relevant;
  if (kind === 'missing') { relevant = 'instructions/0000.md'; code = 'output-missing'; fs.unlinkSync(path.join(f.args.destination, 'content', relevant)); }
  if (kind === 'extra-content') { relevant = 'extra.bin'; code = 'output-extra'; put(path.join(f.args.destination, 'content', relevant), binary); }
  if (kind === 'extra-outside') { relevant = 'extra.bin'; code = 'output-extra'; put(path.join(f.args.destination, relevant), binary); }
  if (kind === 'package-member') { relevant = `packages/sha256/${f.packages[2].digest}/hooks/inert.json`; code = 'output-mismatch'; put(path.join(f.args.destination, 'content', relevant), '{}'); }
  await finding(f, code, relevant);
});
for (const backing of ['store', 'stamp', 'blob', 'package']) behavior(`M14 missing ${backing} evidence cannot be replaced by a valid output Receipt`, async t => {
  const f = fixture(t, { packaged: true }); await exported(f);
  const target = backing === 'store' ? f.storeRoot : backing === 'stamp' ? path.join(f.storeRoot, 'stamps/sha256', f.stamp.digest)
    : backing === 'blob' ? path.join(f.storeRoot, 'blobs/sha256', sha(Buffer.alloc(0))) : path.join(f.storeRoot, 'objects/sha256', f.packages[0].digest);
  fs.rmSync(target, { recursive: true });
  const before = fingerprint(f.dir), r = await f.verify(); assert.equal(r.verified, false); assert.ok(r.findings.length > 0);
  const code = ['store', 'stamp'].includes(backing) ? 'stamp-missing' : 'backing-missing';
  const expected = ['store', 'stamp'].includes(backing) ? f.stamp.digest : backing === 'blob' ? sha(Buffer.alloc(0)) : f.packages[0].digest;
  assert.ok(r.findings.some(s => s.startsWith(code) && s.includes(expected)), JSON.stringify(r));
  assert.deepEqual(fingerprint(f.dir), before);
});

behavior('M14 valid B output and B Receipt cannot substitute for caller A expectation', async t => {
  const a = fixture(t, { packaged: true }), b = fixture(t, { packaged: true, version: '2.0.0' });
  await exported(a); await exported(b); assert.notEqual(a.stamp.digest, b.stamp.digest);
  assert.deepEqual(await a.verify(), { verified: true, findings: [] }); assert.deepEqual(await b.verify(), { verified: true, findings: [] });
  // Both backing closures are present in the caller-selected store, removing incidental missing-store masking.
  fs.cpSync(b.storeRoot, a.storeRoot, { recursive: true });
  const retainedA = path.join(a.outputRoot, 'retained-a'); fs.renameSync(a.args.destination, retainedA);
  fs.cpSync(b.args.destination, a.args.destination, { recursive: true });
  assert.deepEqual(await sut.verifyMaterialization({ destination: a.args.destination, expectedStampDigest: b.stamp.digest, storeRoot: a.storeRoot }), { verified: true, findings: [] });
  await finding(a, 'stamp-mismatch');
  const lying = clone(b.expectedReceipt); lying.stampDigest = a.stamp.digest;
  put(path.join(a.args.destination, 'receipt.json'), J(lying)); await finding(a, 'plan-mismatch');
  // A complete A receipt also cannot bless B bytes, even though it supplies every expected metadata field.
  put(path.join(a.args.destination, 'receipt.json'), J(a.expectedReceipt)); await finding(a, 'output-mismatch', 'snapshot.json');
  exactOutput(a, retainedA);
});

for (const mode of ['readback-error', 'release-error']) behavior(`M14 postcommit ${mode} retains complete final and observed cause for verify/recovery`, async t => {
  const f = fixture(t, { packaged: true }), before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  const r = await result(child(t, f.dir, { args: f.args, mode }));
  assert.equal(r.ok, false); assert.equal(r.committed, true); assert.equal(r.counts.renames, 1);
  assert.match(r.message, /committed-but-unacknowledged/);
  assert.ok(r.causes.some(c => c.code === (mode === 'readback-error' ? 'EIO' : 'EACCES')), JSON.stringify(r));
  exactOutput(f); const committed = fingerprint(f.args.destination);
  assert.deepEqual(await f.verify(), { verified: true, findings: [] });
  await refuses(() => sut.materialize(f.args), /destination-exists/);
  const recovered = await sut.recoverMaterialization(recoveryArgs(f));
  assert.deepEqual(recovered.verification, { verified: true, findings: [] });
  assert.deepEqual(fingerprint(f.args.destination), committed);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

// Native prerequisite observations are separate from the missing materializer seam.
function ownedCaseAlias(outputRoot) {
  const original = path.join(outputRoot, 'Run'), alias = path.join(outputRoot, 'run');
  put(path.join(original, 'keep.bin'), binary);
  let aliasStat;
  try { aliasStat = fs.lstatSync(alias, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (aliasStat) {
    const originalStat = fs.lstatSync(original, { bigint: true });
    assert.equal(aliasStat.isDirectory(), true); assert.equal(aliasStat.isSymbolicLink(), false);
    assert.equal(aliasStat.dev, originalStat.dev); assert.equal(aliasStat.ino, originalStat.ino);
    assert.deepEqual(fs.readFileSync(path.join(alias, 'keep.bin')), binary);
  }
  return { original, alias, equivalent: aliasStat !== undefined };
}

function ownedAncestorAlias(dir) {
  const parent = path.join(dir, 'ordinary-parent'), link = path.join(dir, 'ancestor-alias');
  const canonicalOutputRoot = path.join(parent, 'out');
  fs.mkdirSync(canonicalOutputRoot, { recursive: true });
  fs.symlinkSync(parent, link, process.platform === 'win32' ? 'junction' : 'dir');
  const outputRoot = path.join(link, 'out');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(outputRoot).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(outputRoot).isDirectory(), true);
  assert.equal(fs.realpathSync(outputRoot), fs.realpathSync(canonicalOutputRoot));
  return { link, outputRoot, canonicalOutputRoot };
}

test('M07 independent owned filesystem observes Run and run alias equivalence', t => {
  const dir = scratch(t), observed = ownedCaseAlias(dir);
  assert.deepEqual(fs.readdirSync(dir), ['Run']);
  assert.deepEqual(files(observed.original), [{ path: 'keep.bin', bytes: binary }]);
  if (observed.equivalent) assert.deepEqual(files(observed.alias), files(observed.original));
  else assert.equal(fs.existsSync(observed.alias), false);
  t.diagnostic(`owned destination alias equivalence: ${observed.equivalent}; observed on this temporary filesystem only`);
});

test('M07 independent owned ancestor alias resolves above ordinary outputRoot', t => {
  const dir = scratch(t), observed = ownedAncestorAlias(dir);
  put(path.join(observed.outputRoot, 'probe.bin'), binary);
  assert.deepEqual(files(observed.canonicalOutputRoot), [{ path: 'probe.bin', bytes: binary }]);
  assert.deepEqual(files(observed.outputRoot), files(observed.canonicalOutputRoot));
  assert.equal(fs.lstatSync(observed.link).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(observed.canonicalOutputRoot).isSymbolicLink(), false);
});

behavior('M09 Run and run share a folded target lock before native rename', async t => {
  const f = fixture(t); f.args.destination = path.join(f.outputRoot, 'Run');
  const protectedBefore = [fingerprint(f.root), fingerprint(f.storeRoot)];
  const folded = E(path.basename(f.args.destination).toLowerCase());
  const lock = path.join(f.outputRoot, `.materialize-${folded}.lock`);
  const writer = await paused(t, f, 'before-rename');
  const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
  assert.deepEqual(Object.keys(o).sort(), ['operation', 'staging', 'stampDigest', 'target']);
  assert.match(o.operation, /^[a-zA-Z0-9-]+$/);
  assert.equal(o.target, 'Run'); assert.equal(o.stampDigest, f.stamp.digest);
  assert.equal(o.staging, `.materialize-${folded}-${o.operation}.stage`);
  assert.equal(folded, E('run'));
  assert.equal(fs.existsSync(path.join(f.outputRoot, `.materialize-${E('Run')}.lock`)), false);
  const stage = path.join(f.outputRoot, o.staging); exactOutput(f, stage);
  assert.equal(fs.existsSync(f.args.destination), false);
  assert.equal(fs.existsSync(path.join(f.outputRoot, 'run')), false);
  const held = fingerprint(f.outputRoot), ownerBefore = fingerprint(lock);
  const loser = await result(child(t, f.dir, { args: { ...f.args, destination: path.join(f.outputRoot, 'run') } }));
  assert.equal(loser.ok, false); assert.match(loser.message, /materialization-busy|destination-busy|target-busy/);
  assert.equal(loser.counts.renames, 0); assert.equal(loser.committed, false);
  assert.deepEqual(fingerprint(lock), ownerBefore); assert.deepEqual(fingerprint(f.outputRoot), held);
  const winner = await writer.release();
  assert.equal(winner.ok, true); assert.equal(winner.committed, true); assert.equal(winner.counts.renames, 1);
  assert.equal(winner.stage, stage); assert.deepEqual(winner.result, f.expectedReceipt); exactOutput(f);
  assert.deepEqual(await f.verify(), { verified: true, findings: [] });
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(stage), false);
  assert.deepEqual(fs.readdirSync(f.outputRoot), ['Run']);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], protectedBefore);
});

behavior('M07 existing case-equivalent destination denies before missing backing on an equivalent host', async t => {
  const f = fixture(t), observed = ownedCaseAlias(f.outputRoot);
  t.diagnostic(`owned destination alias equivalence: ${observed.equivalent}`);
  if (!observed.equivalent) {
    t.skip('host-dependent: owned Run and run are distinct; existing-destination alias equivalence is not qualified');
  } else {
    assert.equal(f.args.destination, observed.alias);
    const missing = clone(f.expectedPlan); missing.stampDigest = '0'.repeat(64);
    assert.equal(fs.existsSync(path.join(f.storeRoot, 'stamps/sha256', missing.stampDigest)), false);
    const before = fingerprint(f.dir); let backingReads = 0;
    await intercept({ openSync: original => (file, ...args) => {
      if (typeof file === 'string' && path.resolve(file).startsWith(f.storeRoot + path.sep)) backingReads++;
      return original(file, ...args);
    }, readFileSync: original => (file, ...args) => {
      if (typeof file === 'string' && path.resolve(file).startsWith(f.storeRoot + path.sep)) backingReads++;
      return original(file, ...args);
    } }, async () => { await refuses(() => sut.materialize({ ...f.args, plan: missing }), /destination-exists/); });
    assert.equal(backingReads, 0);
    assert.deepEqual(files(observed.original), [{ path: 'keep.bin', bytes: binary }]);
    assert.deepEqual(fingerprint(f.dir), before);
  }
});

behavior('M07 safe ancestor alias strictly above outputRoot exports exact content', async t => {
  const f = fixture(t), observed = ownedAncestorAlias(f.dir);
  f.args.outputRoot = observed.outputRoot; f.args.destination = path.join(observed.outputRoot, 'run');
  const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  await exported(f);
  exactOutput(f, path.join(observed.canonicalOutputRoot, 'run'));
  assert.deepEqual(await f.verify(), { verified: true, findings: [] });
  assert.deepEqual(await sut.verifyMaterialization({ destination: path.join(observed.canonicalOutputRoot, 'run'), expectedStampDigest: f.stamp.digest, storeRoot: f.storeRoot }), { verified: true, findings: [] });
  assert.equal(fs.lstatSync(observed.link).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(observed.outputRoot).isSymbolicLink(), false);
  assert.deepEqual(fs.readdirSync(observed.canonicalOutputRoot), ['run']);
  assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
});

test('M12 readiness marker stays absent until the actual worker phase payload is complete', async t => {
  const f = fixture(t, { packaged: true });
  const before = [fingerprint(f.root), fingerprint(f.storeRoot)];
  const control = fs.mkdtempSync(path.join(f.dir, 'marker-gate-'));
  const marker = path.join(control, 'ready.marker'), release = path.join(control, 'worker.release');
  const writeRelease = path.join(control, 'write.release'), signal = path.join(control, 'write-open.json');
  const preload = new URL('./fixtures/issue-20/materialize-marker-preload.mjs', import.meta.url);
  const run = child(t, f.dir, { args: f.args, storeRoot: f.storeRoot, markerGate: { root: control },
    barrier: { phase: 'after-rename', marker, release } }, false, ['--import', preload.href]);
  let ended, failed;
  run.closed.then(r => { ended = r; }, error => { failed = error; });
  const waitFor = async (file, label) => {
    for (const start = Date.now(); !fs.existsSync(file); await delay(10)) {
      if (failed) throw failed;
      if (ended) assert.fail(`child ended before ${label}: ${JSON.stringify(ended)}`);
      assert.ok(Date.now() - start < 20000, `${label} not reached`);
    }
  };
  try {
    await waitFor(signal, 'marker write-open');
    const opened = JSON.parse(fs.readFileSync(signal, 'utf8'));
    assert.equal(path.dirname(opened.target), control);
    const stat = fs.lstatSync(opened.target);
    assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.size, 0, 'actual marker payload target is open before its phase bytes are written');
    assert.equal(fs.existsSync(marker), false, 'final readiness marker must be absent while phase payload write is held');

    fs.writeFileSync(writeRelease, 'release');
    await waitFor(marker, 'after-rename');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'after-rename');
    const owner = checkOwner(f), stage = path.join(f.outputRoot, owner.staging);
    exactOutput(f);
    fs.writeFileSync(release, 'release');
    const r = await result(run);
    assert.equal(r.ok, true); assert.equal(r.committed, true); assert.equal(r.counts.renames, 1);
    assert.deepEqual(r.phases, ['before-rename', 'after-rename']);
    assert.equal(r.stage, stage); assert.deepEqual(r.result, f.expectedReceipt);
    assert.deepEqual(fs.readdirSync(control).sort(cmp), ['ready.marker', 'worker.release', 'write-open.json', 'write.release'].sort(cmp));
    exactOutput(f);
    assert.deepEqual(await f.verify(), { verified: true, findings: [] });
    assert.equal(fs.existsSync(lockPath(f)), false); assert.equal(fs.existsSync(stage), false);
    assert.deepEqual(fs.readdirSync(f.outputRoot), ['run']);
    assert.deepEqual([fingerprint(f.root), fingerprint(f.storeRoot)], before);
  } finally {
    try {
      fs.writeFileSync(writeRelease, 'release'); fs.writeFileSync(release, 'release');
    } finally {
      try {
        if (run.c.exitCode === null && run.c.signalCode === null) run.c.kill('SIGKILL');
        await run.closed.catch(() => {});
      } finally { fs.rmSync(control, { recursive: true, force: true }); }
    }
  }
});
