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
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { formatContext } from "../src/diagnostics.ts";
import { resolveInstructions } from "../src/resolve.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(project, "bin/agent-profiles.ts");
const version = JSON.parse(
	readFileSync(path.join(project, "package.json"), "utf8"),
).version;
const TOOLS = [
	"diff",
	"explain",
	"library_evidence",
	"library_info",
	"library_list",
	"library_read",
	"library_search",
	"outdated",
	"report",
	"resolve",
	"update_preview",
	"verify",
];

// A disposable repository (a copy of this project's example configuration),
// store and home, so nothing outside the temporary directory can change.
// Cleanup closes every server before removing the directory: Windows refuses to
// delete a directory that a running process uses as its working directory, and
// `t.after` hooks run in registration order.
function fixture(t) {
	const base = mkdtempSync(path.join(os.tmpdir(), "agent-profiles-mcp-"));
	const clients = [];
	t.after(async () => {
		for (const client of clients) await client.close();
		rmSync(base, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
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
	return { base, root, store, home, env, clients };
}

function run(f, ...args) {
	const result = spawnSync(process.execPath, [cli, ...args], {
		cwd: f.root,
		env: f.env,
		encoding: "utf8",
	});
	return result;
}

// `roots`: directories the client offers as workspace roots (declares the capability).
// `era: "modern"` pins protocol 2026-07-28; the default is the 2025 handshake.
async function connect(f, args = [], cwd = f.root, { roots, era } = {}) {
	const client = new Client(
		{ name: "agent-profiles-test", version: "1" },
		{
			...(roots ? { capabilities: { roots: {} } } : {}),
			...(era === "modern"
				? {
						versionNegotiation: { mode: { pin: "2026-07-28" } },
						inputRequired: { autoFulfill: true },
					}
				: {}),
		},
	);
	if (roots)
		client.setRequestHandler("roots/list", async () => ({
			roots: roots.map((directory) => ({
				uri: pathToFileURL(directory).href,
				name: path.basename(directory),
			})),
		}));
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", ...args],
			cwd,
			env: f.env,
			stderr: "pipe",
		}),
	);
	f.clients.push(client);
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
	const client = await connect(f, ["--root", f.root]);
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
	const client = await connect(f, ["--root", f.root]);
	const instructions = client.getInstructions();
	assert.match(instructions, /Call the `resolve` tool/);
	assert.match(instructions, /do not contain your profile/);
	assert.doesNotMatch(instructions, /# Agent Profiles context/);
});

// #80: hosts truncate server instructions (Claude Code cut a bound payload inside its
// first skill), so bound instructions stay a short bootstrap however large the profile.
test("bound instructions stay compact, embed no resolved text and require resolve", async (t) => {
	const f = fixture(t);
	const role = path.join(f.root, ".agent-profiles/roles/reviewer.md");
	const tail = "Final reviewer sentence: report every verification step.";
	writeFileSync(
		role,
		`${readFileSync(role, "utf8")}\n${"Check each claim against the code.\n".repeat(700)}${tail}\n`,
	);
	const args = [
		"--root",
		f.root,
		"--model",
		"example-model",
		"--role",
		"reviewer",
	];
	const client = await connect(f, args);
	const instructions = client.getInstructions();
	assert.ok(
		Buffer.byteLength(instructions) < 2048,
		`${Buffer.byteLength(instructions)} bytes`,
	);
	assert.match(
		instructions,
		/^# Agent Profiles \(bound: model example-model, role reviewer\)/,
	);
	assert.doesNotMatch(
		instructions,
		/# Agent Profiles context|Check each claim|do not call it again/,
	);
	assert.match(
		instructions,
		/Call `resolve` before any role work, and again after `\/clear`/,
	);
	assert.match(
		instructions,
		/lacks its final `End of Agent Profiles context:` line/,
	);

	// Delivery is the resolve output: complete, and ending with its checkable final line.
	const result = await client.callTool({ name: "resolve", arguments: {} });
	assert.ok(!result.isError, textOf(result));
	const body = textOf(result);
	assert.ok(body.length > 20000, String(body.length));
	assert.ok(body.includes(tail));
	assert.match(
		body.split("\n").at(-1),
		/^End of Agent Profiles context: \d+ section\(s\): .* reviewer,/,
	);
});

// #80 portable fixture: two required skills sized like the original report, each
// ending with a FIXTURE-FINAL line, with no store, trust policy or private package.
test("portable #80 fixture: bound instructions stay compact while resolve delivers every section", async (t) => {
	const f = fixture(t);
	const root = path.join(f.base, "issue-80");
	cpSync(
		fileURLToPath(new URL("./fixtures/issue-80/project", import.meta.url)),
		root,
		{ recursive: true },
	);
	const finals = [
		"FIXTURE-FINAL review-depth:",
		"FIXTURE-FINAL shared-language:",
	];
	const marker =
		"End of Agent Profiles context: 4 section(s): base, reviewer, review-depth, shared-language.";
	const selection = {
		root,
		host: "claude",
		model: "claude-opus-5-5",
		role: "reviewer",
	};

	// Large enough to expose truncation: the payload 0.19.2 embedded is several times the bound bootstrap.
	const full = formatContext(resolveInstructions(selection), {
		invocation: "mcp",
	});
	assert.ok(Buffer.byteLength(full) > 8192, String(Buffer.byteLength(full)));

	const client = await connect(f, [
		"--root",
		root,
		"--host",
		"claude",
		"--model",
		"claude-opus-5-5",
		"--role",
		"reviewer",
	]);
	const instructions = client.getInstructions();
	assert.ok(
		Buffer.byteLength(instructions) < 2048,
		String(Buffer.byteLength(instructions)),
	);
	for (const line of [...finals, "## 1. Scope"])
		assert.ok(!instructions.includes(line), line);

	const result = await client.callTool({ name: "resolve", arguments: {} });
	assert.ok(!result.isError, textOf(result));
	const body = textOf(result);
	assert.equal(body, full);
	for (const line of finals) assert.ok(body.includes(line), line);
	assert.ok(body.indexOf(finals[0]) < body.indexOf(finals[1]));
	assert.equal(body.split("\n").at(-1), marker);

	// The shell fallback renders the same bodies and the same final line.
	const shell = run(
		f,
		"resolve",
		"--root",
		root,
		"--host",
		"claude",
		"--identity-source",
		"host-stated",
		"--model",
		"claude-opus-5-5",
		"--role",
		"reviewer",
	);
	assert.equal(shell.status, 0, shell.stderr);
	for (const line of finals) assert.ok(shell.stdout.includes(line), line);
	assert.equal(shell.stdout.trimEnd().split("\n").at(-1), marker);
});

test("a bound server refuses selectors that conflict with its binding", async (t) => {
	const f = fixture(t);
	const client = await connect(f, [
		"--root",
		f.root,
		"--model",
		"example-model",
		"--role",
		"reviewer",
	]);
	for (const name of ["resolve", "explain"]) {
		const same = await client.callTool({
			name,
			arguments: { model: "example-model", role: "reviewer" },
		});
		assert.ok(!same.isError, textOf(same));
		const other = await client.callTool({
			name,
			arguments: { role: "implementer" },
		});
		assert.ok(other.isError, name);
		assert.match(textOf(other), /bound to role "reviewer"; omit role/);
	}
	// An unbound selector stays the agent's to supply.
	const roleOnly = await connect(f, ["--root", f.root, "--role", "reviewer"]);
	const supplied = await roleOnly.callTool({
		name: "resolve",
		arguments: { model: "example-model" },
	});
	assert.ok(!supplied.isError, textOf(supplied));
});

test("a failed bound resolution is reported in the instructions, not a crash", async (t) => {
	const f = fixture(t);
	const client = await connect(f, [
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
	const client = await connect(f, ["--root", f.root]);
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
	const client = await connect(f, ["--root", f.root]);
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
	const client = await connect(f, ["--root", f.root, "--store", f.store]);

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
	const client = await connect(f, ["--root", f.root, "--store", f.store]);
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
	const client = await connect(f, ["--root", f.root, "--store", f.store]);
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
	const client = await connect(f, [
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
	const client = await connect(f, [], outside);

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

test("bound instructions carry the session's stamp digest without writing it", async (t) => {
	const f = fixture(t);
	const args = [
		"--root",
		f.root,
		"--store",
		f.store,
		"--model",
		"example-model",
		"--role",
		"reviewer",
	];
	const before = tree(f.store);
	const first = await connect(f, args);
	const line = first.getInstructions().split("\n")[1];
	const match = /^Stamp: sha256 ([0-9a-f]{64}) \(not retained;/.exec(line);
	assert.ok(match, line);
	assert.deepEqual(tree(f.store), before);

	// The same selectors captured through the CLI record exactly that digest.
	const captured = run(
		f,
		"stamp",
		"--root",
		f.root,
		"--store",
		f.store,
		"--model",
		"example-model",
		"--role",
		"reviewer",
		"--json",
	);
	assert.equal(captured.status, 0, captured.stderr);
	assert.equal(JSON.parse(captured.stdout).digest, match[1]);

	const second = await connect(f, args);
	assert.equal(
		second.getInstructions().split("\n")[1],
		`Stamp: sha256 ${match[1]} (retained in the store; the \`verify\` tool reads it).`,
	);
	const verified = await second.callTool({
		name: "verify",
		arguments: { digest: match[1] },
	});
	assert.ok(!verified.isError, textOf(verified));
});

test("unbound instructions carry no stamp line", async (t) => {
	const f = fixture(t);
	const client = await connect(f, ["--root", f.root]);
	assert.doesNotMatch(client.getInstructions(), /^Stamp:/m);
});

for (const era of ["legacy", "modern"]) {
	test(`roots (${era} protocol): the configured workspace root selects the project`, async (t) => {
		const f = fixture(t);
		const outside = path.join(f.base, "elsewhere");
		const plain = path.join(f.base, "plain");
		mkdirSync(outside);
		mkdirSync(plain);
		const client = await connect(f, [], outside, {
			roots: [plain, f.root],
			era,
		});
		const result = await client.callTool({
			name: "resolve",
			arguments: { model: "example-model", role: "reviewer" },
		});
		assert.ok(!result.isError, textOf(result));
		assert.equal(
			textOf(result),
			formatContext(
				resolveInstructions({
					root: f.root,
					model: "example-model",
					role: "reviewer",
				}),
				{ invocation: "mcp" },
			),
		);
		const explained = await client.callTool({
			name: "explain",
			arguments: { model: "example-model" },
		});
		assert.ok(!explained.isError, textOf(explained));
	});

	test(`roots (${era} protocol): several configured roots are refused; none falls back to cwd`, async (t) => {
		const f = fixture(t);
		const other = path.join(f.base, "other");
		cpSync(
			path.join(f.root, ".agent-profiles"),
			path.join(other, ".agent-profiles"),
			{ recursive: true },
		);
		const outside = path.join(f.base, "elsewhere");
		mkdirSync(outside);
		const ambiguous = await connect(f, [], outside, {
			roots: [f.root, other],
			era,
		});
		const refused = await ambiguous.callTool({
			name: "resolve",
			arguments: { model: "example-model" },
		});
		assert.equal(refused.isError, true);
		assert.match(textOf(refused), /several workspace roots/);
		assert.match(textOf(refused), /pass root/);

		const unconfigured = await connect(f, [], outside, {
			roots: [outside],
			era,
		});
		const fallback = await unconfigured.callTool({
			name: "resolve",
			arguments: { model: "example-model" },
		});
		assert.equal(fallback.isError, true);
		assert.match(textOf(fallback), /--root/);
	});
}

test("roots: --root and a root argument take precedence over workspace roots", async (t) => {
	const f = fixture(t);
	const other = path.join(f.base, "other");
	cpSync(
		path.join(f.root, ".agent-profiles"),
		path.join(other, ".agent-profiles"),
		{ recursive: true },
	);
	// Both roots configured would be ambiguous, so success proves roots were not consulted.
	const pinned = await connect(f, ["--root", f.root], f.base, {
		roots: [f.root, other],
	});
	const viaFlag = await pinned.callTool({
		name: "resolve",
		arguments: { model: "example-model" },
	});
	assert.ok(!viaFlag.isError, textOf(viaFlag));
	const open = await connect(f, [], f.base, { roots: [f.root, other] });
	const viaArgument = await open.callTool({
		name: "resolve",
		arguments: { model: "example-model", root: other },
	});
	assert.ok(!viaArgument.isError, textOf(viaArgument));
});
