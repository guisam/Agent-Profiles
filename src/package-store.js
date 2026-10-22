import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJSON, hashRecord, hashTree, parseManifest, parseRecord, readPackage, validateMembers } from './packages.js';

const digestPattern = /^[0-9a-f]{64}$/;

export function encodeComponent(value) {
  // The canonical encoder also rejects unpaired UTF-16 surrogates.
  canonicalJSON(value);
  if (typeof value !== 'string') throw new Error('component: expected a string');
  return `x-${Buffer.from(value).toString('hex')}`;
}

export function decodeComponent(value) {
  if (typeof value !== 'string' || !/^x-(?:[0-9a-f]{2})*$/.test(value)) throw new Error('component: noncanonical encoding');
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value.slice(2), 'hex'));
  if (encodeComponent(decoded) !== value) throw new Error('component: noncanonical encoding');
  return decoded;
}

function localPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}: expected a nonempty local directory`);
  if (/^[\\/]{2}|^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    throw new Error(`${label}: unsupported-filesystem: nonlocal path`);
  }
  const resolved = path.resolve(value);
  if (/^[\\/]{2}/.test(resolved)) throw new Error(`${label}: unsupported-filesystem: nonlocal path`);
  return resolved;
}

function statOrNull(target) {
  try { return lstatSync(target, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function directory(target) {
  const stat = lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink()) throw new Error(`${target}: link/junction is forbidden`);
  if (!stat.isDirectory()) throw new Error(`${target}: expected a directory`);
  return stat;
}

function rootPath(value, label, create = false) {
  const selected = localPath(value, label);
  const stat = statOrNull(selected);
  if (stat) {
    directory(selected);
    return localPath(realpathSync(selected), label);
  }
  // Approve the nearest existing canonical ancestor once; never follow a child link.
  const suffix = [];
  let ancestor = selected;
  while (!statOrNull(ancestor)) {
    if (path.dirname(ancestor) === ancestor) throw new Error(`${label}: no existing ancestor directory for ${selected}; check that the filesystem root is available`);
    suffix.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  directory(ancestor);
  let target = localPath(realpathSync(ancestor), label);
  for (const component of suffix) {
    target = path.join(target, component);
    if (create && !statOrNull(target)) {
      try { mkdirSync(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (statOrNull(target)) directory(target);
  }
  return target;
}

function storeRoot(value, create = false) {
  const root = rootPath(storeSelection(value), 'store', create);
  for (const member of ['objects', 'objects/sha256', 'identities', '.staging', '.writer-lock']) safePath(root, member);
  return root;
}

function storeSelection(value) {
  return value === undefined ? process.env.AGENT_PROFILES_STORE ?? path.join(os.homedir(), '.agent-profiles', 'store') : value;
}

function safePath(root, relative) {
  let current = root;
  if (statOrNull(root)) directory(root);
  const components = relative.split('/');
  for (let i = 0; i < components.length; i++) {
    current = path.join(current, components[i]);
    const stat = statOrNull(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`${current}: link/junction is forbidden`);
    if (i < components.length - 1 && !stat.isDirectory()) throw new Error(`${current}: expected directory`);
    if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) throw new Error(`${current}: unsafe store member`);
  }
  return current;
}

function sameStat(a, b) {
  return ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
}

function scan(root) {
  const members = [];
  const rootStat = directory(root);
  function walk(relative = '') {
    const expected = relative ? members.find(member => member.path === relative).stat : rootStat;
    if (!sameStat(expected, directory(path.join(root, relative)))) throw new Error('source/tree directory changed during scan');
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const memberPath = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path.join(root, memberPath), { bigint: true });
      const type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'special';
      const member = { path: memberPath, type, nlink: Number(stat.nlink), stat };
      validateMembers([member]);
      members.push(member);
      if (type === 'directory') walk(memberPath);
    }
  }
  walk();
  validateMembers(members);
  return { rootStat, members };
}

function unchanged(before, after) {
  if (!sameStat(before.rootStat, after.rootStat) || before.members.length !== after.members.length ||
      before.members.some((member, i) => member.path !== after.members[i].path || !sameStat(member.stat, after.members[i].stat))) {
    throw new Error('source/tree changed: membership, metadata or read identity');
  }
}

function readMember(root, member, snapshot) {
  // Recheck every ancestor before opening; O_NOFOLLOW protects the leaf where supported.
  directory(root);
  let current = root;
  for (const component of member.path.split('/').slice(0, -1)) {
    current = path.join(current, component);
    const relative = path.relative(root, current).split(path.sep).join('/');
    const expected = snapshot.members.find(entry => entry.path === relative);
    if (!expected || !sameStat(expected.stat, directory(current))) throw new Error('source/tree directory changed');
  }
  const target = path.join(root, member.path);
  if (!sameStat(snapshot.rootStat, directory(root)) || !sameStat(member.stat, lstatSync(target, { bigint: true }))) throw new Error('source/tree read identity changed');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameStat(member.stat, fstatSync(fd, { bigint: true }))) throw new Error('source/tree open identity changed');
    const bytes = readFileSync(fd);
    if (BigInt(bytes.length) !== member.stat.size || !sameStat(member.stat, fstatSync(fd, { bigint: true })) ||
        !sameStat(member.stat, lstatSync(target, { bigint: true }))) throw new Error('source/tree changed during read');
    return bytes;
  } finally { closeSync(fd); }
}

// A single explicit member uses the same no-follow and read-identity checks as trees.
export function readStoreFile(root, relative) {
  validateMembers([{ path: relative, type: 'file', nlink: 1 }]);
  const target = safePath(root, relative);
  const rootStat = directory(root);
  const members = [];
  const components = relative.split('/');
  for (let i = 1; i < components.length; i++) {
    const memberPath = components.slice(0, i).join('/');
    members.push({ path: memberPath, stat: directory(path.join(root, memberPath)) });
  }
  const stat = lstatSync(target, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error(`${relative}: expected a regular unlinked file`);
  return readMember(root, { path: relative, stat }, { rootStat, members });
}

export { rootPath, storeRoot, safePath, statOrNull, sameStat, writeFlushed, verifyObject, publish, readTree };

function readTree(root, copy = undefined, onFirst = undefined) {
  const snapshot = scan(root);
  const files = [];
  for (const member of snapshot.members.filter(entry => entry.type === 'file')) {
    const bytes = readMember(root, member, snapshot);
    files.push({ path: member.path, bytes });
    if (copy) {
      const destination = path.join(copy, member.path);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFlushed(destination, bytes);
    }
    if (files.length === 1) onFirst?.();
  }
  unchanged(snapshot, scan(root));
  return files;
}

function writeFlushed(target, bytes) {
  const fd = openSync(target, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function identityPath(root, name, version) {
  if (typeof name !== 'string' || !/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('identity: expected @namespace/name');
  if (typeof version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || version.split('.').some(n => !Number.isSafeInteger(Number(n)))) throw new Error('identity: expected exact safe release version');
  const components = name.slice(1).split('/').map(encodeComponent);
  // All supported local backends must accommodate these portable generated components.
  if (components.some(component => Buffer.byteLength(component) > 255)) throw new Error('identity: generated component path-length exceeds backend limit');
  return safePath(root, `identities/${components.join('/')}/${version}.json`);
}

function recordAt(root, target, name, version) {
  if (!statOrNull(target)) return null;
  const relative = path.relative(root, target).split(path.sep).join('/');
  safePath(root, relative);
  const stat = lstatSync(target, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n) throw new Error('identity: expected regular record');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let record;
  try {
    if (!sameStat(stat, fstatSync(fd, { bigint: true }))) throw new Error('identity record changed');
    record = parseRecord(readFileSync(fd));
    if (!sameStat(stat, fstatSync(fd, { bigint: true })) || !sameStat(stat, lstatSync(target, { bigint: true }))) throw new Error('identity record changed');
  } finally { closeSync(fd); }
  if (!record || Object.keys(record).sort().join(',') !== 'identity,sha256' || !record.identity ||
      Object.keys(record.identity).sort().join(',') !== 'name,version' || record.identity.name !== name || record.identity.version !== version ||
      typeof record.sha256 !== 'string' || !digestPattern.test(record.sha256)) throw new Error('identity: corrupt record');
  return record;
}

function verifyObject(root, sha256, identity) {
  const object = safePath(root, `objects/sha256/${sha256}`);
  directory(object);
  if (readdirSync(object).join(',') !== 'tree') throw new Error('object: unexpected membership outside tree');
  const tree = safePath(root, `objects/sha256/${sha256}/tree`);
  const files = readTree(tree);
  if (hashTree(files) !== sha256) throw new Error(`object: digest mismatch ${sha256}`);
  const manifestFile = files.find(file => file.path === 'package.yaml');
  if (!manifestFile) throw new Error('object: package.yaml missing');
  const manifest = parseManifest(manifestFile.bytes);
  if (manifest.package.name !== identity.name || manifest.package.version !== identity.version) throw new Error('object: manifest identity mismatch');
  return files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}

function publish(from, to, rename) {
  if (statOrNull(to)) throw new Error(`${to}: publication target exists`);
  if (lstatSync(from, { bigint: true }).dev !== directory(path.dirname(to)).dev) throw new Error('unsupported-filesystem: staging/final device mismatch');
  try { rename(from, to); }
  catch (error) {
    const category = ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code) ? 'unsupported-filesystem' :
      ['EPERM', 'EACCES'].includes(error.code) ? 'publication-denied' : 'publication failed';
    throw new Error(`${category}: ${error.code ?? 'unknown'}: ${error.message}`, { cause: error });
  }
}

export function lookupPackage({ storeRoot: selected = undefined, name, version }) {
  const root = storeRoot(selected);
  const target = identityPath(root, name, version);
  const record = recordAt(root, target, name, version);
  if (!record) return null;
  return { ...record, files: verifyObject(root, record.sha256, record.identity) };
}

export function importPackage({ sourceDirectory, storeRoot: selected = undefined, expectedDigest = undefined, onPhase = undefined, rename = renameSync }) {
  if (expectedDigest !== undefined && (typeof expectedDigest !== 'string' || !digestPattern.test(expectedDigest))) throw new Error('expected digest: expected 64 lowercase hexadecimal characters');
  const source = rootPath(sourceDirectory, 'source');
  directory(source);
  const destination = rootPath(storeSelection(selected), 'store');
  const inside = (a, b) => { const relative = path.relative(a, b); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); };
  if (inside(source, destination) || inside(destination, source)) throw new Error('source/store overlap is forbidden');
  const root = storeRoot(destination, true);
  const lock = safePath(root, '.writer-lock');
  try { mkdirSync(lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('store-busy: writer lock exists'); throw error; }
  let staging;
  try {
    writeFlushed(path.join(lock, 'owner.json'), canonicalJSON({ pid: process.pid, operation: randomUUID() }));
    for (const relative of ['.staging', 'objects/sha256', 'identities']) mkdirSync(safePath(root, relative), { recursive: true });
    staging = mkdtempSync(path.join(safePath(root, '.staging'), 'package-'));
    const objectStage = path.join(staging, 'object');
    const tree = path.join(objectStage, 'tree');
    mkdirSync(tree, { recursive: true });
    const copied = readTree(source, tree, () => onPhase?.('source-read', { staging }));
    const copiedDigest = hashTree(copied);
    onPhase?.('copied', { staging });
    // P2 reads only our private copy, never the mutable live source.
    const staged = readPackage({ root: tree });
    if (staged.sha256 !== copiedDigest) throw new Error('staged copied bytes: digest mismatch');
    if (expectedDigest !== undefined && staged.sha256 !== expectedDigest) throw new Error(`expected digest mismatch: copied ${staged.sha256}, expected ${expectedDigest}`);
    const identity = { name: staged.manifest.package.name, version: staged.manifest.package.version };
    if (candidateReservation(root, identity)) throw new Error('candidate: planned release identity is reserved and unpublished');
    const target = identityPath(root, identity.name, identity.version);
    const record = recordAt(root, target, identity.name, identity.version);
    if (record) {
      verifyObject(root, record.sha256, identity);
      if (record.sha256 !== staged.sha256) throw new Error(`identity-conflict: ${identity.name}@${identity.version}`);
      return { identity, sha256: staged.sha256, status: 'reused' };
    }
    const object = safePath(root, `objects/sha256/${staged.sha256}`);
    if (statOrNull(object)) verifyObject(root, staged.sha256, identity);
    else publish(objectStage, object, rename);
    onPhase?.('object-published', { staging });
    mkdirSync(path.dirname(target), { recursive: true });
    identityPath(root, identity.name, identity.version);
    const temporary = path.join(staging, 'identity.json');
    writeFlushed(temporary, canonicalJSON({ identity, sha256: staged.sha256 }));
    publish(temporary, target, rename);
    onPhase?.('mapping-committed', { staging });
    lookupPackage({ storeRoot: root, ...identity });
    // A verified orphan gets a new mapping, so it is published rather than reused.
    return { identity, sha256: staged.sha256, status: 'published' };
  } finally {
    try { if (staging) rmSync(staging, { recursive: true, force: true }); }
    finally { rmSync(lock, { recursive: true, force: true }); }
  }
}

// Reservations share the committed candidate index; there is no second mutable label registry.
export function candidateIndex(root, id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(id)) throw new Error('candidate id: expected portable identifier');
  const relative = `candidates/ids/${id}.json`, bytes = readStoreFile(root, relative), index = parseRecord(bytes);
  if (!index || Object.keys(index).sort().join(',') !== 'candidateVersion,content,id,migrationId,release,revisionDigest,stampDigest' ||
      index.candidateVersion !== 1 || index.id !== id || !/^migration-[a-f0-9-]{36}$/.test(index.migrationId) ||
      !digestPattern.test(index.revisionDigest) || !digestPattern.test(index.stampDigest) || !canonicalJSON(index).equals(bytes)) throw new Error('candidate index: corrupt immutable record');
  for (const identity of [index.release, index.content?.identity]) {
    if (!identity || Object.keys(identity).sort().join(',') !== 'name,version') throw new Error('candidate index: invalid identity');
    identityPath(root, identity.name, identity.version);
  }
  if (Object.keys(index.content).sort().join(',') !== 'identity,sha256' || !digestPattern.test(index.content.sha256)) throw new Error('candidate index: invalid content');
  const recordBytes = readStoreFile(root, `revisions/sha256/${index.revisionDigest}.json`), record = parseRecord(recordBytes);
  if (!canonicalJSON(record).equals(recordBytes) || hashRecord('agent-profiles/revision/v2', record) !== index.revisionDigest) throw new Error('candidate index: revision record integrity digest mismatch');
  if (Object.keys(record).sort().join(',') !== 'candidate,content,dependencies,identity,kind,parent,provenance,revisionVersion,workflow' ||
      record.revisionVersion !== 2 || record.kind !== 'candidate' || record.candidate !== id ||
      !digestPattern.test(record.parent) || !Array.isArray(record.dependencies) || !record.provenance ||
      Object.keys(record.provenance).sort().join(',') !== 'binding,configSha256,evaluationBase,expectedTreeSha256,migrationBase,migrationId,proposals,workflowChange' ||
      !canonicalJSON(record.identity).equals(canonicalJSON(index.release)) || !canonicalJSON(record.content).equals(canonicalJSON(index.content)) ||
      record.provenance?.migrationId !== index.migrationId) throw new Error('candidate index: metadata mismatch');
  const stampBytes = readStoreFile(root, `stamps/sha256/${index.stampDigest}/snapshot.json`), stamp = parseRecord(stampBytes);
  if (!canonicalJSON(stamp).equals(stampBytes) || hashRecord('agent-profiles/stamp/v2', stamp) !== index.stampDigest ||
      !canonicalJSON(stamp.capture).equals(canonicalJSON({ kind: 'candidate', migration: index.migrationId, candidate: index.revisionDigest }))) throw new Error('candidate index: stamp mismatch');
  verifyObject(root, index.content.sha256, index.content.identity);
  return index;
}

export function candidateReservation(root, identity) {
  const folder = safePath(root, 'candidates/ids');
  if (!statOrNull(folder)) return false;
  directory(folder);
  let reserved = false;
  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.json')) throw new Error('candidate index: unexpected member');
    const index = candidateIndex(root, name.slice(0, -5));
    if (index.release.name === identity.name && index.release.version === identity.version) reserved = true;
  }
  return reserved;
}

// Retain the verified raw tree without publishing or changing its embedded legacy identity.
export function retainPackageObject({ sourceDirectory, storeRoot: selected, expectedDigest }) {
  if (typeof expectedDigest !== 'string' || !digestPattern.test(expectedDigest)) throw new Error('expected digest: invalid SHA-256');
  const source = rootPath(sourceDirectory, 'source'), root = storeRoot(selected);
  const relative = path.relative(source, root), inverse = path.relative(root, source);
  const inside = value => !path.isAbsolute(value) && value !== '..' && !value.startsWith(`..${path.sep}`);
  if (inside(relative) || inside(inverse)) throw new Error('source/store overlap is forbidden');
  const writer = safePath(root, '.writer-lock');
  try { mkdirSync(writer); } catch (error) { if (error.code === 'EEXIST') throw new Error('store-busy: writer lock exists'); throw error; }
  let staging;
  try {
    writeFlushed(path.join(writer, 'owner.json'), canonicalJSON({ pid: process.pid, operation: randomUUID() }));
    mkdirSync(safePath(root, '.staging'), { recursive: true });
    staging = mkdtempSync(path.join(safePath(root, '.staging'), 'package-object-'));
    const object = path.join(staging, 'object'), tree = path.join(object, 'tree'); mkdirSync(tree, { recursive: true });
    const copied = readTree(source, tree), staged = readPackage({ root: tree });
    if (hashTree(copied) !== expectedDigest || staged.sha256 !== expectedDigest) throw new Error('stale-input: expected tree digest mismatch');
    const identity = { name: staged.manifest.package.name, version: staged.manifest.package.version };
    const target = safePath(root, `objects/sha256/${expectedDigest}`);
    mkdirSync(path.dirname(target), { recursive: true });
    if (statOrNull(target)) verifyObject(root, expectedDigest, identity); else publish(object, target, renameSync);
    verifyObject(root, expectedDigest, identity);
    return { identity, sha256: expectedDigest };
  } finally {
    try { if (staging) rmSync(staging, { recursive: true, force: true }); }
    finally { rmSync(writer, { recursive: true, force: true }); }
  }
}

export function recoverStore({ storeRoot: selected = undefined, confirmNoActiveWriter = undefined }) {
  if (confirmNoActiveWriter !== true) throw new Error('recovery requires confirmNoActiveWriter === true');
  const root = storeRoot(selected);
  const lock = safePath(root, '.writer-lock');
  const stagingRoot = safePath(root, '.staging');
  const staging = statOrNull(stagingRoot) ? readdirSync(stagingRoot).sort() : [];
  // Preflight every removal before changing state; never traverse a recovery link.
  for (const name of staging) {
    const target = safePath(root, `.staging/${name}`);
    if (!name.startsWith('package-')) throw new Error('recovery: unknown staging entry');
    scan(target);
  }
  const locked = Boolean(statOrNull(lock));
  if (locked) {
    directory(lock);
    for (const name of readdirSync(lock)) safePath(root, `.writer-lock/${name}`);
  }
  for (const name of staging) rmSync(path.join(stagingRoot, name), { recursive: true });
  if (locked) rmSync(lock, { recursive: true });
  return { lock: locked, staging };
}
