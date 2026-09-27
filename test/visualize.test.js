import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import test from 'node:test';
import { startVisualizer } from '../src/visualize.js';
import { resolveInstructions } from '../src/resolve.js';
import { formatProof } from '../src/diagnostics.js';

const project = fileURLToPath(new URL('../', import.meta.url));
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-visualize-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('agent-profiles-visualize-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.cpSync(path.join(project, '.agent-profiles'), path.join(root, '.agent-profiles'), { recursive: true });
  return root;
}
async function serve(t, root, options = {}) {
  const app = await startVisualizer({ root, ...options });
  t.after(() => new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }));
  return app;
}

test('visualizer selections, skill projections and provenance exactly match resolver and proof', async t => {
  const root = repository(t);
  const configFile = path.join(root, '.agent-profiles/agents.yaml');
  const original = fs.readFileSync(configFile);
  const { url, server } = await serve(t, root, { model: 'example-model', role: 'reviewer', skills: ['testing'] });
  assert.equal(server.address().address, '127.0.0.1');
  const config = await (await fetch(url + 'api/config')).json();
  assert.ok(config.models.includes('example-model'));
  assert.ok(config.families.includes('example-family'));
  assert.ok(config.roles.includes('reviewer') && config.roles.includes('implementer'));
  assert.deepEqual(config.initial, { model: 'example-model', family: null, role: 'reviewer', skills: ['testing'] });
  for (const [model, family, profile] of [['example-model', 'example-family', 'autonomous'], ['unknown', 'example-family', 'scaffolded'], ['unknown', undefined, 'constrained']]) {
    for (const role of ['reviewer', 'implementer']) {
      const query = new URLSearchParams({ model, role });
      if (family) query.set('family', family);
      const result = await (await fetch(url + 'api/resolve?' + query)).json();
      assert.deepEqual(result, resolveInstructions({ root, model, family, role }));
      assert.equal(result.profile, profile);
      assert.match(formatProof(result), new RegExp(`managed context: ${result.diagnostics.managed.total.bytes} B`));
      assert.ok(result.loaded.every(entry => entry.path && entry.content && Number.isInteger(entry.characters)));
    }
  }
  const base = await (await fetch(url + 'api/resolve?role=reviewer')).json();
  const loaded = await (await fetch(url + 'api/resolve?role=reviewer&skill=testing')).json();
  assert.equal(base.required[0].id, 'code-review');
  assert.equal(base.available[0].id, 'testing');
  assert.equal(loaded.loaded.at(-1).kind, 'requested-skill');
  assert.equal(loaded.diagnostics.managed.total.bytes - base.diagnostics.managed.total.bytes, base.available[0].bytes);
  assert.equal(loaded.diagnostics.availableNotLoaded.bytes, 0);
  assert.equal(base.diagnostics.repository.bytes, null);
  assert.ok(Object.values(base.diagnostics.host).every(entry => entry.status === 'unobserved'));
  const proof = spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'proof', '--root', root, '--role', 'reviewer', '--json', '--contents'], { encoding: 'utf8' });
  assert.equal(proof.status, 0, proof.stderr);
  assert.deepEqual(base, JSON.parse(proof.stdout));
  assert.deepEqual(fs.readFileSync(configFile), original);
  fs.appendFileSync(path.join(root, '.agent-profiles/roles/reviewer.md'), '\nUpdated source.\n');
  const refreshed = await (await fetch(url + 'api/resolve?role=reviewer')).json();
  assert.ok(refreshed.diagnostics.managed.role.bytes > base.diagnostics.managed.role.bytes);
});

test('visualizer is read-only, token protected, same-origin and serves only its own assets', async t => {
  const root = repository(t);
  const { url } = await serve(t, root);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  const html = await page.text();
  for (const text of ['Model', 'Role', 'Required', 'On demand', 'Unobserved', 'AGENTS.md', 'Pin for comparison']) assert.ok(html.includes(text));
  for (const asset of ['app.js', 'style.css']) assert.equal((await fetch(url + asset)).status, 200);
  for (const endpoint of ['.agent-profiles/agents.yaml', '../api/config', 'api/file?path=AGENTS.md', '%2e%2e/package.json']) assert.equal((await fetch(url + endpoint)).status, 404);
  assert.equal((await fetch(new URL('/api/config', url))).status, 404);
  assert.equal((await fetch(url + 'api/config', { method: 'POST' })).status, 405);
  assert.equal((await fetch(url + 'api/config', { headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await fetch(url + 'api/config', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = request(url + 'api/config', { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  for (const query of ['role=missing', 'role=reviewer&skill=unknown', 'root=/tmp', 'model=', 'role=reviewer&role=implementer']) {
    const response = await fetch(url + 'api/resolve?' + query);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
  }
  fs.writeFileSync(path.join(root, '.agent-profiles/agents.yaml'), 'version: invalid\n');
  for (const endpoint of ['api/config', 'api/resolve']) assert.equal((await fetch(url + endpoint)).status, 400);
  await assert.rejects(startVisualizer({ root }), /agents.yaml|version/);
});

test('visualize CLI serves initial selections, rejects bad flags, and reports port conflicts', async t => {
  const root = repository(t);
  for (const args of [['--port', 'abc'], ['--port', '65536'], ['--json'], ['--contents'], ['--role', 'reviewer', '--role', 'implementer']]) {
    const result = spawnSync(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'visualize', '--root', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1, args.join(' '));
  }
  const child = spawn(process.execPath, [path.join(project, 'bin/agent-profiles.js'), 'visualize', '--root', root, '--model', 'example-model', '--role', 'reviewer', '--skill', 'testing'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('CLI did not start')), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited: ${code} ${output}`)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const config = await (await fetch(url + 'api/config')).json();
  assert.equal(config.initial.role, 'reviewer');
  assert.deepEqual(config.initial.skills, ['testing']);
  await assert.rejects(startVisualizer({ root, port: Number(new URL(url).port) }), /EADDRINUSE/);
});
