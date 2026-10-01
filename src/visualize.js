import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readConfiguration } from './configure.js';
import { resolveInstructions } from './resolve.js';
import { resolutionOutput } from './diagnostics.js';

// Only these package assets are served; repository paths never become HTTP paths.
const assets = new Map([
  ['', ['index.html', 'text/html']],
  ['app.js', ['app.js', 'text/javascript']],
  ['style.css', ['style.css', 'text/css']],
]);

/** @param {{root?: string, port?: number, model?: string, family?: string, role?: string, skills?: string[]}} options */
export async function startVisualizer({ root = process.cwd(), port = 0, model, family, role, skills = [] } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const initial = resolveInstructions({ root, model, family, role, skills });
  const token = randomBytes(24).toString('hex');
  const prefix = `/${token}/`;
  let origin;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const send = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    if (request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Local same-origin access only' });
    if (request.method !== 'GET') return send(405, { error: 'Read-only: GET required' });
    try {
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith(prefix)) return send(404, { error: 'Not found' });
      const route = url.pathname.slice(prefix.length);
      if (assets.has(route)) {
        const [file, type] = assets.get(route);
        const body = readFileSync(new URL(`./visualizer/${file}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(body);
      } else if (route === 'api/config') {
        const { configuration } = readConfiguration(root);
        send(200, {
          models: [...configuration.get('models').keys()],
          families: [...configuration.get('families').keys()],
          roles: [...configuration.get('roles').keys()],
          initial: { model: initial.model, family: family ?? null, role: initial.role, skills },
        });
      } else if (route === 'api/resolve') {
        for (const key of url.searchParams.keys()) {
          if (!['model', 'family', 'role', 'skill'].includes(key)) throw new Error(`Unknown parameter: ${key}`);
          if (key !== 'skill' && url.searchParams.getAll(key).length > 1) throw new Error(`Only one ${key} is supported`);
        }
        send(200, resolutionOutput(resolveInstructions({ root,
          model: url.searchParams.get('model') ?? undefined,
          family: url.searchParams.get('family') ?? undefined,
          role: url.searchParams.get('role') ?? undefined,
          skills: url.searchParams.getAll('skill'),
        }), true));
      } else send(404, { error: 'Not found' });
    } catch (error) { send(400, { error: error.message }); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(undefined); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, url: `${origin}${prefix}` };
}
