// #71 part 2: `library approve` signs an approval with ssh-keygen, the project keeps
// it under .agent-profiles/approvals/, and library info, outdated and update previews
// report the status. Uses the machine's ssh-keygen (GitHub runners have one).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	APPROVALS,
	approvalStatus,
	approvePackage,
	canonicalPayload,
	formatApproval,
} from "../src/approvals.ts";
import { doctor, install } from "../src/install.ts";
import { guardedCommands } from "../src/integrations.ts";
import { formatLibraryInfo, libraryInfo } from "../src/library.ts";
import {
	formatOutdated,
	formatUpdate,
	outdatedPins,
	previewUpdate,
} from "../src/outdated.ts";
import { approve, fixture, NAME, noKeygen } from "./helpers/trust-fixture.js";

const cli = fileURLToPath(new URL("../bin/agent-profiles.ts", import.meta.url));

test("approve signs the version's digest; status, info, outdated and preview show it", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t);
	assert.equal(
		approvalStatus({
			root: f.root,
			storeRoot: f.store,
			name: NAME,
			version: "1.1.0",
		}).status,
		"unapproved",
	);
	const result = approve(f);
	assert.equal(result.principal, "samson@example.com");
	assert.deepEqual(result.files, [
		`${APPROVALS}/@example/review/1.1.0/samson@example.com.json`,
		`${APPROVALS}/@example/review/1.1.0/samson@example.com.json.sig`,
	]);
	assert.match(formatApproval(result), /commit them with the project/);
	const payload = JSON.parse(
		fs.readFileSync(path.join(f.root, result.files[0]), "utf8"),
	);
	assert.equal(payload.sha256, result.sha256);
	assert.equal(payload.approvedAt, "2026-11-05T12:00:00Z");

	const status = approvalStatus({
		root: f.root,
		storeRoot: f.store,
		name: NAME,
		version: "1.1.0",
	});
	assert.equal(status.status, "approved");
	assert.equal(status.approvedBy[0].principal, "samson@example.com");
	assert.deepEqual(status.problems, []);

	const info = libraryInfo({ storeRoot: f.store, name: NAME, root: f.root });
	assert.deepEqual(
		info.approvals.map((row) => [row.version, row.status]),
		[
			["1.1.0", "approved"],
			["1.0.0", "unapproved"],
		],
	);
	assert.match(
		formatLibraryInfo(info),
		/Approval: approved by samson@example\.com \(key\)/,
	);
	assert.match(formatLibraryInfo(info), /Approval: not approved/);

	const outdated = outdatedPins({ root: f.root, storeRoot: f.store });
	assert.equal(outdated.pins[0].newer[0].approval.status, "approved");
	assert.match(
		formatOutdated(outdated),
		/Newer: 1\.1\.0\n {4}Approval: approved by samson/,
	);

	const preview = previewUpdate({
		root: f.root,
		storeRoot: f.store,
		binding: "skills.review",
		version: "1.1.0",
		assignment: { role: "reviewer", model: "fictional-small", host: "claude" },
	});
	assert.equal(preview.approval.status, "approved");
	assert.match(
		formatUpdate(preview),
		/Approval of 1\.1\.0: approved by samson/,
	);
});

test("a reformatted approval still verifies; a changed or unsigned one doesn't count", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t);
	const result = approve(f);
	const file = path.join(f.root, result.files[0]);
	const status = () =>
		approvalStatus({
			root: f.root,
			storeRoot: f.store,
			name: NAME,
			version: "1.1.0",
		});

	// A project formatter reflows the JSON: still approved (verified over canonical bytes).
	fs.writeFileSync(
		file,
		`${JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")), null, "\t")}\r\n`,
	);
	assert.equal(status().status, "approved");

	// Changing what it approves breaks it.
	const payload = JSON.parse(fs.readFileSync(file, "utf8"));
	fs.writeFileSync(
		file,
		JSON.stringify({ ...payload, approvedAt: "2030-01-01T00:00:00Z" }),
	);
	assert.equal(status().status, "unapproved");
	assert.match(status().problems[0], /does not match the signed content/);

	// A file an agent writes without a valid signature is reported, never counted.
	fs.writeFileSync(file, canonicalPayload(payload));
	const forged = path.join(path.dirname(file), "agent@example.com.json");
	fs.writeFileSync(
		forged,
		canonicalPayload({ ...payload, principal: "agent@example.com" }),
	);
	fs.copyFileSync(`${file}.sig`, `${forged}.sig`);
	const mixed = status();
	assert.equal(mixed.status, "approved");
	assert.deepEqual(
		mixed.approvedBy.map((a) => a.principal),
		["samson@example.com"],
	);
	assert.match(
		mixed.problems.join("\n"),
		/agent@example\.com\.json: .*not an allowed signer for agent@example\.com/,
	);

	// An approval of other bytes: the digest must match the library's version.
	fs.writeFileSync(
		file,
		canonicalPayload({ ...payload, sha256: "0".repeat(64) }),
	);
	assert.match(status().problems.join("\n"), /approves digest 0{64}/);
});

test("approve refuses keys and principals the policy doesn't allow, and leaves nothing", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { principals: ["*@example.org"] } });
	assert.throws(
		() => approve(f),
		/samson@example\.com is not an allowed approver/,
	);
	assert.throws(
		() => approve(f, "1.1.0", { key: f.other }),
		/is not in allowed_signers/,
	);
	assert.throws(
		() => approve(f, "9.9.9"),
		/not an allowed approver|not in the library/,
	);
	assert.ok(!fs.existsSync(path.join(f.root, APPROVALS)));
});

test("a failed signature leaves no approval behind", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t);
	assert.throws(
		() => approve(f, "1.1.0", { sshKeygen: process.execPath }),
		/ssh-keygen -Y sign failed .*nothing was written/,
	);
	const directory = path.join(f.root, APPROVALS, "@example/review/1.1.0");
	assert.deepEqual(
		fs.existsSync(directory) ? fs.readdirSync(directory) : [],
		[],
	);
});

test("no trust policy: no approval status anywhere", (t) => {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-nopolicy-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = path.join(dir, "absent.yaml");
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
	});
	fs.mkdirSync(path.join(dir, ".agent-profiles"));
	assert.equal(
		approvalStatus({ root: dir, name: NAME, version: "1.0.0" }),
		null,
	);
	assert.throws(
		() => approvePackage({ root: dir, name: NAME, version: "1.0.0" }),
		/needs a trust policy with allowed_signers/,
	);
});

test("library approve is denied to agents, and runs from the CLI", {
	skip: noKeygen,
}, (t) => {
	assert.ok(guardedCommands.includes("library approve"));
	const f = fixture(t);
	const run = spawnSync(
		process.execPath,
		[
			cli,
			"library",
			"approve",
			`${NAME}@1.1.0`,
			"--root",
			f.root,
			"--store",
			f.store,
			"--json",
		],
		{
			encoding: "utf8",
			env: { ...process.env, AGENT_PROFILES_TRUST: f.trust },
		},
	);
	assert.equal(run.status, 0, run.stderr);
	assert.equal(JSON.parse(run.stdout).principal, "samson@example.com");
	const bare = spawnSync(
		process.execPath,
		[cli, "library", "approve", NAME, "--root", f.root, "--store", f.store],
		{
			encoding: "utf8",
			env: { ...process.env, AGENT_PROFILES_TRUST: f.trust },
		},
	);
	assert.notEqual(bare.status, 0);
	assert.match(bare.stderr, /needs an exact version/);
});

test("with require_approval, doctor lists unapproved pins", {
	skip: noKeygen,
}, (t) => {
	const f = fixture(t, { policy: { require_approval: true } });
	fs.mkdirSync(path.join(f.root, ".git"));
	install({ root: f.root, agents: ["claude"], storeRoot: f.store });
	const before = doctor(f.root, { storeRoot: f.store });
	assert.ok(
		before.notes.some((n) =>
			/Approval: @example\/review@1\.0\.0 is pinned but not approved; run agent-profiles library approve @example\/review@1\.0\.0/.test(
				n,
			),
		),
	);
	approve(f, "1.0.0");
	const after = doctor(f.root, { storeRoot: f.store });
	assert.ok(!after.notes.some((n) => /^Approval:/.test(n)));
});
