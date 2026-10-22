import assert from "node:assert/strict";
import test from "node:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	canonicalJSON,
	parseManifest,
	parseRecord,
	readPackage,
} from "../src/packages.js";

const manifest =
	'schema_version: 1\npackage:\n  name: "@example/review"\n  version: "1.0.0"\n  type: skill\nentrypoint: SKILL.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n';
const skill = "---\ndescription: Review.\n---\nBODY\n";
const native = manifest
	.replace("delivery: instruction", "delivery: native")
	.replace("hosts: []", "hosts: [claude]");
function fixture(t, text = manifest, body = skill) {
	const base = realpathSync(
		mkdtempSync(
			path.join(process.env.TMPDIR ?? os.tmpdir(), "package-review-"),
		),
	);
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const approved = path.join(base, "real", "approved");
	const root = path.join(approved, "pkg");
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, "package.yaml"), text);
	writeFileSync(path.join(root, "SKILL.md"), body);
	const alias = path.join(base, "alias");
	symlinkSync(
		path.join(base, "real"),
		alias,
		process.platform === "win32" ? "junction" : "dir",
	);
	return {
		base,
		approved,
		root,
		alias,
		aliasedApproved: path.join(alias, "approved"),
		aliasedRoot: path.join(alias, "approved", "pkg"),
	};
}
const linkDirectory = (target, link) =>
	symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

test("P2-R01 accepts an approved boundary beneath an actual aliased ancestor", (t) => {
	const f = fixture(t);
	const canonical = readPackage({ root: f.root, approvedRoot: f.approved });
	assert.equal(canonical.manifest.package.name, "@example/review");
	assert.deepEqual(
		readPackage({ root: f.aliasedRoot, approvedRoot: f.aliasedApproved }),
		canonical,
	);
});
test("P2-R01 accepts canonical child spelling with an aliased approved boundary", (t) => {
	const f = fixture(t);
	assert.deepEqual(
		readPackage({ root: f.root, approvedRoot: f.aliasedApproved }),
		readPackage({ root: f.root, approvedRoot: f.approved }),
	);
});
test("P2-R01 still rejects an explicitly linked child under the aliased boundary", (t) => {
	const f = fixture(t);
	linkDirectory(f.root, path.join(f.approved, "linked"));
	assert.throws(
		() =>
			readPackage({
				root: path.join(f.aliasedApproved, "linked"),
				approvedRoot: f.aliasedApproved,
			}),
		/root:.*link\/junction is forbidden/,
	);
});
test("P2-R01 still rejects an intermediate linked directory under the aliased boundary", (t) => {
	const f = fixture(t);
	linkDirectory(f.approved, path.join(f.approved, "linked"));
	assert.throws(
		() =>
			readPackage({
				root: path.join(f.aliasedApproved, "linked", "pkg"),
				approvedRoot: f.aliasedApproved,
			}),
		/root:.*link\/junction is forbidden/,
	);
});
test("P2-R01 still rejects descendant links escaping an aliased package", (t) => {
	const f = fixture(t);
	const outside = path.join(f.base, "outside");
	mkdirSync(outside);
	writeFileSync(path.join(outside, "secret"), "outside");
	linkDirectory(outside, path.join(f.root, "escape"));
	assert.throws(
		() => readPackage({ root: f.aliasedRoot, approvedRoot: f.aliasedApproved }),
		/escape:.*links.*forbidden/,
	);
});
test("P2-R01 still rejects roots outside an aliased approval boundary", (t) => {
	const f = fixture(t);
	assert.throws(
		() =>
			readPackage({
				root: path.join(f.alias, "outside"),
				approvedRoot: f.aliasedApproved,
			}),
		/root: outside approved root/,
	);
});

for (const token of [
	"1.0000000000000001",
	"9007199254740991.4",
	"1.0",
	"1e2",
]) {
	test(`P2-R02 rejects raw record numeric token ${token}`, () => {
		assert.deepEqual(parseRecord(Buffer.from('{"a":1}')), { a: 1 });
		assert.throws(
			() => parseRecord(Buffer.from(`{"a":${token}}`)),
			/record:.*integer/,
		);
	});
}
test("P2-R02 rejects fractional source at nested array depth", () => {
	assert.throws(
		() => parseRecord(Buffer.from('{"a":[{"b":1.0000000000000001}]}')),
		/record:.*integer/,
	);
});
test("P2-R02 retains decimal integer boundaries, numeric strings and canonicalJSON number API", () => {
	const value = { a: [-9007199254740991, 0, 9007199254740991], b: "1.0 1e2" };
	assert.deepEqual(parseRecord(Buffer.from(JSON.stringify(value))), value);
	assert.equal(canonicalJSON(1.0).toString(), "1");
	assert.equal(canonicalJSON(1e2).toString(), "100");
	for (const token of ["9007199254740992", "-0"])
		assert.throws(
			() => parseRecord(Buffer.from(token)),
			/record:.*safe integer/,
		);
	for (const raw of ['{"a":+1}', '{"a":01}', '{"a":1,}', '{"a":1,"\u0061":2}'])
		assert.throws(() => parseRecord(Buffer.from(raw)));
});
for (const token of ["1.0", "1e0", "1.0000000000000001"]) {
	test(`P2-R02 rejects YAML float schema_version ${token}`, () => {
		assert.equal(parseManifest(Buffer.from(manifest)).schema_version, 1);
		assert.throws(
			() =>
				parseManifest(
					Buffer.from(
						manifest.replace(
							"schema_version: 1\n",
							`schema_version: ${token}\n`,
						),
					),
				),
			/schema_version: expected integer 1/,
		);
	});
}
test("P2-R02 retains valid YAML integer schema_version spellings", () => {
	for (const token of ["1", "+1", "0x1", "0o1", "01", "!!int 1"]) {
		assert.equal(
			parseManifest(
				Buffer.from(
					manifest.replace("schema_version: 1\n", `schema_version: ${token}\n`),
				),
			).schema_version,
			1,
			token,
		);
	}
});

test("P2-N2 ignores empty native resource directories without changing identity", (t) => {
	const f = fixture(t, native);
	const before = readPackage({ root: f.root });
	for (const directory of [
		"hooks/empty",
		".claude-plugin/empty",
		".mcp.json",
	]) {
		mkdirSync(path.join(f.root, directory), { recursive: true });
		assert.deepEqual(readPackage({ root: f.root }), before);
	}
});
for (const resource of [
	"hooks/hook.json",
	".claude-plugin/plugin.json",
	".mcp.json",
]) {
	test(`P2-N2 still requires host-configuration for real resource ${resource}`, (t) => {
		const f = fixture(t, native);
		mkdirSync(path.dirname(path.join(f.root, resource)), { recursive: true });
		writeFileSync(path.join(f.root, resource), "{}");
		assert.throws(
			() => readPackage({ root: f.root }),
			(error) => {
				assert.equal(
					error.message,
					`SKILL.md: undeclared host-configuration (${resource})`,
				);
				return true;
			},
		);
		writeFileSync(
			path.join(f.root, "package.yaml"),
			native.replace("effects: []", "effects: [host-configuration]"),
		);
		assert.ok(
			readPackage({ root: f.root }).files.some(
				(file) => file.path === resource,
			),
		);
	});
}
test("P2-N1 unrelated commands declaration does not authorize substitution", (t) => {
	const f = fixture(
		t,
		native.replace("effects: []", "effects: [commands]"),
		skill.replace("BODY", "$ARGUMENTS"),
	);
	assert.throws(
		() => readPackage({ root: f.root }),
		/SKILL\.md: undeclared substitution/,
	);
	writeFileSync(
		path.join(f.root, "package.yaml"),
		native.replace("effects: []", "effects: [substitution]"),
	);
	assert.deepEqual(readPackage({ root: f.root }).manifest.behavior.effects, [
		"substitution",
	]);
});
