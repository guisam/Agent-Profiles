// Test-only child for package-store.test.js: one store call per process, optionally
// paused at an importPackage onPhase barrier. Not a store implementation.
// argv[2] = JSON {op, args, barrier?: {phase, marker, release}}; prints one JSON line.
import { existsSync, writeFileSync } from 'node:fs';

// Node's default test discovery also executes this fixture without a request.
if (process.argv[2] !== undefined) {
  const { op, args = {}, barrier } = JSON.parse(process.argv[2]);
  const hold = new Int32Array(new SharedArrayBuffer(4));
  function onPhase(phase) {
    if (phase !== barrier?.phase) return;
    writeFileSync(barrier.marker, phase);
    // Synchronous wait so a kill lands exactly at this phase, never after it.
    while (!existsSync(barrier.release)) Atomics.wait(hold, 0, 0, 10);
  }

  let output;
  try {
    if (op === 'control') {
      onPhase('control');
      writeFileSync(args.after, 'after');
      output = { ok: true, result: 'control' };
    } else {
      const sut = await import(new URL('../../../src/package-store.js', import.meta.url).href);
      output = { ok: true, result: await sut[op](op === 'importPackage' ? { ...args, onPhase } : args) };
    }
  } catch (error) {
    output = { ok: false, message: String(error?.message ?? error) };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
