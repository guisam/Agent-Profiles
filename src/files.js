import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function safePath(root, file) {
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${file}: target must remain inside the repository`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
      throw new Error(`${file}: refusing to modify linked files or directories`);
    }
    if (current !== target && !stat.isDirectory()) throw new Error(`${current}: expected a directory`);
  }
  return target;
}

export function readLocal(root, file) {
  const target = safePath(root, file);
  try { return readFileSync(target); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${file}: ${error.message}`);
  }
}

function snapshotMatches(actual, expected) {
  return actual === null ? expected === null : expected !== null && actual.equals(expected);
}

function writeChange(root, { file, before, after }) {
  const target = safePath(root, file);
  if (!snapshotMatches(readLocal(root, file), before)) throw new Error(`${file}: changed during the operation; retry`);
  if (after === null) { unlinkSync(target); return; }
  const temporary = safePath(root, `${file}.agent-profiles-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, after, { flag: 'wx', mode: before === null ? 0o666 : lstatSync(target).mode });
    if (!snapshotMatches(readLocal(root, file), before)) throw new Error(`${file}: changed during the operation; retry`);
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function applyChanges(root, changes, validate = () => {}) {
  const written = [];
  const directories = [];
  try {
    for (const change of changes) {
      const target = safePath(root, change.file);
      const missing = [];
      for (let dir = path.dirname(target); dir !== root && !existsSync(dir); dir = path.dirname(dir)) missing.push(dir);
      for (const dir of missing.reverse()) { mkdirSync(dir); directories.push(dir); }
      writeChange(root, change);
      written.push(change);
    }
    validate();
  } catch (error) {
    const failures = [];
    for (const change of written.reverse()) {
      try { writeChange(root, { file: change.file, before: change.after, after: change.before }); }
      catch (rollback) { failures.push(rollback.message); }
    }
    for (const dir of directories.reverse()) {
      try { rmdirSync(dir); } catch { /* Preserve directories that are no longer empty. */ }
    }
    throw new Error(`${error.message}\n${failures.length ? `Rollback incomplete: ${failures.join('; ')}. Run doctor.` : 'No file changes retained; completed writes were rolled back.'}`);
  }
  return changes.map(change => change.file);
}
