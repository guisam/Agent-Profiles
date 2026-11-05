// #71: SSH signature verification, allowed_signers and the trust policy. Fixtures in
// test/fixtures/trust were made with real `ssh-keygen -Y sign` (Ed25519); the
// hardware-key (sk-ssh-ed25519) signatures were built by hand and checked with
// `ssh-keygen -Y verify`. No private keys are committed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	APPROVAL_NAMESPACE,
	approverAllowed,
	disallowedEffects,
	loadTrustPolicy,
	namespaceAllowed,
	parseAllowedSigners,
	parseSshSignature,
	policySigners,
	principalAllowed,
	trustReport,
	verifySshSignature,
} from "../src/trust.ts";

const dir = fileURLToPath(new URL("fixtures/trust/", import.meta.url));
const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
const message = fs.readFileSync(path.join(dir, "approval.json"));
const { signers } = parseAllowedSigners(read("allowed_signers"));
const check = (sig, principal = "samson@example.com", extra = {}) =>
	verifySshSignature({
		message,
		signature: read(sig),
		namespace: APPROVAL_NAMESPACE,
		principal,
		signers,
		...extra,
	});

test("an ssh-keygen Ed25519 signature verifies, with its fingerprint", () => {
	const result = check("approval.ed25519.sig");
	assert.equal(result.keyType, "ssh-ed25519");
	assert.equal(result.signerLine, 1);
	// The fingerprint ssh-keygen prints for the same key.
	const pub = read("approver.pub").split(" ")[1];
	const expected = parseAllowedSigners(`x ssh-ed25519 ${pub}`).signers[0].key
		.fingerprint;
	assert.equal(result.fingerprint, expected);
	assert.match(result.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
});

test("changed content, another namespace, another key or principal don't verify", () => {
	assert.throws(
		() =>
			verifySshSignature({
				message: Buffer.from(message.toString().replace("1.1.0", "1.1.1")),
				signature: read("approval.ed25519.sig"),
				namespace: APPROVAL_NAMESPACE,
				principal: "samson@example.com",
				signers,
			}),
		/does not match the signed content/,
	);
	assert.throws(
		() => check("approval.wrong-namespace.sig"),
		/signed for namespace git/,
	);
	assert.throws(
		() => check("approval.other-key.sig"),
		/is not an allowed signer for samson@example\.com/,
	);
	assert.throws(
		() => check("approval.ed25519.sig", "mallory@example.com"),
		/not an allowed signer for mallory/,
	);
});

test("a hardware-key signature verifies only with a touch", () => {
	const result = check("approval.sk.sig", "hardware@example.com");
	assert.equal(result.keyType, "sk-ssh-ed25519@openssh.com");
	assert.throws(
		() => check("approval.sk-no-touch.sig", "hardware@example.com"),
		/lacks user presence/,
	);
	assert.equal(
		check("approval.sk-no-touch.sig", "hardware@example.com", {
			requireUserPresence: false,
		}).keyType,
		"sk-ssh-ed25519@openssh.com",
	);
	const parsed = parseSshSignature(read("approval.sk.sig"));
	assert.equal(parsed.hashAlgorithm, "sha512");
	assert.equal(parsed.counter, 7);
	assert.equal(parsed.publicKey.application, "ssh:");
});

test("allowed_signers: options, validity windows, patterns and unsupported lines", () => {
	const pub = read("approver.pub").split(" ")[1];
	const text = [
		"# comment",
		"",
		`*@example.com,!mallory@example.com,!ci@example.com valid-after="20260101",valid-before="20270101Z" ssh-ed25519 ${pub} note`,
		`ci@example.com namespaces="git" ssh-ed25519 ${pub}`,
		`ca@example.com cert-authority ssh-ed25519 ${pub}`,
		"rsa@example.com ssh-rsa AAAAB3NzaC1yc2E",
		'broken "unterminated',
	].join("\n");
	const parsed = parseAllowedSigners(text);
	assert.equal(parsed.signers.length, 2);
	assert.deepEqual(
		parsed.problems.map((p) => p.replace(/:.*/, "")),
		["line 5", "line 6", "line 7"],
	);
	assert.match(parsed.problems[0], /certificate authorities are not supported/);
	assert.match(parsed.problems[1], /unsupported key type ssh-rsa/);
	const verifyAs = (principal, now) =>
		verifySshSignature({
			message,
			signature: read("approval.ed25519.sig"),
			namespace: APPROVAL_NAMESPACE,
			principal,
			signers: parsed.signers,
			now,
		});
	assert.equal(
		verifyAs("samson@example.com", new Date("2026-06-01")).signerLine,
		3,
	);
	assert.throws(
		() => verifyAs("mallory@example.com", new Date("2026-06-01")),
		/not an allowed signer/,
	);
	assert.throws(
		() => verifyAs("samson@example.com", new Date("2025-06-01")),
		/not valid until/,
	);
	assert.throws(
		() => verifyAs("samson@example.com", new Date("2027-06-01")),
		/expired/,
	);
	// ci@ is only allowed for namespace git.
	assert.throws(
		() => verifyAs("ci@example.com", new Date("2026-06-01")),
		/does not allow namespace/,
	);
	assert.equal(principalAllowed(["*@example.com"], "a@example.com"), true);
	assert.equal(principalAllowed(["*@example.com"], "a@example.org"), false);
});

// A real ssh-keygen, when present (GitHub runners have one), signing a fresh key.
test("signatures from this machine's ssh-keygen verify", {
	skip: spawnSync("ssh-keygen", ["-?"]).error ? "no ssh-keygen" : false,
}, (t) => {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-sshsig-"));
	t.after(() => fs.rmSync(work, { recursive: true, force: true }));
	const key = path.join(work, "key");
	const file = path.join(work, "payload.json");
	assert.equal(
		spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key])
			.status,
		0,
	);
	fs.writeFileSync(file, '{"x": "ünïcode"}\n');
	const signed = spawnSync("ssh-keygen", [
		"-q",
		"-Y",
		"sign",
		"-f",
		key,
		"-n",
		APPROVAL_NAMESPACE,
		file,
	]);
	assert.equal(signed.status, 0, String(signed.stderr));
	const pub = fs
		.readFileSync(`${key}.pub`, "utf8")
		.split(" ")
		.slice(0, 2)
		.join(" ");
	const result = verifySshSignature({
		message: fs.readFileSync(file),
		signature: fs.readFileSync(`${file}.sig`, "utf8"),
		namespace: APPROVAL_NAMESPACE,
		principal: "me@example.com",
		signers: parseAllowedSigners(`me@example.com ${pub}`).signers,
	});
	assert.equal(result.keyType, "ssh-ed25519");
});

// --- policy

function home(t) {
	const base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-trust-")),
	);
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const root = path.join(base, "project");
	fs.mkdirSync(path.join(root, ".agent-profiles"), { recursive: true });
	const machine = path.join(base, "trust.yaml");
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = machine;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
	});
	fs.copyFileSync(
		path.join(dir, "allowed_signers"),
		path.join(base, "allowed_signers"),
	);
	return {
		base,
		root,
		machine,
		project: path.join(root, ".agent-profiles/trust.yaml"),
	};
}

test("no policy files: no policy, nothing reported", (t) => {
	const h = home(t);
	assert.equal(loadTrustPolicy({ root: h.root }), null);
	assert.deepEqual(trustReport(h.root), { notes: [], errors: [] });
});

test("a project policy narrows the machine policy and can't name keys", (t) => {
	const h = home(t);
	fs.writeFileSync(
		h.machine,
		[
			"version: 1",
			"allowed_signers: allowed_signers",
			"namespaces: ['@example/*', '@other/*']",
			"effects: [substitution, commands]",
		].join("\n"),
	);
	fs.writeFileSync(
		h.project,
		[
			"version: 1",
			"require_approval: true",
			"namespaces: ['@example/*']",
			"effects: [commands, host-configuration]",
			"principals: ['*@example.com']",
		].join("\n"),
	);
	const policy = loadTrustPolicy({ root: h.root });
	assert.deepEqual(policy.problems, []);
	assert.equal(policy.allowedSigners, path.join(h.base, "allowed_signers"));
	assert.equal(policy.requireApproval, true);
	assert.deepEqual(policy.effects, ["commands"]);
	assert.equal(namespaceAllowed(policy, "@example/review"), true);
	assert.equal(namespaceAllowed(policy, "@other/review"), false);
	assert.deepEqual(disallowedEffects(policy, ["commands", "substitution"]), [
		"substitution",
	]);
	assert.equal(approverAllowed(policy, "samson@example.com"), true);
	assert.equal(approverAllowed(policy, "samson@example.org"), false);
	assert.equal(policySigners(policy).length, 2);

	fs.writeFileSync(
		h.project,
		"version: 1\nallowed_signers: mine\nsigning_key: k.pub\n",
	);
	assert.match(
		loadTrustPolicy({ root: h.root }).problems.join("\n"),
		/allowed_signers, signing_key not allowed here \(a project policy can only narrow/,
	);
});

test("defaults: substitution is the only allowed effect; require_approval needs signers", (t) => {
	const h = home(t);
	fs.writeFileSync(h.machine, "version: 1\nrequire_approval: true\n");
	const policy = loadTrustPolicy({ root: h.root });
	assert.deepEqual(policy.effects, ["substitution"]);
	assert.match(policy.problems.join("\n"), /no allowed_signers file/);
	assert.equal(namespaceAllowed(policy, "@anything/x"), true);
	const report = trustReport(h.root);
	assert.match(report.notes[0], /require_approval on; no allowed_signers/);
	assert.equal(report.errors.length, 1);
});

test("bad policy files are reported, not thrown", (t) => {
	const h = home(t);
	fs.writeFileSync(
		h.machine,
		"version: 2\nrequire_approval: yes please\neffects: [teleport]\n",
	);
	fs.writeFileSync(h.project, ": not yaml : [");
	const problems = loadTrustPolicy({ root: h.root }).problems.join("\n");
	assert.match(problems, /version: expected 1/);
	assert.match(problems, /require_approval: expected true or false/);
	assert.match(problems, /effects: expected a list of values from/);
	assert.match(
		problems,
		/project\/\.agent-profiles\/trust\.yaml|trust\.yaml: /,
	);
	fs.writeFileSync(h.machine, "version: 1\nallowed_signers: missing_file\n");
	fs.rmSync(h.project);
	assert.match(
		trustReport(h.root).errors.join("\n"),
		/missing_file: file not found/,
	);
});
