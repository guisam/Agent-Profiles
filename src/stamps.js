import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { canonicalJSON, hashRecord, parseManifest, parseRecord, validateMembers } from './packages.js';
import { identifier, parseYaml, resolveInstructions, skillMetadata, validatePackageBindings } from './resolve.js';
import { integrations } from './integrations.js';
import { rootPath, storeRoot, safePath, statOrNull, sameStat, readStoreFile, writeFlushed, verifyObject, publish } from './package-store.js';

const DOMAIN = 'agent-profiles/stamp/v1';
const CONFIG = '.agent-profiles/agents.yaml';
const LOCK = '.agent-profiles/agent-profiles.lock';
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => canonicalJSON(a).equals(canonicalJSON(b));
const key = p => `${p.name}@${p.version}`;
const packageOrder = (a, b) => compare(a.name, b.name) || compare(a.version, b.version) || compare(a.sha256, b.sha256);
const inventory = { managed: 'selected-required-and-available', host: 'unobserved', exclusiveVisibility: 'unverified' };
const coverage = { localResources: 'declared-only', hostContext: 'unobserved', runtimeModel: 'unverified', renderedPrompt: 'unverified' };
const hosts = integrations.map(adapter => adapter.id);

function fail(location, message) { throw new Error(`${location}: ${message}`); }
function object(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(location, 'expected an object');
}
function fields(value, location, keys) {
  object(value, location);
  for (const k of Object.keys(value)) if (!keys.includes(k)) fail(`${location}.${k}`, 'unknown field');
  for (const k of keys) if (!Object.hasOwn(value, k)) fail(`${location}.${k}`, 'required field is missing');
}
function options(value, keys) {
  object(value, 'options');
  for (const k of Object.keys(value)) if (!keys.includes(k)) fail(k, 'unknown option');
}
function text(value, location) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(location, 'expected a nonempty string without NUL');
}
function digest(value, location = 'digest') {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail(location, 'expected 64 lowercase hexadecimal characters');
}
function portable(value) { validateMembers([{ path: value, type: 'file', nlink: 1 }]); }
function list(value, location) { if (!Array.isArray(value)) fail(location, 'expected an array'); }
function unique(values, location) {
  if (new Set(values).size !== values.length) fail(location, 'duplicate entry');
}
function host(value, nullable = false) {
  if (!(nullable && value === null) && !hosts.includes(value)) fail('host', 'unknown host');
}
function identity(p, location) {
  if (typeof p.name !== 'string' || !/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(p.name)) fail(location, 'expected package @namespace/name');
  if (typeof p.version !== 'string' || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(p.version) ||
      p.version.split('.').some(n => !Number.isSafeInteger(Number(n)))) fail(location, 'expected exact safe release version');
  digest(p.sha256);
}
function backing(b, location) {
  object(b, `${location}.backing`);
  fields(b, `${location}.backing`, b.type === 'blob' ? ['type', 'sha256', 'bytes', 'path'] : ['type', 'sha256', 'path']);
  if (!['blob', 'package'].includes(b.type)) fail(location, 'unknown backing type');
  digest(b.sha256); portable(b.path);
  if (b.type === 'blob' && (!Number.isSafeInteger(b.bytes) || b.bytes < 0)) fail(location, 'invalid blob bytes length');
}

function validateSnapshot(s) {
  fields(s, 'snapshot', ['stampVersion', 'configurationVersion', 'resolverContract', 'selection', 'requested', 'composition', 'required', 'available', 'packages', 'shared', 'hostReferences', 'inventory', 'coverage']);
  if (s.stampVersion !== 1 || ![1, 2].includes(s.configurationVersion) || s.resolverContract !== `agent-profiles/resolver/v${s.configurationVersion}`) fail('resolverContract', 'unsupported snapshot/configurationVersion');
  if (!equal(s.inventory, inventory)) fail('inventory', 'expected unobserved host and unverified exclusive visibility');
  if (!equal(s.coverage, coverage)) fail('coverage', 'expected declared-only resources and unverified runtimeModel/renderedPrompt');
  const sel = s.selection;
  fields(sel, 'selection', ['host', 'identity', 'family', 'familySource', 'profile', 'role', 'roleSource']);
  host(sel.host, true); identifier(sel.profile, 'selection.profile'); identifier(sel.role, 'selection.role');
  if (!['default', 'assigned'].includes(sel.roleSource)) fail('roleSource', 'invalid role provenance');
  if (sel.family !== null) text(sel.family, 'family');
  if (![null, 'supplied', 'configured-prefix'].includes(sel.familySource) || (sel.family === null) !== (sel.familySource === null)) fail('familySource', 'inconsistent family provenance');
  const id = sel.identity;
  fields(id, 'identity', ['raw', 'canonical', 'source', 'matchedBy']);
  for (const k of ['raw', 'canonical']) if (id[k] !== null) text(id[k], `identity.${k}`);
  if (![null, 'host', 'host-stated', 'user'].includes(id.source) || (id.raw === null && id.source !== null)) fail('identity.source', 'invalid provenance');
  if (!['model', 'alias', 'family', 'family-prefix', 'default'].includes(id.matchedBy) ||
      (['model', 'alias'].includes(id.matchedBy) !== (id.canonical !== null)) ||
      (id.matchedBy === 'model' && id.raw !== id.canonical) ||
      (id.matchedBy === 'alias' && (id.raw === null || id.raw === id.canonical)) ||
      (id.matchedBy.startsWith('family') && sel.family === null) ||
      (id.matchedBy === 'family-prefix' && (id.raw === null || sel.familySource !== 'configured-prefix'))) fail('identity.matchedBy', 'inconsistent routing provenance');
  for (const k of ['requested', 'composition', 'required', 'available', 'packages', 'shared', 'hostReferences']) list(s[k], k);
  s.requested.forEach(v => identifier(v, 'requested')); unique(s.requested, 'requested');
  const packages = new Map();
  for (const p of s.packages) {
    fields(p, 'packages', ['name', 'version', 'sha256', 'behavior']); identity(p, 'packages');
    fields(p.behavior, 'packages.behavior', ['delivery', 'hosts', 'effects']);
    if (!['instruction', 'native'].includes(p.behavior.delivery)) fail('packages.behavior', 'invalid delivery');
    for (const k of ['hosts', 'effects']) { list(p.behavior[k], `behavior.${k}`); unique(p.behavior[k], `behavior.${k}`); }
    p.behavior.hosts.forEach(v => host(v));
    if (p.behavior.effects.some(v => !['commands', 'substitution', 'external-references', 'host-configuration'].includes(v)) ||
        (p.behavior.delivery === 'native') !== (p.behavior.hosts.length > 0)) fail('packages.behavior', 'invalid behavior');
    if (packages.has(key(p))) fail('packages', 'duplicate revision');
    packages.set(key(p), p);
  }
  for (let i = 1; i < s.packages.length; i++) if (packageOrder(s.packages[i - 1], s.packages[i]) >= 0) fail('packages', 'expected sorted unique revisions');
  const used = new Set();
  const entry = (e, binding, location) => {
    if (e.backing === null) {
      if (e.type !== 'host' || e.package !== null) fail(location, 'missing backing');
    } else backing(e.backing, location);
    if (e.backing?.type === 'package') {
      const p = e.package;
      fields(p, `${location}.package`, ['binding', 'name', 'version', 'sha256', 'selectedBy', 'selectors']); identity(p, location);
      if (p.binding !== binding || p.sha256 !== e.backing.sha256 || packages.get(key(p))?.sha256 !== p.sha256) fail(location, 'package binding/revision/backing closure mismatch');
      identifier(p.selectedBy, `${location}.selectedBy`); object(p.selectors, `${location}.selectors`);
      const context = { model: id.canonical, role: sel.role, profile: sel.profile, host: sel.host };
      for (const [k, v] of Object.entries(p.selectors)) if (!Object.hasOwn(context, k) || v === null || v !== context[k]) fail(location, `selector ${k} disagrees with selection`);
      if (p.selectedBy === 'binding-default' && Object.keys(p.selectors).length) fail(location, 'binding-default selectors must be empty');
      used.add(key(p));
    } else if (e.package !== null) fail(location, 'blob backing requires null package provenance');
    list(e.resources, `${location}.resources`);
    if ((e.package !== null || e.type === 'host') && e.resources.length) fail(location, 'package/native resources must be empty');
    for (const r of e.resources) {
      fields(r, `${location}.resources`, ['binding', 'backing']); backing(r.backing, 'resources');
      if (r.binding !== binding || r.backing.type !== 'blob' || r.backing.path === e.backing?.path) fail(location, 'resources binding owner/path mismatch');
    }
    for (let i = 1; i < e.resources.length; i++) if (compare(e.resources[i - 1].backing.path, e.resources[i].backing.path) >= 0) fail(location, 'resources must be sorted and unique');
  };
  const skills = new Map();
  for (const group of ['required', 'available']) for (const e of s[group]) {
    fields(e, group, ['id', 'type', 'delivery', 'name', 'nameSource', 'description', 'backing', 'package', 'resources', 'hostReference']);
    identifier(e.id, group); text(e.name, `${group}.name`);
    if (!['frontmatter', 'directory', 'host'].includes(e.nameSource) || (e.description !== null && typeof e.description !== 'string')) fail(group, 'invalid skill metadata');
    if (!['instruction', 'host'].includes(e.type) || e.delivery !== (e.type === 'instruction' ? 'inject' : 'invoke')) fail(group, 'invalid skill type/delivery');
    if (e.hostReference !== (e.type === 'host' ? `skills.${e.id}` : null)) fail(group, 'invalid hostReference');
    if (skills.has(e.id)) fail(group, 'duplicate required/available ID');
    entry(e, `skills.${e.id}`, `${group}.${e.id}`); skills.set(e.id, e);
  }
  for (const v of s.requested) if (!skills.has(v)) fail('requested', `unpermitted skill ${v}`);
  s.composition.forEach((e, i) => {
    fields(e, 'composition', ['kind', 'id', 'backing', 'package', 'resources']); identifier(e.id, 'composition.id');
    if (i < 2) {
      const kind = i === 0 ? 'profile' : 'role';
      if (e.kind !== kind || e.id !== sel[kind]) fail('composition', `expected ${kind} in order`);
      entry(e, `${kind === 'profile' ? 'profiles' : 'roles'}.${e.id}`, `composition.${kind}`);
    } else {
      const skill = skills.get(e.id);
      if (!skill || skill.type !== 'instruction' || !equal(e, { kind: e.kind, id: skill.id, backing: skill.backing, package: skill.package, resources: skill.resources })) fail('composition', `skill ${e.id} backing/package/resources disagreement or native injection`);
    }
  });
  const wanted = [...s.required.filter(e => e.type === 'instruction').map(e => ['required-skill', e.id]),
    ...s.requested.filter(v => s.available.some(e => e.id === v && e.type === 'instruction')).map(v => ['requested-skill', v])];
  if (s.composition.length < 2 || !equal(s.composition.slice(2).map(e => [e.kind, e.id]), wanted)) fail('composition', 'required/requested membership or order mismatch');
  if (used.size !== packages.size) fail('packages', 'foreign or omitted package closure');
  unique(s.shared.map(e => e.path), 'shared');
  for (const e of s.shared) {
    fields(e, 'shared', ['path', 'status', 'backing', 'delivery']); portable(e.path);
    if (!['captured', 'absent', 'unobserved'].includes(e.status) || e.delivery !== 'host-controlled') fail('shared', 'invalid observation');
    if (e.status === 'captured') {
      backing(e.backing, 'shared');
      if (e.backing.type !== 'blob' || e.backing.path !== e.path) fail('shared', 'captured backing path mismatch');
    } else if (e.backing !== null) fail('shared', 'unobserved/absent backing must be null');
  }
  unique(s.hostReferences.map(e => e.key), 'hostReferences');
  const native = [...skills.values()].filter(e => e.type === 'host');
  if (s.hostReferences.length !== native.length) fail('hostReferences', 'native closure mismatch');
  for (const [i, e] of s.hostReferences.entries()) {
    fields(e, 'hostReferences', ['key', 'id', 'host', 'scope', 'hostId', 'requirement', 'compatibility', 'observation', 'backing', 'invocation', 'rendered', 'supportedHosts']);
    const skill = native[i];
    if (e.key !== skill.hostReference || e.id !== skill.id || e.requirement !== (s.required.includes(skill) ? 'required' : 'available') || !equal(e.backing, skill.backing)) fail('hostReferences', 'native association/backing/order mismatch');
    list(e.supportedHosts, 'supportedHosts'); unique(e.supportedHosts, 'supportedHosts'); e.supportedHosts.forEach(v => host(v));
    if (e.scope === 'package') {
      if (!skill.package || e.hostId !== null || e.host !== sel.host || !equal(e.supportedHosts, packages.get(key(skill.package)).behavior.hosts)) fail('hostReferences', 'package native host relation mismatch');
    } else {
      host(e.host);
      const adapter = integrations.find(a => a.id === e.host);
      if (skill.package !== null || !['project', 'user', 'plugin'].includes(e.scope) || typeof e.hostId !== 'string' || !adapter.skills?.[e.scope]?.id.test(e.hostId) || !equal(e.supportedHosts, [e.host])) fail('hostReferences', 'invalid native scope/identifier');
      if (e.scope === 'project' && e.backing?.path !== adapter.skills.project.path(e.hostId)) fail('hostReferences', 'project native path mismatch');
    }
    const captured = ['project', 'package'].includes(e.scope);
    if (e.observation !== (captured ? 'captured-file' : 'host-provided-unverified') || (e.backing !== null) !== captured ||
        e.compatibility !== (sel.host === null ? null : e.supportedHosts.includes(sel.host)) || e.invocation !== 'unverified' || e.rendered !== 'unverified') fail('hostReferences', 'compatibility/observation/invocation relation mismatch');
  }
  const paths = allBackings(s).filter(b => b.type === 'blob').map(b => b.path);
  validateMembers([...new Set(paths)].map(p => ({ path: p, type: 'file', nlink: 1 })));
}

function allBackings(s) {
  return [...s.composition, ...s.required, ...s.available, ...s.shared, ...s.hostReferences]
    .flatMap(e => [e.backing, ...(e.resources ?? []).map(r => r.backing)]).filter(Boolean);
}

function readBacking(root, b, packages) {
  if (b.type === 'package') {
    const file = packages.get(b.sha256)?.files.find(f => f.path === b.path);
    if (!file) fail('package backing', `missing path ${b.path}`);
    return file.bytes;
  }
  const bytes = readStoreFile(root, `blobs/sha256/${b.sha256}`);
  if (bytes.length !== b.bytes || sha(bytes) !== b.sha256) fail('blob', `bytes length/digest mismatch ${b.sha256}`);
  return bytes;
}

function readPackages(root, s) {
  const packages = new Map();
  for (const p of s.packages) {
    lstatSync(safePath(root, `objects/sha256/${p.sha256}/tree`));
    const files = verifyObject(root, p.sha256, p);
    const manifest = parseManifest(files.find(f => f.path === 'package.yaml').bytes);
    packages.set(p.sha256, { files, manifest });
  }
  return packages;
}

function manifestRelations(s, packages) {
  for (const p of s.packages) if (!equal(p.behavior, packages.get(p.sha256).manifest.behavior)) fail('snapshot relation packages.behavior', 'manifest disagreement');
  const bindings = new Map(), records = new Map();
  for (const e of [...s.composition.slice(0, 2), ...s.required, ...s.available].filter(e => e.package)) {
    const p = e.package, found = packages.get(p.sha256);
    if (e.backing.path !== found.manifest.entrypoint) fail('snapshot relation composition.entrypoint', 'manifest entrypoint disagreement');
    bindings.set(p.binding, { source: new Map([['package', p.name], ['version', p.version]]), type: p.binding.startsWith('skills.') ? 'skill' : 'instruction', rules: [], pins: new Map() });
    records.set(key(p), { sha256: p.sha256, files: found.files });
  }
  validatePackageBindings(bindings, records);
  for (const e of [...s.required, ...s.available].filter(e => e.package)) {
    const pin = bindings.get(e.package.binding).pins.get(e.package.version);
    if ((pin.manifest.behavior.delivery === 'native') !== (e.type === 'host')) fail('snapshot relation skill type', 'manifest delivery disagreement');
    for (const k of ['name', 'nameSource', 'description']) if (e[k] !== pin.metadata[k]) fail('snapshot relation skill metadata', `${k} disagreement`);
  }
}

function localContent(root, s, packages) {
  const entries = [...s.composition.slice(0, 2), ...s.required, ...s.available];
  for (const e of entries.filter(e => e.backing?.type === 'blob' && e.type !== 'host')) {
    const bytes = readBacking(root, e.backing, packages);
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (e.type === 'instruction') {
      const metadata = skillMetadata('unused', e.id, bytes, e.backing.path);
      for (const k of ['name', 'nameSource', 'description']) if (e[k] !== metadata[k]) fail('snapshot relation skill metadata', `${e.id}.${k} disagreement`);
    }
  }
}

/** @param {{root?: string, storeRoot?: string, host?: string, model?: string, family?: string, identitySource?: 'host'|'host-stated'|'user', role?: string, skills?: string[], sharedFiles?: string[]}} input */
export function createStamp(input = {}) {
  options(input, ['root', 'storeRoot', 'host', 'model', 'family', 'identitySource', 'role', 'skills', 'sharedFiles']);
  const { sharedFiles, ...selectors } = input;
  const root = rootPath(input.root === undefined ? process.cwd() : input.root, 'root');
  const inputs = new Map(), blobs = new Map();
  const capture = relative => {
    portable(relative);
    if (!inputs.has(relative)) {
      const bytes = readStoreFile(root, relative), stat = lstatSync(safePath(root, relative), { bigint: true });
      inputs.set(relative, { bytes, stat });
    }
    return inputs.get(relative).bytes;
  };
  const configuration = parseYaml(capture(CONFIG).toString('utf8'));
  const resolved = resolveInstructions({ ...selectors, root, configuration });
  if (resolved.lockState === 'valid') capture(LOCK);
  const blob = (relative, instruction = false) => {
    const bytes = capture(relative);
    if (instruction) new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const sha256 = sha(bytes); blobs.set(sha256, bytes);
    return { type: 'blob', path: relative, sha256, bytes: bytes.length };
  };
  const base = e => ({ backing: e.package ? { ...e.backing } : e.path ? blob(e.path, e.type !== 'host') : null, package: e.package ?? null,
    resources: (e.resources ?? []).map(relative => ({ binding: `${e.kind === 'profile' ? 'profiles' : e.kind === 'role' ? 'roles' : 'skills'}.${e.id}`, backing: blob(relative) })) });
  const skill = e => ({ id: e.id, type: e.type, delivery: e.delivery, name: e.name, nameSource: e.nameSource, description: e.description,
    ...base(e), hostReference: e.type === 'host' ? `skills.${e.id}` : null });
  const required = resolved.required.map(skill), available = resolved.available.map(skill);
  const composition = resolved.loaded.map(e => ({ kind: e.kind, id: e.id, ...base(e) }));
  const destination = storeRoot(input.storeRoot);
  const selections = [...composition, ...required, ...available].filter(e => e.package).map(e => e.package);
  const packages = [...new Map(selections.map(p => [key(p), p])).values()].map(p => {
    const files = verifyObject(destination, p.sha256, p), manifest = parseManifest(files.find(f => f.path === 'package.yaml').bytes);
    return { name: p.name, version: p.version, sha256: p.sha256, behavior: manifest.behavior };
  }).sort(packageOrder);
  if (sharedFiles !== undefined) { list(sharedFiles, 'sharedFiles'); unique(sharedFiles, 'sharedFiles'); sharedFiles.forEach(portable); }
  const shared = (sharedFiles ?? ['AGENTS.md']).map(relative => {
    let backing = null, status;
    try { backing = blob(relative); status = 'captured'; }
    catch (error) {
      if (sharedFiles !== undefined) fail('shared capture', error.message);
      status = error.code === 'ENOENT' ? 'absent' : 'unobserved';
    }
    return { path: relative, status, backing, delivery: 'host-controlled' };
  });
  const hostReferences = ['required', 'available'].flatMap(group => resolved[group].filter(e => e.type === 'host').map(e => {
    const skill = (group === 'required' ? required : available).find(s => s.id === e.id);
    const supportedHosts = e.supportedHosts ?? [e.host];
    return { key: skill.hostReference, id: e.id, host: e.host, scope: e.scope, hostId: e.hostId, requirement: group,
      compatibility: resolved.host === null ? null : supportedHosts.includes(resolved.host),
      observation: skill.backing ? 'captured-file' : 'host-provided-unverified', backing: skill.backing,
      invocation: 'unverified', rendered: 'unverified', supportedHosts };
  }));
  const snapshot = { stampVersion: 1, configurationVersion: configuration.get('version'), resolverContract: `agent-profiles/resolver/v${configuration.get('version')}`,
    selection: Object.fromEntries(['host', 'identity', 'family', 'familySource', 'profile', 'role', 'roleSource'].map(k => [k, resolved[k]])),
    requested: [...new Set(input.skills ?? [])], composition, required, available, packages, shared, hostReferences, inventory: { ...inventory }, coverage: { ...coverage } };
  validateSnapshot(snapshot);
  const retained = readPackages(destination, snapshot); manifestRelations(snapshot, retained);
  const stampDigest = hashRecord(DOMAIN, snapshot), bytes = canonicalJSON(snapshot);
  const store = storeRoot(input.storeRoot, true), writer = safePath(store, '.writer-lock');
  try { mkdirSync(writer); }
  catch (error) { if (error.code === 'EEXIST') fail('store-busy', 'writer lock exists'); throw error; }
  let staging;
  try {
    writeFlushed(path.join(writer, 'owner.json'), canonicalJSON({ pid: process.pid, operation: randomUUID() }));
    for (const p of ['.staging', 'blobs/sha256', 'stamps/sha256']) mkdirSync(safePath(store, p), { recursive: true });
    staging = mkdtempSync(path.join(safePath(store, '.staging'), 'package-stamp-'));
    for (const [hash, content] of blobs) {
      const final = safePath(store, `blobs/sha256/${hash}`);
      if (statOrNull(final)) {
        if (!readStoreFile(store, `blobs/sha256/${hash}`).equals(content)) fail('blob', `digest mismatch ${hash}`);
      } else {
        const temporary = path.join(staging, hash); writeFlushed(temporary, content); publish(temporary, final, renameSync);
      }
    }
    const checked = readPackages(store, snapshot); manifestRelations(snapshot, checked);
    for (const b of allBackings(snapshot)) readBacking(store, b, checked);
    localContent(store, snapshot, checked);
    const unchanged = () => {
      for (const [relative, before] of inputs) {
        if (!readStoreFile(root, relative).equals(before.bytes) || !sameStat(before.stat, lstatSync(safePath(root, relative), { bigint: true }))) fail(relative, 'stale-input: changed during capture');
      }
    };
    const final = safePath(store, `stamps/sha256/${stampDigest}`);
    if (statOrNull(final)) {
      unchanged();
      const existing = loadStamp(store, stampDigest);
      if (!equal(existing, snapshot)) fail('snapshot', 'existing digest mismatch');
    } else {
      const temporary = path.join(staging, 'snapshot'); mkdirSync(temporary);
      writeFlushed(path.join(temporary, 'snapshot.json'), bytes);
      unchanged();
      publish(temporary, final, renameSync);
    }
    loadStamp(store, stampDigest);
    return { digest: stampDigest, snapshot };
  } finally {
    try { if (staging) rmSync(staging, { recursive: true, force: true }); }
    finally { rmSync(writer, { recursive: true, force: true }); }
  }
}

function loadStamp(root, hash) {
  const relative = `stamps/sha256/${hash}`;
  const directory = safePath(root, relative);
  const bytes = readStoreFile(root, `${relative}/snapshot.json`);
  if (readdirSync(directory).join(',') !== 'snapshot.json') fail('snapshot', 'unexpected directory membership');
  const snapshot = parseRecord(bytes);
  if (!canonicalJSON(snapshot).equals(bytes)) fail('snapshot', 'noncanonical encoding');
  if (hashRecord(DOMAIN, snapshot) !== hash) fail('snapshot', 'digest/domain mismatch');
  validateSnapshot(snapshot);
  return snapshot;
}

function inspect(input) {
  digest(input.digest);
  const report = { snapshotIntegrity: 'unverified', managedContent: 'unverified', managedReconstruction: 'unverified',
    hostDependencies: 'unverified', hostInvocation: 'unverified', runtimeIdentity: 'unverified', renderedPrompt: 'unverified',
    managedReproducible: false, declaredHostDependenciesSatisfied: false, completeRuntimeReproducible: false, findings: [] };
  let root, snapshot, packages;
  try { root = storeRoot(input.storeRoot); snapshot = loadStamp(root, input.digest); report.snapshotIntegrity = 'verified'; }
  catch (error) {
    report.snapshotIntegrity = error.code === 'ENOENT' ? 'missing' : 'mismatched'; report.findings.push(`snapshot: ${error.message}`);
    return { report };
  }
  try {
    packages = readPackages(root, snapshot); manifestRelations(snapshot, packages);
    for (const b of allBackings(snapshot)) readBacking(root, b, packages);
    localContent(root, snapshot, packages);
    report.managedContent = 'verified'; report.managedReconstruction = 'verified'; report.managedReproducible = true;
  } catch (error) {
    if (error.message.startsWith('snapshot relation')) report.snapshotIntegrity = 'mismatched';
    else report.managedContent = error.code === 'ENOENT' ? 'missing' : 'mismatched';
    report.findings.push(error.message);
    return { report };
  }
  report.declaredHostDependenciesSatisfied = !snapshot.hostReferences.some(e => e.requirement === 'required');
  if (snapshot.hostReferences.length) report.findings.push('Host dependencies and native invocation remain unverified');
  return { report, root, snapshot, packages };
}

/** @param {{digest: string, storeRoot?: string}} input */
export function verifyStamp(input) {
  options(input, ['digest', 'storeRoot']);
  return inspect(input).report;
}

/** @param {{before: string, after: string, storeRoot?: string}} input */
export function diffStamps(input) {
  options(input, ['before', 'after', 'storeRoot']);
  digest(input.before, 'before');
  digest(input.after, 'after');
  const before = inspect({ digest: input.before, storeRoot: input.storeRoot });
  const after = inspect({ digest: input.after, storeRoot: input.storeRoot });
  const complete = before.report.managedReproducible === true && after.report.managedReproducible === true;
  const changes = [];
  function walk(a, b, location) {
    if (a === b) return;
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
      const keys = [];
      if (Array.isArray(a)) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) keys.push(String(i));
      } else keys.push(...new Set([...Object.keys(a), ...Object.keys(b)]));
      if (!Array.isArray(a)) keys.sort(compare);
      for (const k of keys) {
        const child = `${location}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        if (!Object.hasOwn(a, k)) changes.push({ path: child, kind: 'added', before: null, after: b[k] });
        else if (!Object.hasOwn(b, k)) changes.push({ path: child, kind: 'removed', before: a[k], after: null });
        else walk(a[k], b[k], child);
      }
    } else changes.push({ path: location, kind: 'changed', before: a, after: b });
  }
  if (complete) walk(before.snapshot, after.snapshot, '');
  return { complete, beforeVerification: before.report, afterVerification: after.report, changes };
}

/** @param {{digest: string, storeRoot?: string, nativeReady?: boolean}} input */
export function reconstructStamp(input) {
  options(input, ['digest', 'storeRoot', 'nativeReady']);
  if (input.nativeReady !== undefined && typeof input.nativeReady !== 'boolean') fail('nativeReady', 'expected boolean');
  const { report, root, snapshot: s, packages } = inspect(input);
  if (!report.managedReproducible) fail('reconstruction', report.findings.join('; '));
  if (input.nativeReady) fail('unsupported-native', 'native-ready reconstruction is not supported');
  const bytes = e => e.backing ? readBacking(root, e.backing, packages) : null;
  return { composition: s.composition.map(e => ({ ...e, bytes: bytes(e) })), required: s.required,
    available: s.available.map(e => e.type === 'instruction' ? { ...e, bytes: bytes(e) } : e),
    resources: [...s.composition.slice(0, 2), ...s.required, ...s.available].flatMap(e => e.resources.map(r => ({ ...r, bytes: readBacking(root, r.backing, packages) }))),
    packages: s.packages.map(p => ({ ...p, files: packages.get(p.sha256).files })),
    shared: s.shared.map(e => ({ ...e, bytes: bytes(e) })), hostReferences: s.hostReferences.map(e => ({ ...e, bytes: bytes(e) })) };
}
