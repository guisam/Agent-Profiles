import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { doctor, install } from "../src/install.ts";
import { publishPackage } from "../src/library.ts";
import * as migrations from "../src/migrations.ts";
import {
	claudeHookOutput,
	noticeFingerprint,
	noticeLevel,
	updateNotice,
	updateSummary,
} from "../src/notice.ts";
import { applyUpdate } from "../src/outdated.ts";
import { installDependencies } from "../src/package-lock.ts";
import {
	decision,
	fixture as promotionFixture,
	put,
	release,
	scope,
	versions,
	writeDecision,
} from "./helpers/promotion-fixture.js";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const NAME = "@example/security-review";

function source(dir, version) {
	const directory = path.join(dir, "sources", version);
	put(
		path.join(directory, "package.yaml"),
		stringify({
			schema_version: 1,
			package: { name: NAME, version, type: "skill" },
			entrypoint: "SKILL.md",
			behavior: { delivery: "instruction", hosts: [], effects: [] },
		}),
	);
	put(
		path.join(directory, "SKILL.md"),
		`---\ndescription: x\n---\n${version}\n`,
	);
	return directory;
}

// A v2 project pinning 1.0.0, with 2.0.0 also in the library (newer, untested).
function project(t) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-notice-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project");
	const store = path.join(dir, "store");
	const state = path.join(dir, "home", ".agent-profiles", "notices");
	for (const version of ["1.0.0", "2.0.0"])
		publishPackage({ storeRoot: store, sourceDirectory: source(dir, version) });
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
					skills: { required: ["security-review"], available: [] },
				},
			},
			skills: { "security-review": { package: NAME, version: "1.0.0" } },
		}),
	);
	installDependencies({ root, storeRoot: store });
	return { dir, root, store, state, home: path.join(dir, "home") };
}

const files = (root) =>
	fs.readdirSync(root, { recursive: true }).map(String).sort();

test("noticeLevel reads AGENT_PROFILES_NOTICE strictly", () => {
	assert.equal(noticeLevel(undefined), "all");
	assert.equal(noticeLevel(""), "all");
	assert.equal(noticeLevel("actionable"), "actionable");
	assert.equal(noticeLevel("off"), "off");
	assert.throws(() => noticeLevel("loud"), /expected all, actionable or off/);
});

test("the notice shows once, stays silent while unchanged, and is rate limited", (t) => {
	const f = project(t);
	const projectFiles = files(f.root);
	const now = new Date("2026-11-03T09:00:00Z");
	const notice = (when = now) =>
		updateNotice({
			root: f.root,
			storeRoot: f.store,
			stateRoot: f.state,
			now: when,
			level: "all",
		});
	const first = notice();
	assert.equal(first.status, "notified");
	assert.deepEqual(first.lines, [
		"Agent Profiles: library updates for this project",
		"- 1 pin has newer versions without evidence for the tuples it serves.",
		"Run agent-profiles outdated for details; nothing was changed.",
	]);
	assert.deepEqual(
		files(f.root),
		projectFiles,
		"state never goes in the repository",
	);
	assert.equal(fs.readdirSync(f.state).length, 1);

	assert.equal(notice().status, "silent");
	assert.equal(notice().reason, "unchanged since the last notice");

	// The library changes the same day: suppressed, and the fingerprint is not consumed.
	publishPackage({
		storeRoot: f.store,
		sourceDirectory: source(f.dir, "3.0.0"),
	});
	assert.equal(notice(new Date("2026-11-03T20:00:00Z")).status, "suppressed");
	assert.equal(notice(new Date("2026-11-04T10:00:00Z")).status, "notified");
	assert.equal(notice(new Date("2026-11-04T11:00:00Z")).status, "silent");
});

test("levels: off is silent; actionable hides the informational count", (t) => {
	const f = project(t);
	const base = { root: f.root, storeRoot: f.store, stateRoot: f.state };
	assert.equal(updateNotice({ ...base, level: "off" }).reason, "off");
	assert.equal(fs.existsSync(f.state), false);
	const quiet = updateNotice({ ...base, level: "actionable" });
	assert.equal(quiet.status, "silent");
	assert.equal(quiet.reason, "nothing to report");
	// Nothing to report still records the fingerprint, so the next check is cheap.
	assert.equal(
		updateNotice({ ...base, level: "actionable" }).reason,
		"unchanged since the last notice",
	);
});

test("a project without package pins never notifies", (t) => {
	const f = project(t);
	const config = path.join(f.root, ".agent-profiles/agents.yaml");
	fs.writeFileSync(
		config,
		fs
			.readFileSync(config, "utf8")
			.replace(/skills:\n {2}security-review:[\s\S]*$/, "skills: {}\n")
			.replace("required:\n        - security-review", "required: []"),
	);
	const result = updateNotice({
		root: f.root,
		storeRoot: f.store,
		stateRoot: f.state,
	});
	assert.equal(result.reason, "no package pins");
});

test("the fingerprint depends on store index names and the project's config and lock", (t) => {
	const f = project(t);
	const before = noticeFingerprint(f.root, f.store);
	assert.equal(noticeFingerprint(f.root, f.store), before);
	publishPackage({
		storeRoot: f.store,
		sourceDirectory: source(f.dir, "4.0.0"),
	});
	const published = noticeFingerprint(f.root, f.store);
	assert.notEqual(published, before);
	fs.appendFileSync(
		path.join(f.root, ".agent-profiles/agents.yaml"),
		"# edit\n",
	);
	assert.notEqual(noticeFingerprint(f.root, f.store), published);
});

test("promoted evidence for a served tuple is actionable", (t) => {
	const f = promotionFixture(t);
	writeDecision(f, decision(f));
	migrations.applyMigrationPromotion({
		root: f.root,
		storeRoot: f.storeRoot,
		decisionFile: f.decisionFile,
	});
	// Move local-llm back to an older pin: the promoted release is now newer, with evidence for it.
	applyUpdate({
		root: f.root,
		storeRoot: f.storeRoot,
		binding: "skills.reviewer",
		version: versions[1],
		assignment: scope,
	});
	const summary = updateSummary({ root: f.root, storeRoot: f.storeRoot });
	assert.deepEqual(summary.actionable, [
		`skills.reviewer for worker × local-llm × claude: ${release.name}@${versions[1]} → ${release.version} has promoted evidence`,
	]);
	const check = spawnSync(
		process.execPath,
		[cli, "outdated", "--check", "--root", f.root, "--store", f.storeRoot],
		{ encoding: "utf8" },
	);
	assert.equal(check.status, 1, check.stderr);
	assert.match(check.stdout, /has promoted evidence/);
});

test("outdated --check exits 0 when nothing is actionable", (t) => {
	const f = project(t);
	const run = (...extra) =>
		spawnSync(
			process.execPath,
			[
				cli,
				"outdated",
				"--check",
				"--root",
				f.root,
				"--store",
				f.store,
				...extra,
			],
			{ encoding: "utf8" },
		);
	const informational = run();
	assert.equal(informational.status, 0, informational.stderr);
	assert.match(
		informational.stdout,
		/1 pin has newer versions without evidence/,
	);
	const json = JSON.parse(run("--json").stdout);
	assert.deepEqual(json.actionable, []);
	assert.equal(json.informational, 1);
});

test("the Claude hook output is user-facing only and never fails", () => {
	const notified = () => ({
		status: "notified",
		reason: "changed",
		lines: ["a", "b"],
	});
	const output = JSON.parse(
		claudeHookOutput(JSON.stringify({ source: "startup" }), notified),
	);
	assert.deepEqual(output, { systemMessage: "a\nb", suppressOutput: true });
	assert.equal("hookSpecificOutput" in output, false);
	for (const source of ["clear", "compact", "resume"])
		assert.equal(claudeHookOutput(JSON.stringify({ source }), notified), "");
	assert.equal(
		claudeHookOutput("{}", () => ({
			status: "silent",
			reason: "x",
			lines: [],
		})),
		"",
	);
	assert.equal(
		claudeHookOutput("{}", () => {
			throw new Error("boom");
		}),
		"",
	);
	assert.equal(claudeHookOutput("not json", notified), "");
});

test("CLI: notice --hook claude prints once, then nothing, and exits 0 even on errors", (t) => {
	const f = project(t);
	const hook = (input, root = f.root) =>
		spawnSync(
			process.execPath,
			[cli, "notice", "--hook", "claude", "--root", root, "--store", f.store],
			{
				encoding: "utf8",
				input,
				env: { ...process.env, HOME: f.home, USERPROFILE: f.home },
			},
		);
	const first = hook(JSON.stringify({ source: "startup" }));
	assert.equal(first.status, 0, first.stderr);
	assert.match(
		JSON.parse(first.stdout).systemMessage,
		/library updates for this project/,
	);
	assert.ok(fs.existsSync(f.state), "state in the machine-local home");
	assert.equal(hook(JSON.stringify({ source: "startup" })).stdout, "");
	assert.equal(hook(JSON.stringify({ source: "clear" })).stdout, "");
	const broken = hook(
		JSON.stringify({ source: "startup" }),
		path.join(f.dir, "absent"),
	);
	assert.equal(broken.status, 0);
	assert.equal(broken.stdout, "");
	const bad = spawnSync(process.execPath, [cli, "notice", "--hook", "codex"], {
		encoding: "utf8",
	});
	assert.equal(bad.status, 1);
	assert.match(bad.stderr, /only claude is supported/);
});

test("doctor reports updates and a missing notice hook", (t) => {
	const f = project(t);
	fs.mkdirSync(path.join(f.root, ".git"));
	install({ root: f.root, agents: ["claude"], storeRoot: f.store });
	const report = doctor(f.root, { storeRoot: f.store });
	assert.deepEqual(report.updates, { actionable: [], informational: 1 });
	assert.ok(!report.notes.some((note) => /update-notice hook/.test(note)));
	const settings = path.join(f.root, ".claude/settings.json");
	const parsed = JSON.parse(fs.readFileSync(settings, "utf8"));
	delete parsed.hooks;
	fs.writeFileSync(settings, JSON.stringify(parsed));
	assert.ok(
		doctor(f.root, { storeRoot: f.store }).notes.some((note) =>
			/SessionStart \(startup\) update-notice hook is not installed; run init/.test(
				note,
			),
		),
	);
	const shown = spawnSync(
		process.execPath,
		[cli, "doctor", "--root", f.root, "--store", f.store],
		{ encoding: "utf8" },
	);
	assert.match(
		shown.stdout,
		/Updates: 0 actionable, 1 without evidence for their tuples/,
	);
});
