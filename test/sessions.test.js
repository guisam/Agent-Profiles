// #38 phase 7: session records. Opt-in (`mcp --record-sessions`,
// `resolve --record-session`), written only under AGENT_PROFILES_SESSIONS (or
// ~/.agent-profiles/sessions), never to the project or the store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { stringify } from "yaml";
import { publishPackage } from "../src/library.ts";
import { installDependencies } from "../src/package-lock.ts";
import {
	createSessionRecorder,
	formatSessions,
	listSessions,
} from "../src/sessions.ts";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const NAME = "@example/review";
const TUPLE = { model: "fictional-small", role: "reviewer", host: "claude" };

function put(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

function fixture(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-sessions-")),
	);
	const clients = [];
	t.after(async () => {
		for (const client of clients) await client.close();
		fs.rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	});
	const root = path.join(dir, "project");
	const store = path.join(dir, "store");
	const home = path.join(dir, "home");
	const sessions = path.join(dir, "sessions");
	fs.mkdirSync(home);
	const source = path.join(dir, "source");
	put(
		path.join(source, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: NAME, version: "1.0.0", type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(source, "SKILL.md"),
		"---\ndescription: Review.\n---\nReview it.\n",
	);
	publishPackage({ storeRoot: store, sourceDirectory: source });
	put(path.join(root, ".agent-profiles/profiles/base.md"), "# Base\n");
	put(path.join(root, ".agent-profiles/roles/reviewer.md"), "# Reviewer\n");
	put(
		path.join(root, ".agent-profiles/agents.yaml"),
		stringify({
			version: 2,
			default_profile: "base",
			default_role: "reviewer",
			models: { "fictional-small": { profile: "base" } },
			families: {},
			profiles: { base: { file: "profiles/base.md" } },
			roles: {
				reviewer: {
					file: "roles/reviewer.md",
					skills: { required: [], available: ["review"] },
				},
			},
			skills: { review: { package: NAME, version: "1.0.0" } },
		}),
	);
	installDependencies({ root, storeRoot: store });
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		AGENT_PROFILES_STORE: path.join(home, "ambient-store"),
		AGENT_PROFILES_SESSIONS: sessions,
		AGENT_PROFILES_TRUST: path.join(home, "no-trust.yaml"),
	};
	return { dir, root, store, home, sessions, env, clients };
}

async function connect(f, ...extra) {
	const client = new Client({ name: "sessions-test", version: "9.8.7" });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "mcp", "--root", f.root, "--store", f.store, ...extra],
			cwd: f.root,
			env: f.env,
			stderr: "pipe",
		}),
	);
	f.clients.push(client);
	return client;
}

function tree(directory) {
	const out = {};
	if (!fs.existsSync(directory)) return out;
	for (const entry of fs.readdirSync(directory, {
		recursive: true,
		withFileTypes: true,
	}))
		if (entry.isFile()) {
			const file = path.join(entry.parentPath ?? entry.path, entry.name);
			out[path.relative(directory, file)] = createHash("sha256")
				.update(fs.readFileSync(file))
				.digest("hex");
		}
	return out;
}

const records = (f) => {
	const saved = process.env.AGENT_PROFILES_SESSIONS;
	process.env.AGENT_PROFILES_SESSIONS = f.sessions;
	try {
		return listSessions({ root: f.root });
	} finally {
		if (saved === undefined) delete process.env.AGENT_PROFILES_SESSIONS;
		else process.env.AGENT_PROFILES_SESSIONS = saved;
	}
};

test("with --record-sessions, a bound server records its resolutions and nothing else", async (t) => {
	const f = fixture(t);
	const before = [f.root, f.store, f.home].map(tree);
	const client = await connect(
		f,
		"--record-sessions",
		"--model",
		TUPLE.model,
		"--host",
		TUPLE.host,
	);
	const stamp = /Stamp: sha256 ([0-9a-f]{64})/.exec(
		client.getInstructions(),
	)[1];
	await client.callTool({
		name: "resolve",
		arguments: { ...TUPLE, skills: ["review"] },
	});
	await client.callTool({ name: "explain", arguments: TUPLE });
	await client.close();

	const result = records(f);
	assert.equal(result.sessions.length, 1);
	const [session] = result.sessions;
	assert.equal(session.source, "mcp");
	assert.deepEqual(session.client, { name: "sessions-test", version: "9.8.7" });
	assert.deepEqual(
		session.resolutions.map((r) => r.via),
		["bound", "resolve", "explain"],
	);
	// The bound entry carries the same digest the instructions quote; the tool calls
	// name a role explicitly, which is part of the stamp, so theirs differ.
	assert.equal(session.resolutions[0].stamp, stamp);
	assert.equal(session.resolutions[1].stamp, session.resolutions[2].stamp);
	for (const entry of session.resolutions) {
		assert.match(entry.stamp, /^[0-9a-f]{64}$/);
		assert.equal(entry.root, f.root);
		assert.equal(entry.profile, "base");
		assert.deepEqual(
			entry.packages.map((p) => [p.skill, p.name, p.version]),
			[["review", NAME, "1.0.0"]],
		);
		assert.match(entry.packages[0].sha256, /^[0-9a-f]{64}$/);
	}
	assert.deepEqual(session.resolutions[1].requested, ["review"]);
	assert.match(
		formatSessions(result),
		/bound: reviewer × fictional-small × claude → base; stamp [0-9a-f]{64}/,
	);
	// The project, store and home are untouched; only the sessions folder changed.
	assert.deepEqual([f.root, f.store, f.home].map(tree), before);
});

test("without --record-sessions the server writes nothing", async (t) => {
	const f = fixture(t);
	const client = await connect(f, "--model", TUPLE.model);
	await client.callTool({ name: "resolve", arguments: TUPLE });
	await client.close();
	assert.equal(fs.existsSync(f.sessions), false);
});

test("resolve --record-session and the sessions command", (t) => {
	const f = fixture(t);
	const run = (...args) =>
		spawnSync(
			process.execPath,
			[
				cli,
				...args,
				"--root",
				f.root,
				...(args[0] === "sessions" ? [] : ["--store", f.store]),
			],
			{
				encoding: "utf8",
				env: f.env,
				cwd: f.root,
			},
		);
	const plain = run("resolve", "--model", TUPLE.model);
	assert.equal(plain.status, 0, plain.stderr);
	assert.equal(fs.existsSync(f.sessions), false);
	const recorded = run("resolve", "--model", TUPLE.model, "--record-session");
	assert.equal(recorded.status, 0, recorded.stderr);
	const listed = run("sessions", "--json");
	assert.equal(listed.status, 0, listed.stderr);
	const result = JSON.parse(listed.stdout);
	assert.equal(result.sessions.length, 1);
	assert.equal(result.sessions[0].source, "cli");
	assert.equal(result.sessions[0].resolutions[0].via, "cli");
	assert.match(run("sessions").stdout, /fictional-small/);
	const bad = run("stamp", "--model", TUPLE.model, "--record-session");
	assert.notEqual(bad.status, 0);
	assert.match(bad.stderr, /--record-session is only supported by resolve/);
});

test("records keep withheld skills; a write failure never fails the resolution", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-rec-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const saved = process.env.AGENT_PROFILES_SESSIONS;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_SESSIONS;
		else process.env.AGENT_PROFILES_SESSIONS = saved;
	});
	process.env.AGENT_PROFILES_SESSIONS = path.join(dir, "sessions");
	const resolution = {
		host: "claude",
		model: "m",
		role: "r",
		profile: "p",
		required: [],
		available: [],
		loaded: [],
		withheld: [
			{
				id: "review",
				package: { name: NAME, version: "1.0.0" },
				reason: "not approved",
			},
		],
	};
	const recorder = createSessionRecorder({
		source: "mcp",
		agentProfiles: "0.0.0",
	});
	recorder.record("resolve", { root: dir }, resolution);
	const listed = listSessions({ root: dir });
	assert.deepEqual(listed.sessions[0].resolutions[0].withheld, [
		{ id: "review", name: NAME, version: "1.0.0", reason: "not approved" },
	]);
	// A stamp that can't be computed is recorded as unavailable, not thrown.
	assert.equal(listed.sessions[0].resolutions[0].stamp, null);
	assert.ok(listed.sessions[0].resolutions[0].stampError);

	// An unwritable sessions folder: one warning, no throw.
	fs.writeFileSync(path.join(dir, "blocked"), "");
	process.env.AGENT_PROFILES_SESSIONS = path.join(dir, "blocked");
	const warnings = [];
	const blocked = createSessionRecorder({
		source: "mcp",
		agentProfiles: "0.0.0",
		warn: (message) => warnings.push(message),
	});
	blocked.record("resolve", { root: dir }, resolution);
	blocked.record("resolve", { root: dir }, resolution);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /session record not written/);

	// A corrupt record is reported, not fatal.
	process.env.AGENT_PROFILES_SESSIONS = path.join(dir, "sessions");
	const day = fs.readdirSync(path.join(dir, "sessions"))[0];
	fs.writeFileSync(path.join(dir, "sessions", day, "broken.json"), "{");
	assert.equal(listSessions({ root: dir }).problems.length, 1);
	assert.equal(listSessions({ root: dir }).sessions.length, 1);
});
