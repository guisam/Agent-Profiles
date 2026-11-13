import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ownVersion } from "../src/install.ts";
import { satisfiesRange, startVisualizer } from "../src/visualize.ts";

const project = fileURLToPath(new URL("../", import.meta.url));

/** A disposable project with a minimal configuration and, optionally, an installed app. */
function repository(t, { peer = `>=${ownVersion}`, dist = true } = {}) {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "agent-profiles-visualize-app-"),
	);
	t.after(() => {
		assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
		fs.rmSync(root, { recursive: true, force: true });
	});
	const files = {
		".agent-profiles/agents.yaml": `version: 1
default_profile: constrained
default_role: implementer
models: {}
families: {}
roles:
  implementer:
    file: roles/implementer.md
    skills: {required: [], available: []}
`,
		".agent-profiles/profiles/constrained.md": "Constrained profile\n",
		".agent-profiles/roles/implementer.md": "Implementer role\n",
		"package.json": "{}\n",
	};
	if (peer !== null) {
		const app = "node_modules/@guisam/agent-profiles-visualizer";
		Object.assign(files, {
			[`${app}/package.json`]: JSON.stringify({
				name: "@guisam/agent-profiles-visualizer",
				version: "9.8.7",
				peerDependencies: { "@guisam/agent-profiles": peer },
			}),
			[`${app}/secret.txt`]: "outside dist\n",
		});
		if (dist)
			Object.assign(files, {
				[`${app}/dist/index.html`]:
					'<!doctype html>\n<html><head lang="en"><title>App</title></head><body><script type="module" src="./assets/index.js"></script></body></html>\n',
				[`${app}/dist/assets/index.js`]: "console.log('app')\n",
				[`${app}/dist/assets/font.woff2`]: "woff2",
				[`${app}/dist/assets/data.json`]: "{}",
				[`${app}/dist/.hidden.js`]: "hidden\n",
				[`${app}/dist/notes.txt`]: "unknown type\n",
				[`${app}/dist/.vite/manifest.json`]: "{}",
			});
	}
	for (const [file, content] of Object.entries(files)) {
		const destination = path.join(root, file);
		fs.mkdirSync(path.dirname(destination), { recursive: true });
		fs.writeFileSync(destination, content);
	}
	return root;
}

async function serve(t, root, options = {}) {
	const app = await startVisualizer({ root, ...options });
	t.after(
		() =>
			new Promise((resolve) => {
				app.server.close(resolve);
				app.server.closeAllConnections();
			}),
	);
	return app;
}

test("visualize serves an installed app's build under the token with a per-page style nonce", async (t) => {
	const root = repository(t);
	const { url, ui } = await serve(t, root);
	assert.equal(ui.kind, "app");
	assert.equal(ui.version, "9.8.7");
	assert.equal(ui.warning, undefined);

	const nonces = [];
	for (const page of [url, `${url}index.html`]) {
		const response = await fetch(page);
		assert.equal(response.status, 200);
		assert.equal(
			response.headers.get("content-type"),
			"text/html; charset=utf-8",
		);
		assert.equal(response.headers.get("cache-control"), "no-store");
		const policy = response.headers.get("content-security-policy");
		const html = await response.text();
		const nonce = /<meta name="csp-nonce" content="([^"]+)">/.exec(html)?.[1];
		assert.ok(nonce, html);
		assert.ok(html.startsWith('<!doctype html>\n<html><head lang="en"><meta'));
		assert.ok(policy.includes(`style-src 'self' 'nonce-${nonce}';`), policy);
		assert.match(policy, /font-src 'self';/);
		assert.match(policy, /frame-ancestors 'none'/);
		assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
		nonces.push(nonce);
	}
	assert.notEqual(nonces[0], nonces[1]);

	for (const [asset, type] of [
		["assets/index.js", "text/javascript; charset=utf-8"],
		["assets/font.woff2", "font/woff2"],
		["assets/data.json", "application/json; charset=utf-8"],
	]) {
		const response = await fetch(url + asset);
		assert.equal(response.status, 200, asset);
		assert.equal(response.headers.get("content-type"), type);
		assert.doesNotMatch(
			response.headers.get("content-security-policy"),
			/nonce-/,
		);
	}
	// The API is unchanged and takes precedence over files.
	assert.equal((await fetch(`${url}api/config`)).status, 200);
	assert.equal((await fetch(`${url}api/file`)).status, 404);
	// The prototype's files are not served beside the app.
	for (const asset of ["app.js", "style.css"])
		assert.equal((await fetch(url + asset)).status, 404);
});

test("visualize refuses app paths outside dist, dotfiles, unknown types and missing files", async (t) => {
	const root = repository(t);
	const dist = path.join(
		root,
		"node_modules/@guisam/agent-profiles-visualizer/dist",
	);
	let linked = true;
	try {
		fs.symlinkSync(
			path.join(root, ".agent-profiles/agents.yaml"),
			path.join(dist, "linked.json"),
		);
	} catch {
		// Windows without symlink rights: the check is still covered on CI runners.
		linked = false;
	}
	const { url } = await serve(t, root);
	for (const endpoint of [
		"%2e%2e/package.json",
		"..%2fpackage.json",
		"..%5cpackage.json",
		"assets%5cindex.js",
		"%2e%2e/secret.txt",
		".hidden.js",
		".vite/manifest.json",
		"notes.txt",
		"assets",
		"assets/",
		"assets//index.js",
		"assets/missing.js",
		"skills",
		"C:%2fWindows%2fwin.ini",
		"%E0%A4%A",
		...(linked ? ["linked.json"] : []),
	])
		assert.equal((await fetch(url + endpoint)).status, 404, endpoint);
	// Outside the token prefix nothing is served.
	assert.equal((await fetch(new URL("/assets/index.js", url))).status, 404);
	assert.equal((await fetch(new URL("/", url))).status, 404);
});

test("visualize --ui builtin, a missing package or an empty build serve the prototype", async (t) => {
	for (const [options, expected] of [
		[{ ui: "builtin" }, undefined],
		[{ peer: null }, undefined],
		[{ dist: false }, /has no dist\/index\.html/],
	]) {
		const root = repository(t, options);
		const { url, ui } = await serve(t, root, { ui: options.ui });
		assert.equal(ui.kind, "builtin");
		if (expected) assert.match(ui.note, expected);
		const page = await fetch(url);
		assert.match(
			page.headers.get("content-security-policy"),
			/style-src 'self';/,
		);
		assert.ok((await page.text()).includes("Pin for comparison"));
		assert.equal((await fetch(`${url}app.js`)).status, 200);
	}
	await assert.rejects(
		startVisualizer({ root: repository(t), ui: "other" }),
		/ui must be/,
	);
});

test("visualize warns but serves an app that declares another Agent Profiles range", async (t) => {
	const root = repository(t, { peer: "<0.1.0" });
	const { url, ui } = await serve(t, root);
	assert.equal(ui.kind, "app");
	assert.match(ui.warning, /supports @guisam\/agent-profiles <0\.1\.0/);
	assert.equal((await fetch(url)).status, 200);
});

test("peer ranges: comparators, caret, tilde, alternatives, and unknown syntax", () => {
	for (const [version, range, expected] of [
		["0.31.0", ">=0.30.1", true],
		["0.30.0", ">=0.30.1", false],
		["0.31.0", ">=0.30.0 <0.32.0", true],
		["0.32.0", ">=0.30.0 <0.32.0", false],
		["0.31.4", "^0.31.0", true],
		["0.32.0", "^0.31.0", false],
		["1.9.0", "^1.2.3", true],
		["2.0.0", "^1.2.3", false],
		["1.2.9", "~1.2.3", true],
		["1.3.0", "~1.2.3", false],
		["1.0.0", "0.9.0 || 1.0.0", true],
		["1.0.0", "=1.0.0", true],
		["1.0.0", ">1.0.0", false],
		["1.0.0", "<=1.0.0", true],
		["1.0.0", "1.x", null],
		["1.0.0", "*", null],
		["1.0.0-beta", ">=1.0.0", null],
	])
		assert.equal(
			satisfiesRange(version, range),
			expected,
			`${version} ${range}`,
		);
});

test("visualize CLI rejects --ui values and --ui outside visualize, and names the served page", async (t) => {
	const root = repository(t, { peer: "<0.1.0" });
	const cli = (...args) =>
		spawnSync(
			process.execPath,
			[path.join(project, "bin/agent-profiles.ts"), ...args, "--root", root],
			{ encoding: "utf8", timeout: 20000 },
		);
	assert.equal(cli("visualize", "--ui", "other").status, 1);
	const outside = cli("resolve", "--ui", "builtin");
	assert.equal(outside.status, 1);
	assert.match(outside.stderr, /--ui requires auto or builtin/);
	assert.match(cli("--help").stdout, /--ui auto\|builtin/);
	// The startup lines are printed before the server waits for Ctrl+C.
	const { spawn } = await import("node:child_process");
	const child = spawn(
		process.execPath,
		[path.join(project, "bin/agent-profiles.ts"), "visualize", "--root", root],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	t.after(() => child.kill());
	const output = await new Promise((resolve, reject) => {
		let text = "";
		const timer = setTimeout(
			() => reject(new Error(`CLI did not start: ${text}`)),
			10000,
		);
		const collect = (data) => {
			text += data;
			if (/Context explorer: http/.test(text) && /Warning:/.test(text)) {
				clearTimeout(timer);
				resolve(text);
			}
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
	});
	assert.match(output, /Serving @guisam\/agent-profiles-visualizer 9\.8\.7/);
	assert.match(output, /Warning: .*supports @guisam\/agent-profiles <0\.1\.0/);
});
