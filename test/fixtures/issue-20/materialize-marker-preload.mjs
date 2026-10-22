// Child-only: default test discovery and requests without markerGate have no effects.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(new URL('./materialize-worker.mjs', import.meta.url)) && process.argv[2] !== undefined) {
  const q = JSON.parse(process.argv[2]);
  if (q.markerGate !== undefined) {
    const root = fs.realpathSync(q.ownedRoot), control = fs.realpathSync(q.markerGate.root);
    if (control !== path.resolve(q.markerGate.root) || path.dirname(control) !== root || fs.lstatSync(control).isSymbolicLink()
      || q.barrier?.phase !== 'after-rename' || q.barrier.marker !== path.join(control, 'ready.marker')
      || q.barrier.release !== path.join(control, 'worker.release')) throw new Error('invalid owned marker gate');
    const original = { write: fs.writeFileSync, open: fs.openSync, close: fs.closeSync,
      rename: fs.renameSync, exists: fs.existsSync };
    const release = path.join(control, 'write.release'), signal = path.join(control, 'write-open.json');
    let held = false;
    fs.writeFileSync = (value, data, ...options) => {
      if (data !== q.barrier.phase) return original.write(value, data, ...options);
      if (held || typeof value !== 'string' || path.dirname(path.resolve(value)) !== control
        || fs.realpathSync(path.dirname(value)) !== control) throw new Error('invalid marker payload target');
      held = true;
      // Open real bytes before signaling; keep the worker's original write call unchanged after release.
      const fd = original.open(value, 'wx');
      try {
        original.write(signal + '.pending', JSON.stringify({ target: path.resolve(value) }));
        original.rename(signal + '.pending', signal);
        const wait = new Int32Array(new SharedArrayBuffer(4)), start = Date.now();
        while (!original.exists(release)) {
          if (Date.now() - start >= 20000) throw new Error('marker payload release not received');
          Atomics.wait(wait, 0, 0, 10);
        }
        return original.write(value, data, ...options);
      } finally { original.close(fd); }
    };
  }
}
