import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readPackage } from "../src/packages.js";
import { parseYaml } from "../src/resolve.js";

const WORKER = fileURLToPath(
	new URL("./fixtures/issue-20/package-cli-worker.mjs", import.meta.url),
);
const NAME = "@example/error-output",
	VERSION = "1.0.0";
const MANIFEST = `schema_version: 1
package:
  name: '${NAME}'
  version: ${VERSION}
  type: skill
entrypoint: SKILL.md
behavior:
  delivery: instruction
  hosts: []
  effects: []
`;
const ESCAPED_FIELD = String.raw`"spoofed diagnostic\u001b[2J\u001b[H\u0007\u0085\u009b\r\ninjected line": true`;
const DECODED_FIELD =
	"spoofed diagnostic\x1b[2J\x1b[H\x07\x85\x9b\r\ninjected line";

function fingerprint(root) {
	return fs
		.readdirSync(root, { recursive: true })
		.map((p) => String(p).split(path.sep).join("/"))
		.sort()
		.map((p) => {
			const full = path.join(root, p),
				stat = fs.lstatSync(full);
			return [
				p,
				stat.isDirectory()
					? "directory"
					: fs.readFileSync(full).toString("hex"),
			];
		});
}

function fixture(t) {
	const ownedRoot = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "p9-cli-")),
	);
	t.after(() => {
		assert.equal(path.dirname(ownedRoot), fs.realpathSync(os.tmpdir()));
		assert.ok(path.basename(ownedRoot).startsWith("p9-cli-"));
		fs.rmSync(ownedRoot, { recursive: true, force: true });
	});
	const [project, source, storeRoot, home, ambient] = [
		"project",
		"source",
		"store",
		"home",
		"ambient",
	].map((p) => path.join(ownedRoot, p));
	for (const directory of [project, source, storeRoot, home, ambient])
		fs.mkdirSync(directory);
	fs.writeFileSync(path.join(project, "keep.txt"), "Project bytes\r\n");
	const members = [
		{
			path: "SKILL.md",
			bytes: Buffer.from(
				"---\nname: Error output\ndescription: Check diagnostic text.\n---\n# Inert bytes\r\n",
			),
		},
		{ path: "package.yaml", bytes: Buffer.from(MANIFEST) },
		{ path: "support.bin", bytes: Buffer.from([0, 255, 13, 10]) },
	];
	for (const member of members)
		fs.writeFileSync(path.join(source, member.path), member.bytes);
	const valid = readPackage({ root: source });
	assert.deepEqual(
		valid.files,
		members,
		"real validator accepts the complete clean tree",
	);
	assert.deepEqual(valid.manifest.package, {
		name: NAME,
		version: VERSION,
		type: "skill",
	});
	assert.match(valid.sha256, /^[0-9a-f]{64}$/);
	assert.deepEqual(
		fingerprint(storeRoot),
		[],
		"each case starts with a fresh empty store",
	);
	return { ownedRoot, project, source, storeRoot, home, ambient, valid };
}

function add(f, json) {
	const audit = path.join(f.ownedRoot, "audit.json");
	const request = {
		op: "cli",
		ownedRoot: f.ownedRoot,
		cwd: f.project,
		storeRoot: f.storeRoot,
		audit,
		argv: [
			"add",
			`${NAME}@${VERSION}`,
			"--source",
			f.source,
			"--store",
			f.storeRoot,
			...(json ? ["--json"] : []),
		],
	};
	const result = spawnSync(
		process.execPath,
		[WORKER, JSON.stringify(request)],
		{
			cwd: f.ownedRoot,
			encoding: "utf8",
			env: {
				...process.env,
				HOME: f.home,
				USERPROFILE: f.home,
				AGENT_PROFILES_STORE: f.ambient,
			},
		},
	);
	assert.ifError(result.error);
	assert.equal(result.signal, null, "native child exits normally");
	assert.ok(
		fs.existsSync(audit),
		"existing worker must retain its dispatch audit",
	);
	return { ...result, counts: JSON.parse(fs.readFileSync(audit, "utf8")) };
}

test("P9-F1 clean local package add publishes the validated full digest without diagnostics", (t) => {
	const f = fixture(t),
		roots = [f.project, f.source, f.home, f.ambient];
	const before = roots.map(fingerprint);
	const result = add(f, true);
	assert.deepEqual(
		roots.map(fingerprint),
		before,
		"import preserves project/source/default bytes",
	);
	assert.deepEqual(
		result.counts.dispatch,
		[],
		"no acquisition or native dispatch",
	);
	assert.equal(result.counts.listen, 0);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, "");
	assert.deepEqual(JSON.parse(result.stdout), {
		identity: { name: NAME, version: VERSION },
		sha256: f.valid.sha256,
		status: "published",
	});
});

function rejectsEscapedMetadata(t, json) {
	const f = fixture(t);
	assert.doesNotMatch(
		ESCAPED_FIELD,
		/[\x00-\x1f\x7f-\x9f]/,
		"manifest source contains escapes, not raw controls",
	);
	fs.writeFileSync(
		path.join(f.source, "package.yaml"),
		`${MANIFEST + ESCAPED_FIELD}\n`,
	);
	const roots = [f.project, f.source, f.storeRoot, f.home, f.ambient],
		before = roots.map(fingerprint);
	const parsed = parseYaml(
		fs.readFileSync(path.join(f.source, "package.yaml"), "utf8"),
	);
	assert.equal(
		parsed.get(DECODED_FIELD),
		true,
		"valid YAML decodes the exact ESC/BEL/C1/CR/LF key",
	);
	assert.throws(
		() => readPackage({ root: f.source }),
		(error) => {
			assert.equal(
				error.message,
				`package.yaml.${DECODED_FIELD}: unknown field`,
				"strict unknown-field rejection, not parser/setup failure",
			);
			return true;
		},
	);
	const result = add(f, json);
	// Keep preservation and dispatch evidence reachable before the expected sanitation failure.
	assert.deepEqual(
		roots.map(fingerprint),
		before,
		"refusal preserves project/source/empty store/defaults",
	);
	assert.deepEqual(fingerprint(f.storeRoot), []);
	assert.deepEqual(
		result.counts.dispatch,
		[],
		"no acquisition or native dispatch",
	);
	assert.equal(result.counts.listen, 0);
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.match(
		result.stderr,
		/^Agent Profiles: package\.yaml\.spoofed diagnostic/,
	);
	assert.match(result.stderr, /injected line: unknown field\n$/);
	assert.match(
		result.stderr,
		/^Agent Profiles: [^\x00-\x1f\x7f-\x9f]*\n$/u,
		"stderr keeps the actionable field name on one line without terminal controls, plus one trailing LF",
	);
}

test("P9-F1 text refusal sanitizes escaped unknown manifest field controls", (t) =>
	rejectsEscapedMetadata(t, false));
test("P9-F1 JSON refusal sanitizes escaped unknown manifest field controls on stderr", (t) =>
	rejectsEscapedMetadata(t, true));
