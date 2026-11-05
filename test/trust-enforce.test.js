// #71 part 3: enforcement. With require_approval, resolve withholds unapproved
// packaged skills (the session still resolves), and install and update --apply
// refuse. Namespace and effects limits apply whenever a policy exists. With a
// policy but no signing_key, update --apply and library publish need a terminal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatContext } from "../src/diagnostics.ts";
import { applyUpdate, formatUpdate, previewUpdate } from "../src/outdated.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { approve, fixture, NAME, noKeygen } from "./helpers/trust-fixture.js";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));
const TUPLE = { role: "reviewer", model: "fictional-small", host: "claude" };

const resolve = (f, extra = {}) =>
	resolveInstructions({ root: f.root, storeRoot: f.store, ...TUPLE, ...extra });
const update = (f, extra = {}) => ({
	root: f.root,
	storeRoot: f.store,
	binding: "skills.review",
	version: "1.1.0",
	assignment: TUPLE,
	...extra,
});
const run = (f, args, env = {}) =>
	spawnSync(process.execPath, [cli, ...args, "--store", f.store], {
		encoding: "utf8",
		cwd: f.root,
		env: { ...process.env, AGENT_PROFILES_TRUST: f.trust, ...env },
	});

test("without require_approval, resolve loads the skill and reports no withheld list", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t);
	const result = resolve(f);
	assert.deepEqual(result.withheld, []);
	assert.ok(result.loaded.some((entry) => entry.id === "review"));
});

test("with require_approval, resolve withholds an unapproved skill and still resolves", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { require_approval: true } });
	const result = resolve(f);
	assert.equal(result.profile, "base");
	assert.ok(!result.loaded.some((entry) => entry.id === "review"));
	assert.ok(!result.required.some((entry) => entry.id === "review"));
	assert.deepEqual(result.withheld, [
		{
			id: "review",
			package: { name: NAME, version: "1.0.0" },
			reason: "not approved (require_approval is on)",
		},
	]);
	const text = formatContext(result);
	assert.match(text, /## Withheld by the trust policy/);
	assert.match(text, /- review \(@example\/review@1\.0\.0\): not approved/);
	assert.match(text, /Don't look for their text elsewhere/);
	assert.doesNotMatch(text, /# 1\.0\.0/);

	approve(f, "1.0.0");
	const approved = resolve(f);
	assert.deepEqual(approved.withheld, []);
	assert.ok(approved.loaded.some((entry) => entry.id === "review"));
	assert.match(formatContext(approved), /# 1\.0\.0/);
});

test("namespace and effects limits withhold even without require_approval", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { namespaces: ["@trusted/*"] } });
	assert.match(
		resolve(f).withheld[0].reason,
		/namespace of @example\/review is not allowed/,
	);
	const g = fixture(t, {
		policy: { effects: [] },
		effects: ["substitution"],
	});
	assert.match(
		resolve(g).withheld[0]?.reason ?? "",
		/effects not allowed: substitution/,
	);
});

test("update --apply refuses an unapproved target; the preview says so", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { require_approval: true } });
	const preview = previewUpdate(update(f));
	assert.deepEqual(preview.trustBlockers, [
		`${NAME}@1.1.0: not approved (require_approval is on)`,
	]);
	assert.match(
		formatUpdate(preview),
		/Apply will be refused by the trust policy/,
	);
	const before = fs.readFileSync(
		path.join(f.root, ".agent-profiles/agents.yaml"),
	);
	assert.throws(
		() => applyUpdate(update(f)),
		/update: the trust policy refuses .*nothing was written/,
	);
	assert.deepEqual(
		fs.readFileSync(path.join(f.root, ".agent-profiles/agents.yaml")),
		before,
	);

	approve(f, "1.1.0");
	assert.deepEqual(previewUpdate(update(f)).trustBlockers, []);
	assert.equal(applyUpdate(update(f)).status, "updated");
	assert.deepEqual(
		resolve(f).loaded.find((entry) => entry.id === "review")?.package?.version,
		"1.1.0",
	);
});

test("install refuses unapproved pins under require_approval", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { require_approval: true } });
	const refused = run(f, ["install", "--root", f.root]);
	assert.notEqual(refused.status, 0);
	assert.match(
		refused.stderr,
		/install: the trust policy refuses @example\/review@1\.0\.0: not approved/,
	);
	approve(f, "1.0.0");
	const ok = run(f, ["install", "--root", f.root]);
	assert.equal(ok.status, 0, ok.stderr);
});

test("with a policy but no signing_key, apply and publish need a terminal", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { signingKey: false });
	const apply = run(f, [
		"update",
		"skills.review",
		"1.1.0",
		"--role",
		TUPLE.role,
		"--model",
		TUPLE.model,
		"--host",
		TUPLE.host,
		"--root",
		f.root,
		"--apply",
	]);
	assert.notEqual(apply.status, 0);
	assert.match(
		apply.stderr,
		/needs confirmation on a terminal: your trust policy .* names no signing_key/,
	);
	const publish = run(f, [
		"library",
		"publish",
		path.join(f.dir, "sources", "1.1.0"),
	]);
	assert.notEqual(publish.status, 0);
	assert.match(
		publish.stderr,
		/library publish needs confirmation on a terminal/,
	);

	// With a signing_key configured, no confirmation is asked.
	const g = fixture(t);
	const published = run(g, [
		"library",
		"publish",
		path.join(g.dir, "sources", "1.1.0"),
	]);
	assert.equal(published.status, 0, published.stderr);
	// Without any policy, nothing changes.
	const free = run(
		g,
		["library", "publish", path.join(g.dir, "sources", "1.1.0")],
		{
			AGENT_PROFILES_TRUST: path.join(g.dir, "absent.yaml"),
		},
	);
	assert.equal(free.status, 0, free.stderr);
});

test("the MCP resolve rendering withholds the same way", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { require_approval: true } });
	const text = formatContext(resolve(f), { invocation: "mcp" });
	assert.match(text, /## Withheld by the trust policy/);
	assert.doesNotMatch(text, /Load by binding ID/);
});
