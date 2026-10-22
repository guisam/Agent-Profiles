// Child-only native interception. Default --test discovery has no request and no effects.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

if (process.argv[2] !== undefined) {
  const q = JSON.parse(process.argv[2]);
  const root = fs.realpathSync(q.ownedRoot);
  const inside = value => typeof value === 'string' && (() => {
    const rel = path.relative(root, path.resolve(value));
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  })();
  for (const value of [q.args?.destination, q.args?.outputRoot, q.barrier?.marker, q.barrier?.release].filter(Boolean)) {
    if (!inside(value)) throw new Error('worker request escapes owned root');
  }
  const original = Object.fromEntries(['renameSync', 'readFileSync', 'openSync', 'rmSync', 'lstatSync', 'writeFileSync', 'mkdirSync', 'existsSync'].map(k => [k, fs[k]]));
  const counts = { renames: 0, reads: 0, backingReads: 0, stagingWrites: 0, removals: 0, deviceReads: 0 };
  const phases = [];
  let committed = false;
  let stage;
  const final = q.args?.destination && path.resolve(q.args.destination);
  const output = q.args?.outputRoot && path.resolve(q.args.outputRoot);
  const isFinal = value => typeof value === 'string' && final === path.resolve(value);
  const injected = code => Object.assign(new Error(`owned injected ${code}`), { code });
  function hold(phase) {
    phases.push(phase);
    if (phase !== q.barrier?.phase) return;
    const pending = q.barrier.marker + '.pending';
    original.writeFileSync(pending, phase);
    original.renameSync(pending, q.barrier.marker);
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!original.existsSync(q.barrier.release)) Atomics.wait(wait, 0, 0, 10);
  }
  function beforeRename(from, to) {
    if (!isFinal(to)) return;
    if (!inside(from)) throw new Error('rename source escapes owned root');
    counts.renames++;
    stage = path.resolve(from);
    hold('before-rename');
    if (q.mode === 'rename-error') throw injected(q.code);
  }
  function afterRename(to) {
    if (!isFinal(to)) return;
    committed = true;
    hold('after-rename');
  }
  fs.renameSync = (from, to) => { beforeRename(from, to); const result = original.renameSync(from, to); afterRename(to); return result; };
  const renamePromise = fs.promises.rename.bind(fs.promises);
  fs.promises.rename = async (from, to) => { beforeRename(from, to); await renamePromise(from, to); afterRename(to); };
  const renameCallback = fs.rename;
  fs.rename = (from, to, callback) => {
    try { beforeRename(from, to); } catch (error) { queueMicrotask(() => callback(error)); return; }
    renameCallback(from, to, error => { if (!error) afterRename(to); callback(error); });
  };
  function observeRead(value) {
    if (typeof value !== 'string') return;
    if (inside(value)) counts.reads++;
    if (q.storeRoot && path.resolve(value).startsWith(path.resolve(q.storeRoot) + path.sep)) counts.backingReads++;
    if (committed && q.mode === 'readback-error' && inside(value) && path.resolve(value).startsWith(final + path.sep)) throw injected('EIO');
  }
  fs.openSync = (value, flags, ...rest) => {
    if (flags === 'r' || typeof flags === 'number' && (flags & 3) === 0) observeRead(value);
    else if (typeof value === 'string' && output && path.dirname(value).startsWith(output + path.sep) && value.includes('.stage')) {
      counts.stagingWrites++;
      if ((q.mode === 'write-error' || q.mode === 'cleanup-error') && counts.stagingWrites > 1) throw injected('EIO');
    }
    return original.openSync(value, flags, ...rest);
  };
  fs.readFileSync = (value, ...rest) => { observeRead(value); return original.readFileSync(value, ...rest); };
  fs.rmSync = (value, ...rest) => {
    if (inside(value)) counts.removals++;
    if ((q.mode === 'release-error' && committed || q.mode === 'cleanup-error' && counts.stagingWrites > 0) && inside(value)) throw injected('EACCES');
    return original.rmSync(value, ...rest);
  };
  fs.lstatSync = (value, options) => {
    const stat = original.lstatSync(value, options);
    if (q.mode === 'device' && output && inside(value) && path.dirname(path.resolve(String(value))) === output && !isFinal(value) && stat.isDirectory()) {
      counts.deviceReads++;
      stage = path.resolve(String(value));
      return new Proxy(stat, { get(obj, key) {
        return key === 'dev' && q.mismatch ? obj.dev + (typeof obj.dev === 'bigint' ? 1n : 1) : Reflect.get(obj, key);
      } });
    }
    return stat;
  };
  syncBuiltinESMExports();
  let result;
  try {
    if (q.op === 'write-control') {
      const native = await import('node:fs');
      const { writeFlushed } = await import('../../../src/package-store.js');
      stage = path.join(output, 'control.stage');
      native.mkdirSync(stage);
      try {
        const bytes = Buffer.from([0, 255, 13, 10]);
        writeFlushed(path.join(stage, 'first.bin'), bytes);
        if (!native.readFileSync(path.join(stage, 'first.bin')).equals(bytes)) throw new Error('flushed control bytes mismatch');
        phases.push('first-file-flushed');
        writeFlushed(path.join(stage, 'second.bin'), bytes);
        throw new Error('staged write interception did not fire');
      } catch (error) {
        try { native.rmSync(stage, { recursive: true }); }
        catch (cleanup) {
          throw Object.assign(new Error(`${error.message}; cleanup: ${cleanup.message}`, { cause: error }), { code: cleanup.code });
        }
        throw error;
      }
    } else if (q.op === 'control') {
      // Exercise synchronized named ESM imports, actual rename, readback and removal.
      const native = await import('node:fs');
      const from = path.join(root, 'control-stage');
      native.mkdirSync(from);
      native.writeFileSync(path.join(from, 'bytes'), Buffer.from([0, 255, 13, 10]));
      if (q.mode === 'device') {
        const { publish } = await import('../../../src/package-store.js');
        publish(from, final, native.renameSync);
      } else if (q.entry === 'promise') await native.promises.rename(from, final);
      else if (q.entry === 'callback') await new Promise((resolve, reject) => native.rename(from, final, e => e ? reject(e) : resolve()));
      else native.renameSync(from, final);
      const bytes = native.readFileSync(path.join(final, 'bytes'));
      native.rmSync(final, { recursive: true });
      result = { ok: true, result: [...bytes] };
    } else {
      // Absent SUT is imported only for a real owned materialization request.
      const sut = await import('../../../src/materialize.js');
      result = { ok: true, result: await sut[q.op ?? 'materialize'](q.args) };
    }
  } catch (error) {
    result = { ok: false, message: error.message, code: error.code ?? null,
      causes: (() => { const codes = []; for (let e = error; e; e = e.cause) codes.push({ message: e.message, code: e.code ?? null }); return codes; })() };
  }
  process.stdout.write(JSON.stringify({ ...result, counts, phases, committed, stage }) + '\n');
}
