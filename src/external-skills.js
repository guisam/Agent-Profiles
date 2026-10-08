import { closeSync, fstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseYaml, skillMetadata } from './resolve.js';

const nativeId = /^[a-z0-9][a-z0-9-]*$/;

function validateRoots(roots) {
  if (!Array.isArray(roots)) throw new Error('skill sources: roots must be an array');
  return roots.map(root => {
    if (!root || typeof root !== 'object' || Array.isArray(root) ||
        Object.keys(root).some(key => !['host', 'scope', 'path', 'namespace'].includes(key)) ||
        !['claude', 'codex'].includes(root.host) ||
        !(root.scope === 'user' || (root.host === 'claude' && root.scope === 'plugin')) ||
        typeof root.path !== 'string' || !path.isAbsolute(root.path) || root.path.includes('\0') ||
        (root.scope === 'plugin' ? typeof root.namespace !== 'string' || !nativeId.test(root.namespace) : root.namespace !== undefined)) {
      throw new Error('skill sources: expected an absolute user root or Claude plugin root with a valid namespace; unsupported fields/layout');
    }
    if (root.path.split(/[\\/]/).includes('..')) throw new Error('skill sources: root traversal is not permitted');
    return { ...root };
  });
}

export function externalMetadata(file, host) {
  const { raw, content } = readRawFrontmatter(file);
  const metadata = skillMetadata(file, 'external skill', content, file, host === 'codex');
  if (host === 'codex' && (metadata.nameSource !== 'frontmatter' || raw.get('name') !== metadata.name || !nativeId.test(metadata.name))) {
    throw new Error('invalid native identifier; Codex requires an exact frontmatter name, without trimming or normalization');
  }
  return { ...metadata, rawName: raw.get('name') };
}

function readRawFrontmatter(file) {
  const descriptor = openSync(file, 'r');
  const buffer = Buffer.alloc(65536); let size = 0;
  try {
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, Math.min(1024, buffer.length - size), null); size += count;
      const text = buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '');
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (header && (!count || header[0].endsWith('\n'))) return { raw: parseYaml(header[1]), content: buffer.subarray(0, size) };
      if (!count || (!text.startsWith('---\n') && !text.startsWith('---\r\n'))) break;
    }
    throw new Error('expected YAML frontmatter within 64 KiB');
  } finally { closeSync(descriptor); }
}

function localRoots(file, explicit) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new Error('expected a regular JSON file');
    if (info.size > 65536) throw new Error('preferences exceed 64 KiB');
    const buffer = Buffer.alloc(65536);
    let size = 0, count;
    do { count = readSync(descriptor, buffer, size, buffer.length - size, null); size += count; }
    while (count && size < buffer.length);
    if (fstatSync(descriptor).size > 65536) throw new Error('preferences exceed 64 KiB');
    const value = JSON.parse(buffer.subarray(0, size).toString('utf8').replace(/^\uFEFF/, ''));
    if (!value || Array.isArray(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'roots'].includes(key))) {
      throw new Error('expected version 1 and roots only');
    }
    return validateRoots(value.roots);
  } catch (error) {
    if (!explicit && error.code === 'ENOENT') return [];
    throw new Error(`skill sources ${file}: ${error.message}; repair the local preferences before continuing`);
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/**
 * Read metadata only from known or explicitly approved machine-local roots.
 * @param {{home?: string, env?: NodeJS.ProcessEnv, sourcesFile?: string,
 * roots?: Array<{host: string, scope: string, path: string, namespace?: string}>}} options
 */
export function discoverExternalSkills({ home = os.homedir(), env = process.env, sourcesFile, roots: approved = [] } = {}) {
  if (env.CLAUDE_CONFIG_DIR !== undefined && (!path.isAbsolute(env.CLAUDE_CONFIG_DIR) || env.CLAUDE_CONFIG_DIR.includes('\0') || env.CLAUDE_CONFIG_DIR.split(/[\\/]/).includes('..'))) throw new Error('CLAUDE_CONFIG_DIR: expected an absolute home without traversal');
  const file = sourcesFile ?? env.AGENT_PROFILES_SKILL_SOURCES ?? path.join(home, '.config/agent-profiles/skill-sources.json');
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('skill sources: expected an absolute preferences path');
  const roots = [
    { host: 'claude', scope: 'user', path: path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), 'skills') },
    { host: 'codex', scope: 'user', path: path.join(home, '.agents/skills') },
    ...localRoots(file, sourcesFile !== undefined || env.AGENT_PROFILES_SKILL_SOURCES !== undefined),
    ...validateRoots(approved),
  ];
  const skills = [], warnings = [], targets = new Set();
  let count = 0;
  const inside = (origin, target) => {
    const relative = path.relative(origin, target);
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  };
  for (const root of roots) {
    let origin;
    try {
      origin = realpathSync(root.path);
      if (!statSync(origin).isDirectory()) throw new Error('expected a directory');
    } catch (error) {
      if (error.code !== 'ENOENT') warnings.push(`${root.path}: cannot read root (${error.code ?? error.message}); check the path and permissions`);
      continue;
    }
    const visited = new Set();
    function walk(directory, depth) {
      if (++count > 4096) return;
      let canonical;
      try {
        canonical = realpathSync(directory);
        if (!inside(origin, canonical)) {
          warnings.push(`${directory}: resolves outside the approved root ${origin}; explicitly approve a separate root if intended`);
          return;
        }
        if (!statSync(canonical).isDirectory()) return;
        // Claude's shallow scan identifies each invocation directory alias separately.
        // Codex's recursive scan must still deduplicate canonical directories and cycles.
        if (root.host === 'codex' && visited.has(canonical)) return;
        visited.add(canonical);
      } catch (error) {
        warnings.push(`${directory}: cannot inspect directory (${error.code ?? error.message}); check permissions or restore the link`);
        return;
      }
      if (depth > 8) {
        warnings.push(`${directory}: depth limit (8) reached; approve a more specific root`);
        return;
      }
      if (depth > 0) {
        const file = path.join(directory, 'SKILL.md');
        try {
          const target = realpathSync(file);
          if (!inside(origin, target)) throw new Error(`SKILL.md resolves outside the approved root ${origin}`);
          if (!statSync(target).isFile()) throw new Error('SKILL.md must be a regular file');
          const metadata = externalMetadata(target, root.host);
          const native = root.host === 'claude' ? path.basename(directory) : metadata.name;
          if (!nativeId.test(native) || (root.host === 'codex' && metadata.nameSource !== 'frontmatter')) {
            throw new Error('invalid native identifier; use an exact lowercase name containing letters, digits and hyphens (Codex requires frontmatter name)');
          }
          let hostId = native;
          if (root.scope === 'plugin') {
            const command = metadata.rawName ?? native;
            if (typeof command !== 'string') throw new Error('invalid native plugin identifier');
            const suffix = command.startsWith(`${root.namespace}:`) ? command.slice(root.namespace.length + 1) : command;
            if (!nativeId.test(suffix)) throw new Error('invalid native plugin identifier; do not trim, normalize or change the namespace');
            hostId = `${root.namespace}:${suffix}`;
          }
          const key = JSON.stringify([root.host, root.scope, hostId, target]);
          if (!targets.has(key)) {
            targets.add(key);
            skills.push({ id: `${root.host}-${root.scope}-${hostId.replace(':', '-')}`, host: root.host,
              scope: root.scope, hostId, path: target, origin, source: `${root.host}-${root.scope}`,
              external: true, name: metadata.name, description: metadata.description,
              availability: 'metadata-found', runtime: 'unverified', selectable: true });
          }
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`${file}: ${error.message}; repair skill metadata or permissions`);
        }
      }
      if (root.host === 'claude' && depth > 0) return;
      try {
        // Dirents avoid visiting ordinary files; junction/symlink targets are checked above.
        const children = readdirSync(canonical, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
          if (!child.isDirectory() && !child.isSymbolicLink()) continue;
          if (root.host === 'claude' && ['synced', 'anthropic-skills'].includes(child.name)) {
            warnings.push(`${path.join(directory, child.name)}: reserved ${child.name} catalog skipped; downloaded/unsupported namespaces are not user skills`);
            continue;
          }
          if (count >= 4096) break;
          walk(path.join(directory, child.name), depth + 1);
        }
      } catch (error) {
        warnings.push(`${directory}: cannot list skills (${error.code ?? error.message}); check permissions`);
      }
    }
    walk(root.path, 0);
  }
  if (count >= 4096) warnings.push('external skills: directory count limit (4096) reached; narrow the approved roots');
  const identities = new Map();
  for (const skill of skills) {
    const key = JSON.stringify([skill.host, skill.scope, skill.hostId]);
    const group = identities.get(key) ?? [];
    group.push(skill);
    identities.set(key, group);
  }
  for (const group of identities.values()) {
    if (group.length < 2) continue;
    for (const skill of group) skill.selectable = false;
    warnings.push(`external skill conflict: ${group[0].host}/${group[0].scope}/${group[0].hostId} has multiple origins; the host cannot select an exact origin by this portable name`);
  }
  return { skills, warnings, roots };
}

/**
 * Revalidate a preview against independently approved roots immediately before use.
 * Returns the fresh descriptor; metadata discovery does not verify host invocation.
 * @param {any} selection
 * @param {Parameters<typeof discoverExternalSkills>[0]} options
 */
export function validateExternalSelection(selection, options = {}) {
  const inventory = discoverExternalSkills(options);
  const fields = ['host', 'scope', 'hostId', 'path', 'origin', 'name', 'description'];
  if (!selection || typeof selection !== 'object' || fields.some(key => !(key === 'description' && selection[key] === null) && typeof selection[key] !== 'string')) {
    throw new Error('external selection: expected an inventory descriptor; refresh the external catalog');
  }
  const match = inventory.skills.find(skill => fields.every(key => skill[key] === selection[key]));
  if (!match || !match.selectable) {
    throw new Error('external selection: skill disappeared, changed, repointed, is ambiguous, or is outside approved roots; refresh the external catalog and select again');
  }
  return match;
}
