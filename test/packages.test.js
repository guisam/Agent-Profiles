import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs, { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { parseAllDocuments, stringify } from 'yaml';
import { skillMetadata } from '../src/resolve.js';

// P2 provisional seam, to be frozen by parent RED assessment; no production stub.
// parseManifest(Buffer) -> the strict manifest as a plain object.
// validateMembers([{path,type:'file'|'directory'|'symlink'|'junction'|'pipe'|'socket'|'device',nlink}])
//   -> throws for nonportable membership; empty directories may be supplied.
// readPackage({root, approvedRoot?}) -> {manifest, files:[{path,bytes:Buffer}], sha256}.
//   approvedRoot is an existing approval boundary; a linked child root is rejected.
// hashTree(files, domain='agent-profiles/package-tree/v1') -> lowercase digest.
// canonicalJSON(value) -> Buffer containing J; hashRecord(domain,value) -> digest.
// parseRecord(Buffer) -> strict JSON value (duplicate keys rejected at every depth).
// Record-specific unknown-field schemas belong to their later lock/stamp packages.
const moduleUrl = new URL('../src/packages.js', import.meta.url);
let sut;
let missing;
try { sut = await import(moduleUrl.href); }
catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || existsSync(moduleUrl)) throw error;
  missing = error;
}
const blocked = missing ? 'BLOCKED: src/packages.js absent; behavioral assertions did not execute' : false;
const behavior = (name, fn) => test(name, { skip: blocked }, fn);

test('P2 production seam exists with the seven provisional exports', () => {
  assert.ok(sut, `Missing intended src/packages.js (${missing?.code}); not behavioral evidence`);
  for (const name of ['parseManifest', 'validateMembers', 'readPackage', 'hashTree', 'canonicalJSON', 'hashRecord', 'parseRecord']) {
    assert.equal(typeof sut[name], 'function', `src/packages.js export ${name}`);
  }
});

const DOMAIN = 'agent-profiles/package-tree/v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
const sortFiles = files => [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
// Independent test oracle: no imports from future production hash/encoder code.
function treeFrame(files, domain = DOMAIN) {
  return Buffer.concat([Buffer.from(domain), Buffer.from([0]), u64(files.length),
    ...sortFiles(files).flatMap(f => [Buffer.from([0x46]), u64(Buffer.byteLength(f.path)), Buffer.from(f.path), u64(f.bytes.length), f.bytes])]);
}
const file = (name, content) => ({ path: name, bytes: bytes(content) });
const manifest = (type = 'skill') => ({
  schema_version: 1,
  package: { name: '@example/security-review', version: '1.0.0', type },
  entrypoint: type === 'skill' ? 'SKILL.md' : 'instructions/role.md',
  behavior: { delivery: 'instruction', hosts: [], effects: [] },
});
const skill = Buffer.from('---\nname: Review\ndescription: Useful review.\n---\nBODY\n');
function members(m = manifest(), body = m.package.type === 'skill' ? skill : Buffer.from('# Role\n')) {
  return [file('package.yaml', stringify(m)), file(m.entrypoint, body),
    file('.hidden', 'hidden\n'), file('.ignore', '*.bin\nresources/\n'),
    file('resources/asset.bin', Buffer.from([0, 255, 128, 13, 10])),
    file('resources/empty', ''), file('resources/support.txt', 'support\r\n')];
}
function fixture(t, files = members()) {
  const root = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'issue-20-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const f of files) {
    const target = path.join(root, f.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
  mkdirSync(path.join(root, 'empty-directory'));
  return realpathSync(root);
}
function diskFiles(root, relative = '') {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(entry => {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    const stat = lstatSync(path.join(root, name));
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? diskFiles(root, name) : [file(name, readFileSync(path.join(root, name)))];
  });
}
function rejected(fn, tokens) {
  assert.throws(fn, error => {
    assert.ok(error instanceof Error, 'error must be diagnostic');
    for (const token of tokens) assert.match(error.message, token);
    return true;
  });
}
function checkPackage(actual, expected, m) {
  assert.deepEqual(actual.manifest, m);
  assert.deepEqual(actual.files, sortFiles(expected), 'complete nonempty raw-byte member set, not entrypoint-only');
  assert.equal(actual.sha256, sha(treeFrame(expected)));
}

const treeVectors = [
  { name: 'empty tree', files: [], digest: 'c71fc9b6b9f9a136716177698f03033fb4d72718b67b494a67adc7e6c77795f2' },
  { name: 'zero-byte member', files: [file('empty', '')], digest: '62b67c9d727c43a0780ea48953cbaf5aefc0d6aebb23de26d647717d0d4e9a74' },
  { name: 'binary and unsigned path order', files: [file('z.bin', Buffer.from([0, 255, 13, 10])), file('A.md', 'A\r\n'), file('a/file.txt', 'LF\n')], digest: 'eb0134fc240b4db7d31207a04d9786f661e98c07bc88c66a0e11c4fb6aa65389' },
];
const recordValue = { é: { a: 2, Z: 1 }, z: 'é/😀\n\0"\\', a: [null, true, false, 0, Number.MAX_SAFE_INTEGER] };
// Fixed bytes and digests computed independently with Python struct/sha256, not J/SUT.
const recordBytes = Buffer.from('7b2261223a5b6e756c6c2c747275652c66616c73652c302c393030373139393235343734303939315d2c227a223a22c3a92ff09f98805c75303030615c75303030305c225c5c222c22c3a9223a7b225a223a312c2261223a327d7d', 'hex');
const recordVectors = [
  ['agent-profiles/config/v2', 'fa66b71c6652919001b0cfe15c447814420c528e014e0c7cb778c3754525f6e0'],
  ['agent-profiles/lock/v1', '453b66ddb6375c80039549e93eaab699a68d3369118ce9d992d8603d76830041'],
  ['agent-profiles/stamp/v1', '0895275b6543f0f3c1212f0a3085560a8b30ffcf4d28426ef6c0bc5b66e5c07b'],
  ['agent-profiles/materialization-plan/v1', '7fac8b9108ef337f664efbb2e66138b05a840de8133073333c73a0ea53eeebd7'],
];
for (const v of treeVectors) {
  test(`oracle tree golden: ${v.name}`, () => assert.equal(sha(treeFrame(v.files)), v.digest));
  behavior(`C03 tree hash golden: ${v.name}`, () => {
    assert.equal(sut.hashTree(v.files), v.digest);
    assert.equal(sut.hashTree([...v.files].reverse()), v.digest);
  });
}
test('oracle canonical record bytes and four domain goldens are independent', () => {
  assert.deepEqual(JSON.parse(recordBytes.toString('utf8')), recordValue);
  for (const [domain, digest] of recordVectors) {
    assert.equal(sha(Buffer.concat([Buffer.from(domain), Buffer.from([0]), u64(recordBytes.length), recordBytes])), digest);
  }
  assert.equal(recordBytes.at(-1), 0x7d);
  assert.ok(recordBytes.includes(Buffer.from('\\u000a\\u0000')));
});
test('oracle fixtures have valid YAML and existing skill metadata with complete bytes', t => {
  for (const type of ['skill', 'instruction']) {
    const m = manifest(type);
    const files = members(m);
    const root = fixture(t, files);
    const docs = parseAllDocuments(files[0].bytes.toString('utf8'));
    assert.equal(docs.length, 1);
    assert.deepEqual(docs[0].errors, []);
    assert.deepEqual(docs[0].warnings, []);
    assert.deepEqual(docs[0].toJS(), m);
    assert.deepEqual(sortFiles(diskFiles(root)), sortFiles(files));
    if (type === 'skill') assert.equal(skillMetadata(path.join(root, m.entrypoint), 'fixture').description, 'Useful review.');
    assert.ok(files.some(f => f.path === '.hidden'));
    assert.ok(files.some(f => f.bytes.includes(255)));
  }
});
test('oracle byte mutation, framing, path order and CRLF controls distinguish trees', () => {
  const baseline = members();
  for (const f of baseline) {
    const changed = baseline.map(item => item === f ? file(item.path, Buffer.concat([item.bytes, Buffer.from([1])])) : item);
    assert.notEqual(sha(treeFrame(changed)), sha(treeFrame(baseline)), f.path);
  }
  assert.notDeepEqual(treeFrame([file('a', 'bc')]), treeFrame([file('ab', 'c')]));
  assert.notEqual(sha(treeFrame([file('a', 'bc')])), sha(treeFrame([file('ab', 'c')])));
  assert.notEqual(sha(treeFrame([file('a', 'line\n')])), sha(treeFrame([file('a', 'line\r\n')])));
  assert.deepEqual(sortFiles([file('a', ''), file('_', ''), file('Z', ''), file('.h', '')]).map(f => f.path), ['.h', 'Z', '_', 'a']);
});

for (const type of ['skill', 'instruction']) {
  behavior(`C01 ${type} manifest parses exact structured fields`, t => {
    const m = manifest(type);
    m.package.description = 'Review changes.';
    m.package.license = 'Apache-2.0';
    assert.deepEqual(sut.parseManifest(Buffer.from(stringify(m))), m);
    checkPackage(sut.readPackage({ root: fixture(t, members(m)) }), members(m), m);
  });
}
for (const version of ['0.0.0', '1.2.3', '9007199254740991.0.9007199254740991']) {
  behavior(`C01 exact safe version accepted: ${version}`, () => {
    const m = manifest(); m.package.version = version;
    assert.equal(sut.parseManifest(Buffer.from(stringify(m))).package.version, version);
  });
}
const badFields = [
  ['package.name', '@Bad/review'], ['package.name', '@team/Bad'], ['package.name', 'team/review'],
  ['package.name', '@team/review/extra'], ['package.name', '@team/_review'], ['package.name', '@team/'],
  ...['1', '01.0.0', '1.02.3', '1.2.03', '^1.0.0', 'latest', '1.0.0-beta', '1.0.0+build', '9007199254740992.0.0', '1.0.0\n', ' 1.0.0', '-1.0.0', '1.0.0.0'].map(v => ['package.version', v]),
  ['package.version', 1], ['package.version', null], ['schema_version', 2], ['schema_version', '1'],
  ['package.type', 'plugin'], ['package.type', 1], ['package.description', ''], ['package.description', 3],
  ['package.license', ' '], ['package.license', false], ['entrypoint', 3],
  ['behavior.delivery', 'execute'], ['behavior.hosts', 'claude'], ['behavior.effects', null],
  ['behavior.effects', ['unknown']], ['behavior.effects', ['commands', 'commands']],
  ['behavior.hosts', ['unknown-host']], ['behavior.hosts', ['claude', 'claude']],
];
for (const [field, value] of badFields) {
  behavior(`C01 strict field rejection: ${field} = ${JSON.stringify(value)}`, () => {
    const m = manifest(); const keys = field.split('.');
    (keys.length === 1 ? m : m[keys[0]])[keys.at(-1)] = value;
    rejected(() => sut.parseManifest(Buffer.from(stringify(m))), [new RegExp(field.replaceAll('.', '\\.'))]);
  });
}
for (const field of ['schema_version', 'package', 'entrypoint', 'behavior', 'package.name', 'package.version', 'package.type', 'behavior.delivery', 'behavior.hosts', 'behavior.effects']) {
  behavior(`C01 required field: ${field}`, () => {
    const m = manifest(); const keys = field.split('.'); delete (keys.length === 1 ? m : m[keys[0]])[keys.at(-1)];
    rejected(() => sut.parseManifest(Buffer.from(stringify(m))), [new RegExp(field.replaceAll('.', '\\.')), /required|missing/]);
  });
}
for (const field of ['install', 'scripts', 'hooks', 'dependencies', 'package.extra', 'behavior.extra']) {
  behavior(`C01 unknown or lifecycle field: ${field}`, () => {
    const m = manifest(); const keys = field.split('.');
    (keys.length === 1 ? m : m[keys[0]])[keys.at(-1)] = 'never execute';
    rejected(() => sut.parseManifest(Buffer.from(stringify(m))), [new RegExp(field.replaceAll('.', '\\.')), /unknown|unsupported/]);
  });
}
const yamlBase = stringify(manifest());
const yamlCases = [
  ['duplicate top key', yamlBase + 'schema_version: 1\n', /schema_version/],
  ['duplicate package key', yamlBase.replace('  version:', '  name: "@example/security-review"\n  version:'), /name/],
  ['duplicate behavior key', yamlBase.replace('  effects:', '  delivery: instruction\n  effects:'), /delivery/],
  ['anchor', yamlBase.replace('  type: skill', '  type: skill\n  description: &d Useful.'), /anchor/],
  ['alias', yamlBase.replace('  type: skill', '  type: skill\n  description: &d Useful.\n  license: *d'), /alias|anchor/],
  ['merge', yamlBase.replace('  type: skill', '  type: skill\n  <<: {description: Useful.}'), /merge|<</],
  ['custom tag', yamlBase.replace('  type: skill', '  type: !custom skill'), /tag|warning/],
  ['multiple documents', yamlBase + '---\n' + yamlBase, /document/],
  ['YAML warning', '%YAML 1.3\n---\n' + yamlBase, /warning|version|YAML/],
];
for (const [name, raw, diagnostic] of yamlCases) {
  behavior(`C01 strict YAML rejects ${name}`, () => rejected(() => sut.parseManifest(Buffer.from(raw)), [diagnostic]));
}
test('oracle duplicate, tag, multidocument and warning YAML controls reach parser diagnostics', () => {
  for (const [name, raw] of yamlCases.filter(c => /duplicate|tag|documents|warning/.test(c[0]))) {
    const docs = parseAllDocuments(raw);
    assert.ok(docs.length !== 1 || docs.some(d => d.errors.length || d.warnings.length), name);
  }
});

behavior('C02 native delivery requires skill type and supported nonempty hosts', () => {
  const m = manifest(); m.behavior = { delivery: 'native', hosts: ['claude', 'codex', 'hermes'], effects: [] };
  assert.deepEqual(sut.parseManifest(Buffer.from(stringify(m))), m);
  const wrongType = structuredClone(m); wrongType.package.type = 'instruction';
  rejected(() => sut.parseManifest(Buffer.from(stringify(wrongType))), [/package\.type|behavior\.delivery/, /native|skill/]);
  const noHost = structuredClone(m); noHost.behavior.hosts = [];
  rejected(() => sut.parseManifest(Buffer.from(stringify(noHost))), [/behavior\.hosts/, /nonempty|required/]);
  const injected = manifest(); injected.behavior.hosts = ['claude'];
  rejected(() => sut.parseManifest(Buffer.from(stringify(injected))), [/behavior\.hosts/, /instruction|empty/]);
});
behavior('C02 declared native effects and supporting executable bytes stay inert', t => {
  const m = manifest(); m.behavior = { delivery: 'native', hosts: ['claude'], effects: ['commands', 'substitution', 'external-references', 'host-configuration'] };
  const body = Buffer.from('---\ndescription: Useful.\nhooks: {}\n---\n!`echo NO`\n$ARGUMENTS ${name}\n@outside.md\n');
  const root = fixture(t, members(m, body));
  const sentinel = path.join(root, 'EXECUTED');
  const resources = [file('hooks/run.js', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'BAD');`), file('.claude-plugin/plugin.json', '{}'), file('.mcp.json', '{}')];
  for (const f of resources) { mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true }); writeFileSync(path.join(root, f.path), f.bytes); }
  let dispatches = 0;
  const saved = [];
  for (const [object, keys] of [[childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']], [http, ['request', 'get']], [https, ['request', 'get']], [globalThis, ['fetch']]]) {
    for (const key of keys) { saved.push([object, key, object[key]]); object[key] = () => { dispatches++; throw new Error('Forbidden package dispatch'); }; }
  }
  syncBuiltinESMExports();
  try {
    const before = sortFiles(diskFiles(root));
    checkPackage(sut.readPackage({ root }), before, m);
    assert.equal(dispatches, 0);
    assert.equal(existsSync(sentinel), false);
    assert.deepEqual(sortFiles(diskFiles(root)), before);
  } finally {
    for (const [object, key, original] of saved) object[key] = original;
    syncBuiltinESMExports();
  }
});
const nativeSignals = [
  ['commands', '!`echo NO`'], ['commands', '```!shell\necho NO\n```'],
  ['substitution', '$ARGUMENTS'], ['substitution', '${a_1.foo}'],
  ['external-references', '@outside/file.md rest'],
  ...['hooks', 'allowed-tools', 'model', 'effort', 'context', 'agent'].map(k => ['host-configuration', 'BODY', `${k}: value\n`]),
];
for (const [effect, body, extra = ''] of nativeSignals) {
  behavior(`C02 native undeclared signal: ${effect} ${JSON.stringify(extra || body)}`, t => {
    const m = manifest(); m.behavior.delivery = 'native'; m.behavior.hosts = ['claude'];
    // Put body past the metadata boundary: body lint must not stop at 64 KiB.
    const entry = Buffer.from(`---\ndescription: Useful.\n${extra}---\n${'p'.repeat(65536)}\n${body}\n`);
    const root = fixture(t, members(m, entry));
    rejected(() => sut.readPackage({ root }), [new RegExp(effect), /SKILL\.md/]);
    m.behavior.effects = [effect]; writeFileSync(path.join(root, 'package.yaml'), stringify(m));
    checkPackage(sut.readPackage({ root }), members(m, entry), m);
  });
}
for (const resource of ['hooks/data.bin', '.claude-plugin/plugin.json', '.mcp.json']) {
  behavior(`C02 native tree declaration required: ${resource}`, t => {
    const m = manifest(); m.behavior.delivery = 'native'; m.behavior.hosts = ['claude'];
    const files = [...members(m), file(resource, '{}')]; const root = fixture(t, files);
    rejected(() => sut.readPackage({ root }), [/host-configuration/, /SKILL\.md/, new RegExp(resource.replaceAll('.', '\\.'))]);
    m.behavior.effects = ['host-configuration']; writeFileSync(path.join(root, 'package.yaml'), stringify(m));
    checkPackage(sut.readPackage({ root }), [...members(m), file(resource, '{}')], m);
  });
}
behavior('C02 instruction syntax stays literal without inferred native effects', t => {
  const m = manifest('instruction'); const entry = Buffer.from('!`echo NO`\n```!\n$ARGUMENTS ${a}\n@outside.md\n');
  checkPackage(sut.readPackage({ root: fixture(t, members(m, entry)) }), members(m, entry), m);
});
behavior('C02 native recognizers are literal and do not widen to near misses', t => {
  const m = manifest(); m.behavior.delivery = 'native'; m.behavior.hosts = ['claude'];
  const entry = Buffer.concat([skill, Buffer.from('! `echo`\n ```!\n${} ${a-b} $arguments\n @outside.md\n')]);
  checkPackage(sut.readPackage({ root: fixture(t, members(m, entry)) }), members(m, entry), m);
});

behavior('C03 full tree includes manifest hidden binary empty and support resources at distinct roots', t => {
  const files = members(); const first = fixture(t, files); const second = fixture(t, [...files].reverse());
  const a = sut.readPackage({ root: first }); const b = sut.readPackage({ root: second });
  checkPackage(a, files, manifest()); checkPackage(b, files, manifest()); assert.equal(a.sha256, b.sha256);
});
for (const member of members().map(f => f.path)) {
  behavior(`C03 raw member mutation changes hash: ${member}`, t => {
    const files = members(); const root = fixture(t, files); const before = sut.readPackage({ root });
    const original = files.find(f => f.path === member);
    const append = member === 'package.yaml' ? Buffer.from('# comment only\n') : Buffer.from([0x21]);
    const changed = files.map(f => f === original ? file(member, Buffer.concat([f.bytes, append])) : f);
    writeFileSync(path.join(root, member), changed.find(f => f.path === member).bytes);
    const after = sut.readPackage({ root }); checkPackage(after, changed, manifest());
    assert.notEqual(after.sha256, before.sha256);
  });
}
behavior('C03 resource addition removal rename and manifest identity are hashed', t => {
  const files = members(); const initial = sut.readPackage({ root: fixture(t, files) }).sha256;
  for (const changed of [[...files, file('extra.bin', '')], files.filter(f => f.path !== 'resources/empty'), files.map(f => f.path === 'resources/support.txt' ? file('resources/renamed.txt', f.bytes) : f)]) {
    const actual = sut.readPackage({ root: fixture(t, changed) }); checkPackage(actual, changed, manifest()); assert.notEqual(actual.sha256, initial);
  }
  const m = manifest(); m.package.version = '2.0.0';
  const other = sut.readPackage({ root: fixture(t, members(m)) }); checkPackage(other, members(m), m); assert.notEqual(other.sha256, initial);
});
behavior('C03 CRLF LF BOM and trailing blanks retain distinct raw identity', t => {
  const bodies = [skill, Buffer.from(skill.toString().replaceAll('\n', '\r\n')), Buffer.concat([Buffer.from([239, 187, 191]), skill]), Buffer.concat([skill, Buffer.from('\n\n')])];
  const digests = bodies.map(body => {
    const files = members(manifest(), body); const result = sut.readPackage({ root: fixture(t, files) }); checkPackage(result, files, manifest()); return result.sha256;
  });
  assert.equal(new Set(digests).size, bodies.length);
});
behavior('C03 explicit framing path-content splits and domain cannot alias', () => {
  assert.notEqual(sut.hashTree([file('a', 'bc')]), sut.hashTree([file('ab', 'c')]));
  assert.notEqual(sut.hashTree([file('a', ''), file('bc', '')]), sut.hashTree([file('ab', ''), file('c', '')]));
  const files = treeVectors[2].files;
  assert.equal(sut.hashTree(files, 'agent-profiles/materialized-tree/v1'), sha(treeFrame(files, 'agent-profiles/materialized-tree/v1')));
  assert.notEqual(sut.hashTree(files), sut.hashTree(files, 'agent-profiles/materialized-tree/v1'));
});
behavior('C03 canonical JSON fixed Unicode control and key-order bytes', () => {
  assert.deepEqual(sut.canonicalJSON(recordValue), recordBytes);
  assert.deepEqual(sut.canonicalJSON({ a: recordValue.a, z: recordValue.z, é: { Z: 1, a: 2 } }), recordBytes);
  assert.notDeepEqual(sut.canonicalJSON([1, 2]), sut.canonicalJSON([2, 1]));
  assert.notDeepEqual(sut.canonicalJSON('é'), sut.canonicalJSON('e\u0301'));
  assert.deepEqual(sut.canonicalJSON({ '\uE000': 1, '😀': 2 }), Buffer.from('{"\uE000":1,"😀":2}'));
});
for (const [domain, digest] of recordVectors) {
  behavior(`C03 record hash golden: ${domain}`, () => assert.equal(sut.hashRecord(domain, recordValue), digest));
}
for (const [name, value] of [['negative zero', -0], ['float', 1.5], ['unsafe integer', 9007199254740992], ['NaN', NaN], ['infinity', Infinity], ['unpaired high surrogate', '\uD800'], ['unpaired low surrogate key', { '\uDC00': 1 }], ['undefined', undefined], ['bigint', 1n], ['Date', new Date(0)], ['nested float', { a: [1.5] }]]) {
  behavior(`C03 canonical encoder rejects ${name}`, () => assert.throws(() => sut.canonicalJSON(value)));
}
for (const [name, raw] of [['duplicate key', '{"a":1,"a":2}'], ['nested duplicate key', '{"a":{"b":1,"b":2}}'], ['escaped duplicate key', '{"a":1,"\\u0061":2}'], ['trailing bytes', '{} {}'], ['JSON BOM', '\uFEFF{}'], ['float', '{"a":1.5}'], ['negative zero', '{"a":-0}'], ['surrogate', '{"a":"\\ud800"}']]) {
  behavior(`C03 strict record parser rejects ${name}`, () => assert.throws(() => sut.parseRecord(Buffer.from(raw))));
}
behavior('C03 strict record parser accepts the independent canonical bytes', () => assert.deepEqual(sut.parseRecord(recordBytes), recordValue));

const unsafePaths = ['', '.', '..', './a', '../a', 'a/../b', 'a//b', 'a/', '/a', '//server/share', 'C:/a', 'C:a', 'a\\b', 'a:b', 'a\u0000b', 'a\nb', 'é.md', 'a.', 'dir./a', 'con', 'CON.txt', 'nul.md', 'PrN.data', 'AUX', 'COM1.txt', 'com9', 'LPT1', 'lpt9.md', '.git/config', 'a/.git/file', 'has space.md'];
for (const name of unsafePaths) {
  behavior(`C04 unsafe member path rejected without repair: ${JSON.stringify(name)}`, () => {
    rejected(() => sut.validateMembers([{ path: name, type: 'file', nlink: 1 }]), [/path|member|portable|component|reserved|\.git|collision/]);
  });
}
for (const names of [['A.txt', 'a.txt'], ['Dir/a', 'dir/b'], ['a', 'a/b'], ['a', 'A/b'], ['same', 'same']]) {
  behavior(`C04 case duplicate or prefix collision: ${names.join(' | ')}`, () => rejected(() => sut.validateMembers(names.map(name => ({ path: name, type: 'file', nlink: 1 }))), [/collision|duplicate|prefix/]));
}
for (const type of ['symlink', 'junction', 'pipe', 'socket', 'device']) {
  behavior(`C04 special member descriptor rejects ${type}`, () => rejected(() => sut.validateMembers([{ path: 'resource', type, nlink: 1 }]), [new RegExp(`${type}|link|regular|type`)]));
}
behavior('C04 hard-linked regular descriptor rejects', () => rejected(() => sut.validateMembers([{ path: 'resource', type: 'file', nlink: 2 }]), [/hard.?link|nlink/]));
behavior('C04 portable nested paths and empty directories accepted', t => {
  const files = [...members(), file('UPPER/X.md', 'x'), file('lower/y.md', 'y')];
  sut.validateMembers([...files.map(f => ({ path: f.path, type: 'file', nlink: 1 })), { path: 'empty-directory', type: 'directory', nlink: 1 }]);
  checkPackage(sut.readPackage({ root: fixture(t, files) }), files, manifest());
});
for (const [name, alter, diagnostic] of [
  ['missing', (root, m) => rmSync(path.join(root, m.entrypoint)), /entrypoint|SKILL\.md/],
  ['directory', (root, m) => { rmSync(path.join(root, m.entrypoint)); mkdirSync(path.join(root, m.entrypoint)); }, /regular|file|entrypoint/],
  ['non Markdown', (root, m) => { m.entrypoint = 'resources/support.txt'; writeFileSync(path.join(root, 'package.yaml'), stringify(m)); }, /entrypoint|Markdown|\.md/],
  ['skill description absent', (root, m) => writeFileSync(path.join(root, m.entrypoint), '---\nname: Review\n---\nBODY'), /description/],
  ['skill frontmatter over bound', (root, m) => writeFileSync(path.join(root, m.entrypoint), '---\ndescription: ' + 'x'.repeat(65536) + '\n---\n'), /64 KiB|frontmatter/],
]) {
  behavior(`C02 entrypoint rejects ${name}`, t => { const m = manifest(); const root = fixture(t); alter(root, m); rejected(() => sut.readPackage({ root }), [diagnostic]); });
}
for (const member of ['package.yaml', 'SKILL.md']) {
  for (const bad of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xff]]) {
    behavior(`C04 strict UTF-8 rejects ${member} bytes ${Buffer.from(bad).toString('hex')}`, t => {
      const root = fixture(t); writeFileSync(path.join(root, member), Buffer.concat([readFileSync(path.join(root, member)), Buffer.from(bad)]));
      rejected(() => sut.readPackage({ root }), [new RegExp(member.replaceAll('.', '\\.')), /UTF-8|UTF8|encoding/]);
    });
  }
}
behavior('C04 manifest BOM is allowed retained and hashed', t => {
  const files = members(); files[0] = file('package.yaml', Buffer.concat([Buffer.from([239, 187, 191]), files[0].bytes]));
  checkPackage(sut.readPackage({ root: fixture(t, files) }), files, manifest());
});
behavior('C04 actual git member rejects', t => {
  const root = fixture(t, [...members(), file('.git/config', 'inert')]);
  rejected(() => sut.readPackage({ root }), [/\.git/]);
});
function linkFixture(t) {
  const boundary = fixture(t, []); const root = path.join(boundary, 'package');
  mkdirSync(root);
  for (const f of members()) { mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true }); writeFileSync(path.join(root, f.path), f.bytes); }
  const outside = path.join(boundary, 'outside'); mkdirSync(outside); writeFileSync(path.join(outside, 'secret'), 'UNTOUCHED');
  symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  return { boundary, root, outside };
}
test('oracle native junction and hardlink fixtures are real disposable links', t => {
  const f = linkFixture(t);
  assert.ok(lstatSync(path.join(f.root, 'linked')).isSymbolicLink());
  linkSync(path.join(f.root, 'resources/asset.bin'), path.join(f.root, 'hard.bin'));
  assert.ok(lstatSync(path.join(f.root, 'hard.bin')).nlink > 1);
  assert.equal(readFileSync(path.join(f.outside, 'secret'), 'utf8'), 'UNTOUCHED');
});
behavior('C04 actual linked descendant refuses without outside mutation', t => {
  const f = linkFixture(t);
  let outsideReads = 0;
  const saved = ['openSync', 'readFileSync'].map(key => [key, fs[key]]);
  for (const [key, original] of saved) fs[key] = (target, ...args) => {
    if (typeof target !== 'number') {
      const resolved = realpathSync(target);
      if (resolved === f.outside || resolved.startsWith(f.outside + path.sep)) {
        outsideReads++;
        throw new Error('outside read attempted');
      }
    }
    return original(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    rejected(() => sut.readPackage({ root: f.root, approvedRoot: f.boundary }), [/linked/, /link|junction|reparse/]);
    assert.equal(outsideReads, 0, 'must reject before opening outside bytes');
  } finally {
    for (const [key, original] of saved) fs[key] = original;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(path.join(f.outside, 'secret'), 'utf8'), 'UNTOUCHED');
});
behavior('C04 actual hardlink refuses instead of hashing two aliases', t => {
  const root = fixture(t); linkSync(path.join(root, 'resources/asset.bin'), path.join(root, 'hard.bin'));
  rejected(() => sut.readPackage({ root }), [/hard\.bin|asset\.bin/, /hard.?link|nlink/]);
});
behavior('C04 linked package root below approval boundary refuses', t => {
  const boundary = fixture(t, []); const root = fixture(t); const alias = path.join(boundary, 'alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  rejected(() => sut.readPackage({ root: alias, approvedRoot: boundary }), [/root|alias/, /link|junction|reparse/]);
});
behavior('C04 ancestor alias above explicitly approved canonical root is allowed', t => {
  const root = fixture(t); const boundary = fixture(t, []); const alias = path.join(boundary, 'ancestor');
  symlinkSync(path.dirname(root), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const throughAncestor = path.join(alias, path.basename(root));
  assert.equal(realpathSync(throughAncestor), root);
  checkPackage(sut.readPackage({ root: throughAncestor }), members(), manifest());
});

for (const hosts of [[], ['unknown-host'], ['claude', 'claude'], [1]]) {
  behavior(`C02 native hosts reject exact list: ${JSON.stringify(hosts)}`, () => {
    const m = manifest(); m.behavior.delivery = 'native'; m.behavior.hosts = hosts;
    rejected(() => sut.parseManifest(Buffer.from(stringify(m))), [/behavior\.hosts/]);
  });
}
for (const [field, value] of [['schema_version', true], ['package', []], ['behavior', []], ['package.name', 1], ['package.type', false], ['entrypoint', null], ['behavior.delivery', true], ['behavior.effects', [1]]]) {
  behavior(`C01 exact type rejection: ${field} = ${JSON.stringify(value)}`, () => {
    const m = manifest(); const keys = field.split('.');
    (keys.length === 1 ? m : m[keys[0]])[keys.at(-1)] = value;
    rejected(() => sut.parseManifest(Buffer.from(stringify(m))), [new RegExp(field.replaceAll('.', '\\.'))]);
  });
}
for (const entrypoint of ['../outside.md', '/outside.md', 'C:/outside.md', 'dir\\outside.md', 'dir//file.md', 'CON.md', 'é.md']) {
  behavior(`C02 nonportable entrypoint rejects: ${JSON.stringify(entrypoint)}`, () => {
    const m = manifest(); m.entrypoint = entrypoint;
    rejected(() => sut.parseManifest(Buffer.from(stringify(m))), [/entrypoint/]);
  });
}
behavior('C02 missing manifest rejects before accepting an entrypoint-only package', t => {
  const root = fixture(t); rmSync(path.join(root, 'package.yaml'));
  rejected(() => sut.readPackage({ root }), [/package\.yaml/, /missing|ENOENT|required/]);
});
behavior('C04 instruction entrypoint also requires strict UTF-8', t => {
  const m = manifest('instruction'); const root = fixture(t, members(m, Buffer.from([0xff])));
  rejected(() => sut.readPackage({ root }), [/instructions\/role\.md/, /UTF-8|UTF8|encoding/]);
});
behavior('C03 timestamps do not affect package identity', t => {
  const root = fixture(t); const before = sut.readPackage({ root });
  for (const f of members()) utimesSync(path.join(root, f.path), new Date(0), new Date(1000));
  const after = sut.readPackage({ root }); checkPackage(after, members(), manifest()); assert.equal(after.sha256, before.sha256);
});
behavior('C03 canonical encoder escapes every ASCII control with lowercase u00xx', () => {
  const value = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).join('');
  const expected = Buffer.from('"' + Array.from({ length: 32 }, (_, i) => '\\u00' + i.toString(16).padStart(2, '0')).join('') + '"');
  assert.deepEqual(sut.canonicalJSON(value), expected);
  assert.deepEqual(sut.canonicalJSON({}), Buffer.from('{}'));
  assert.deepEqual(sut.canonicalJSON([]), Buffer.from('[]'));
  assert.deepEqual(sut.canonicalJSON(null), Buffer.from('null'));
  assert.throws(() => sut.canonicalJSON(Buffer.from([0, 255])), 'binary buffers are not plain JSON records');
});
test('oracle native signal fixtures have valid bounded metadata and complete long body', () => {
  for (const [effect, body, extra = ''] of nativeSignals) {
    const entry = Buffer.from(`---\ndescription: Useful.\n${extra}---\n${'p'.repeat(65536)}\n${body}\n`);
    assert.equal(skillMetadata('unused', 'fixture', entry, 'SKILL.md').description, 'Useful.', effect);
    assert.ok(entry.lastIndexOf(Buffer.from(body)) >= 65536);
  }
});
test('oracle invalid UTF-8 is genuinely invalid and BOM entrypoints remain readable', () => {
  for (const raw of [[0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xff]]) {
    assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(raw)));
  }
  const entry = Buffer.concat([Buffer.from([239, 187, 191]), skill]);
  assert.equal(skillMetadata('unused', 'fixture', entry, 'SKILL.md').description, 'Useful review.');
});
