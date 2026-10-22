import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConfiguration } from "../src/configure.ts";
import { installDependencies } from "../src/package-lock.js";
import { importPackage } from "../src/package-store.js";
import { readPackage } from "../src/packages.ts";
import * as resolver from "../src/resolve.ts";

function fixture(t) {
	const owned = fs.mkdtempSync(
		path.join(os.tmpdir(), "package-configuration-"),
	);
	t.after(() => fs.rmSync(owned, { recursive: true, force: true }));
	const root = path.join(owned, "project"),
		source = path.join(owned, "source"),
		storeRoot = path.join(owned, "store");
	fs.mkdirSync(path.join(root, ".agent-profiles/roles"), { recursive: true });
	fs.mkdirSync(source);
	fs.mkdirSync(storeRoot);
	fs.writeFileSync(
		path.join(root, ".agent-profiles/roles/reviewer.md"),
		"Local reviewer\n",
	);
	fs.writeFileSync(
		path.join(source, "package.yaml"),
		'schema_version: 1\npackage:\n  name: "@probe/context"\n  version: "1.0.0"\n  type: instruction\nentrypoint: ENTRY.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n',
	);
	fs.writeFileSync(path.join(source, "ENTRY.md"), "Real package bytes\n");
	const config = {
		version: 2,
		default_profile: "context",
		default_role: "reviewer",
		models: {},
		families: {},
		profiles: { context: { package: "@probe/context", version: "1.0.0" } },
		roles: {
			reviewer: {
				file: "roles/reviewer.md",
				skills: { required: [], available: [] },
			},
		},
	};
	const save = () =>
		fs.writeFileSync(
			path.join(root, ".agent-profiles/agents.yaml"),
			JSON.stringify(config),
		);
	save();
	const record = readPackage({ root: source });
	return { root, source, storeRoot, config, save, record };
}

test("shared configuration validation accepts real package declarations with an empty store", (t) => {
	const f = fixture(t);
	assert.equal(f.record.manifest.package.name, "@probe/context");
	assert.equal(
		typeof resolver.validateConfiguration,
		"function",
		"missing shared configuration validation",
	);
	const validated = resolver.validateConfiguration({ root: f.root });
	assert.equal(
		validated.bindings.get("profiles.context").source.get("package"),
		"@probe/context",
	);
	assert.deepEqual(fs.readdirSync(f.storeRoot), []);
	assert.throws(
		() => resolver.resolveInstructions({ ...f, lockMode: "validation" }),
		/missing-package/,
	);
	// Public required selection refuses the missing lock before any package lookup.
	assert.throws(
		() => resolver.resolveInstructions(f),
		(error) =>
			/agent-profiles\.lock/.test(error.message) &&
			!/missing-package/.test(error.message),
	);
});

test("late invalid role description is diagnosed before missing package lookup", (t) => {
	const f = fixture(t);
	f.config.roles.reviewer.description = 42;
	f.save();
	assert.throws(
		() => resolver.resolveInstructions(f),
		/roles.reviewer.description: expected a string/,
	);
	assert.deepEqual(fs.readdirSync(f.storeRoot), []);
});

test("invalid complete configuration preserves project and store despite a valid early source", async (t) => {
	const f = fixture(t);
	f.config.roles.reviewer.description = 42;
	f.save();
	const before = fs.readFileSync(
		path.join(f.root, ".agent-profiles/agents.yaml"),
	);
	const url = new URL("../src/package-lock.js", import.meta.url);
	let installer;
	try {
		installer = await import(url.href);
	} catch (error) {
		if (error.code !== "ERR_MODULE_NOT_FOUND" || error.url !== url.href)
			throw error;
	}
	assert.equal(
		typeof installer?.installDependencies,
		"function",
		"missing installer",
	);
	await assert.rejects(
		async () =>
			installer.installDependencies({
				root: f.root,
				storeRoot: f.storeRoot,
				sources: [
					{ name: "@probe/context", version: "1.0.0", directory: f.source },
				],
			}),
		/roles.reviewer.description: expected a string/,
	);
	assert.deepEqual(
		fs.readFileSync(path.join(f.root, ".agent-profiles/agents.yaml")),
		before,
	);
	assert.equal(
		fs.existsSync(path.join(f.root, ".agent-profiles/agent-profiles.lock")),
		false,
	);
	assert.deepEqual(fs.readdirSync(f.storeRoot), []);
	assert.equal(readPackage({ root: f.source }).sha256, f.record.sha256);
});

test("resolver and configuration caller still require verified real package bytes", (t) => {
	const f = fixture(t);
	assert.throws(
		() => readConfiguration(f.root, { storeRoot: f.storeRoot }),
		/missing-package/,
	);
	importPackage({
		sourceDirectory: f.source,
		storeRoot: f.storeRoot,
		expectedDigest: f.record.sha256,
	});
	installDependencies({ root: f.root, storeRoot: f.storeRoot });
	const result = resolver.resolveInstructions(f);
	assert.equal(result.loaded[0].content, "Real package bytes\n");
	assert.equal(result.loaded[0].package.sha256, f.record.sha256);
	assert.equal(
		readConfiguration(f.root, { storeRoot: f.storeRoot }).configuration.get(
			"version",
		),
		2,
	);
	assert.throws(
		() => resolver.resolveInstructions({ ...f, role: "unknown" }),
		/role: unknown is not declared/,
	);
});
