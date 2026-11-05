// Shared by the approval and enforcement tests (#71): a project pinning
// @example/review 1.0.0 (1.1.0 also in the library), fresh SSH keys from the
// machine's ssh-keygen, and a trust policy in AGENT_PROFILES_TRUST.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { approvePackage } from "../../src/approvals.ts";
import { publishPackage } from "../../src/library.ts";
import { installDependencies } from "../../src/package-lock.ts";

export const NAME = "@example/review";
export const noKeygen = spawnSync("ssh-keygen", ["-?"]).error
	? "no ssh-keygen"
	: false;

export function put(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}

export function keygen(file, comment) {
	const made = spawnSync("ssh-keygen", [
		"-q",
		"-t",
		"ed25519",
		"-N",
		"",
		"-C",
		comment,
		"-f",
		file,
	]);
	assert.equal(made.status, 0, String(made.stderr));
	return fs
		.readFileSync(`${file}.pub`, "utf8")
		.split(" ")
		.slice(0, 2)
		.join(" ");
}

export function fixture(
	t,
	{ policy = {}, effects = [], signingKey = true } = {},
) {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "agent-profiles-approve-")),
	);
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	const root = path.join(dir, "project");
	const store = path.join(dir, "store");
	for (const version of ["1.0.0", "1.1.0"]) {
		const source = path.join(dir, "sources", version);
		put(
			path.join(source, "package.yaml"),
			stringify({
				schema_version: 1,
				package: { name: NAME, version, type: "skill" },
				entrypoint: "SKILL.md",
				behavior: { delivery: "instruction", hosts: [], effects },
			}),
		);
		put(
			path.join(source, "SKILL.md"),
			`---\ndescription: x\n---\n# ${version}\n`,
		);
		publishPackage({ storeRoot: store, sourceDirectory: source });
	}
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
					skills: { required: ["review"], available: [] },
				},
			},
			skills: { review: { package: NAME, version: "1.0.0" } },
		}),
	);
	installDependencies({ root, storeRoot: store });
	const key = path.join(dir, "keys", "approver");
	fs.mkdirSync(path.dirname(key));
	const pub = keygen(key, "approver");
	const other = path.join(dir, "keys", "other");
	keygen(other, "other");
	put(path.join(dir, "allowed_signers"), `samson@example.com ${pub}\n`);
	const trust = path.join(dir, "trust.yaml");
	put(
		trust,
		stringify({
			version: 1,
			allowed_signers: "allowed_signers",
			...(signingKey ? { signing_key: key } : {}),
			...policy,
		}),
	);
	const saved = process.env.AGENT_PROFILES_TRUST;
	process.env.AGENT_PROFILES_TRUST = trust;
	t.after(() => {
		if (saved === undefined) delete process.env.AGENT_PROFILES_TRUST;
		else process.env.AGENT_PROFILES_TRUST = saved;
	});
	return { dir, root, store, key, other, trust };
}

export const approve = (f, version = "1.1.0", extra = {}) =>
	approvePackage({
		root: f.root,
		storeRoot: f.store,
		name: NAME,
		version,
		now: new Date("2026-11-05T12:00:00Z"),
		...extra,
	});
