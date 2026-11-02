import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { formatContext } from "../src/diagnostics.ts";
import { resolveInstructions } from "../src/resolve.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(project, "bin/agent-profiles.ts");
const version = JSON.parse(
	readFileSync(path.join(project, "package.json"), "utf8"),
).version;
const TOOLS = ["diff", "explain", "report", "resolve", "verify"];

// A disposable repository (a copy of this project's example configuration),
// store and home, so nothing outside the temporary directory can change.
function fixture(t) {
	const base = mkdtempSync(path.join(os.tmpdir(), "agent-profiles-mcp-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "repo");
	const store = path.join(base, "store");
	const home = path.join(base, "home");
	mkdirSync(root);
	mkdirSync(home);
	cpSync(
		path.join(project, ".agent-profiles"),
		path.join(root, ".agent-profiles"),
		{ recursive: true },
	);
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		AGENT_PROFILES_STORE: path.join(home, "ambient-store"),
	};
	return { base, root, store, home, env };
}

function run(f, ...args) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd: f.root,
		env: f.env,
		encoding: "utf8",
	});
	return result;
}

async function connect(t, f, args = [], cwd = f.root) {
	const client = new Client({ name: "agent-profiles-test", version: "1" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", ...args],
			cwd,
			env: f.env,
			stderr: "pipe",
		}),
	);
	t.after(() => client.close());
	return client;
}

function tree(directory) {
	const out = {};
	if (!existsSync(directory)) return out;
	const walk = (dir) => {
		for (const name of readdirSync(dir).sort()) {
			const file = path.join(dir, name);
			if (statSync(file).isDirectory()) walk(file);
			else
				out[path.relative(directory, file)] = createHash("sha256")
					.update(readFileSync(file))
					.digest("hex");
		}
	};
	walk(directory);
	return out;
}

const textOf = (result) => result.content.map((part) => part.text).join("");

function stamp(f, model, role) {
	const result = run(
		f,
		"stamp",
		"--root",
		f.root,
		"--store",
		f.store,
		"--model",
		model,
		"--identity-source",
		"user",
		"--role",
		role,
		"--json",
	);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout).digest;
}

test("lists exactly the read-only tools and reports the package version", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, ["--root", f.root]);
	assert.deepEqual(client.getServerVersion(), {
		name: "agent-profiles",
		version,
	});
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOLS);
	for (const tool of tools) {
		assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
		assert.equal(tool.annotations?.destructiveHint, false, tool.name);
	}
});

test("unbound instructions point to the resolve tool", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, ["--root", f.root]);
	const instructions = client.getInstructions();
	assert.match(instructions, /call the `resolve` tool/);
	assert.doesNotMatch(instructions, /# Agent Profiles context/);
});

test("bound instructions carry the session's resolved profile", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, [
		"--root",
		f.root,
		"--model",
		"example-model",
		"--role",
		"reviewer",
	]);
	const expected = formatContext(
		resolveInstructions({
			root: f.root,
			model: "example-model",
			role: "reviewer",
		}),
		{ invocation: "mcp" },
	);
	const instructions = client.getInstructions();
	assert.ok(instructions.endsWith(expected));
	assert.match(instructions, /do not call it again unless/);
});

test("a failed bound resolution is reported in the instructions, not a crash", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, [
		"--root",
		f.root,
		"--model",
		"example-model",
		"--role",
		"no-such-role",
	]);
	assert.match(client.getInstructions(), /Resolution at server start failed/);
	assert.deepEqual((await client.listTools()).tools.length, TOOLS.length);
});

test("resolve returns the MCP rendering and never shell commands", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, ["--root", f.root]);
	const result = await client.callTool({
		name: "resolve",
		arguments: { model: "example-model", role: "reviewer" },
	});
	assert.ok(!result.isError, textOf(result));
	const expected = formatContext(
		resolveInstructions({
			root: f.root,
			model: "example-model",
			role: "reviewer",
		}),
		{ invocation: "mcp" },
	);
	assert.equal(textOf(result), expected);
	assert.doesNotMatch(textOf(result), /Command \(/);
	assert.match(textOf(result), /Call the Agent Profiles `resolve` tool again/);
});

test("the CLI rendering of resolve is unchanged", () => {
	const root = project;
	const cliText = formatContext(
		resolveInstructions({ root, model: "example-model" }),
	);
	assert.match(cliText, /Command \(/);
	assert.doesNotMatch(cliText, /Agent Profiles `resolve` tool/);
});

test("explain matches resolve --json", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, ["--root", f.root]);
	const result = await client.callTool({
		name: "explain",
		arguments: { model: "example-model", role: "reviewer" },
	});
	assert.ok(!result.isError, textOf(result));
	const cliResult = run(
		f,
		"resolve",
		"--root",
		f.root,
		"--model",
		"example-model",
		"--role",
		"reviewer",
		"--json",
	);
	assert.equal(cliResult.status, 0, cliResult.stderr);
	assert.deepEqual(result.structuredContent, JSON.parse(cliResult.stdout));
	assert.deepEqual(JSON.parse(textOf(result)), JSON.parse(cliResult.stdout));
});

test("verify and diff match the CLI on real stamps", async (t) => {
	const f = fixture(t);
	const first = stamp(f, "example-model", "reviewer");
	const second = stamp(f, "other-model", "implementer");
	const client = await connect(t, f, ["--root", f.root, "--store", f.store]);

	const verified = await client.callTool({
		name: "verify",
		arguments: { digest: first },
	});
	const cliVerify = run(f, "verify", first, "--store", f.store, "--json");
	assert.deepEqual(verified.structuredContent, JSON.parse(cliVerify.stdout));

	const diffed = await client.callTool({
		name: "diff",
		arguments: { before: first, after: second },
	});
	const cliDiff = run(f, "diff", first, second, "--store", f.store, "--json");
	assert.deepEqual(diffed.structuredContent, JSON.parse(cliDiff.stdout));
	assert.ok(diffed.structuredContent.changes.length > 0);
});

test("report errors match the CLI", async (t) => {
	const f = fixture(t);
	stamp(f, "example-model", "reviewer");
	const client = await connect(t, f, ["--root", f.root, "--store", f.store]);
	const result = await client.callTool({
		name: "report",
		arguments: { resultId: "missing-result" },
	});
	assert.equal(result.isError, true);
	const cliReport = run(
		f,
		"migrate",
		"report",
		"missing-result",
		"--store",
		f.store,
		"--json",
	);
	assert.equal(cliReport.status, 1);
	assert.equal(textOf(result), cliReport.stderr.trim());
});

test("invalid arguments are rejected before any operation runs", async (t) => {
	const f = fixture(t);
	const client = await connect(t, f, ["--root", f.root, "--store", f.store]);
	const result = await client.callTool({
		name: "verify",
		arguments: { digest: "not-a-digest" },
	});
	assert.equal(result.isError, true);
	assert.match(textOf(result), /SHA-256/);
});

test("no tool writes to the repository, store or home", async (t) => {
	const f = fixture(t);
	const first = stamp(f, "example-model", "reviewer");
	const second = stamp(f, "other-model", "implementer");
	const before = {
		repo: tree(f.root),
		store: tree(f.store),
		home: tree(f.home),
	};
	const client = await connect(t, f, [
		"--root",
		f.root,
		"--store",
		f.store,
		"--model",
		"example-model",
	]);
	const calls = [
		["resolve", { model: "example-model", role: "reviewer" }],
		["explain", { model: "other-model" }],
		["verify", { digest: first }],
		["diff", { before: first, after: second }],
		["report", { resultId: "missing-result" }],
	];
	for (const [name, args] of calls)
		await client.callTool({ name, arguments: args });
	await client.close();
	assert.deepEqual(
		{ repo: tree(f.root), store: tree(f.store), home: tree(f.home) },
		before,
	);
	assert.ok(!existsSync(path.join(f.home, "ambient-store")));
});

test("roots: a tool argument overrides --root; missing roots are refused", async (t) => {
	const f = fixture(t);
	const outside = path.join(f.base, "not-a-repo");
	mkdirSync(outside);
	const client = await connect(t, f, [], outside);

	const noRoot = await client.callTool({
		name: "resolve",
		arguments: { model: "example-model" },
	});
	assert.equal(noRoot.isError, true);
	assert.match(textOf(noRoot), /--root/);

	const missing = await client.callTool({
		name: "resolve",
		arguments: { model: "example-model", root: path.join(f.base, "absent") },
	});
	assert.equal(missing.isError, true);
	assert.match(textOf(missing), /root is not a directory/);

	const explicit = await client.callTool({
		name: "resolve",
		arguments: { model: "example-model", root: f.root },
	});
	assert.ok(!explicit.isError, textOf(explicit));
});

test("the mcp command validates its options", (t) => {
	const f = fixture(t);
	const extra = run(f, "mcp", "extra");
	assert.equal(extra.status, 1);
	assert.match(extra.stderr, /accepts no positional arguments/);
	const json = run(f, "mcp", "--json");
	assert.equal(json.status, 1);
	assert.match(json.stderr, /--json is not supported by mcp/);
	const twoRoles = run(f, "mcp", "--role", "a", "--role", "b");
	assert.equal(twoRoles.status, 1);
	assert.match(twoRoles.stderr, /one --role/);
});
