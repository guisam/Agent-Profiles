// #53: parseRecord skips the YAML AST pass for text that already equals its own
// canonical encoding. These tests pin that the strict checks still apply to every
// non-canonical input, and that canonical records parse to the same values.
import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalEvaluationJSON,
	canonicalJSON,
	parseEvaluationRecord,
	parseRecord,
} from "../src/packages.ts";

const bytes = (text) => Buffer.from(text, "utf8");

test("canonical records parse to the value they encode", () => {
	const values = [
		{},
		{ a: 1, b: [true, false, null], c: { d: 'é\n"x"' } },
		{ nested: [[], {}, [{ z: 0, a: -42 }]], unicode: "雪☃\u0001" },
		[1, 2, 3],
	];
	for (const value of values) {
		const text = canonicalJSON(value);
		assert.deepEqual(parseRecord(text), value);
	}
	const evaluation = { costUsd: 1.25, latencyMs: 8.5, tokens: 80 };
	assert.deepEqual(
		parseEvaluationRecord(canonicalEvaluationJSON(evaluation)),
		evaluation,
	);
});

test("duplicate keys are still refused, canonical-looking or not", () => {
	for (const text of [
		'{"a":1,"a":1}',
		'{"a":1,"a":2}',
		'{"a":{"b":1,"b":1}}',
		'{"b":1,"a":2,"b":1}',
	])
		assert.throws(() => parseRecord(bytes(text)), /record/, text);
	assert.throws(
		() => parseEvaluationRecord(bytes('{"costUsd":1.5,"costUsd":1.5}')),
		/record/,
	);
});

test("non-integer literals are still refused outside evaluation records", () => {
	for (const text of ['{"a":1.5}', '{"a":1.0}', '{"a":1e2}', '{"a":-0}'])
		assert.throws(() => parseRecord(bytes(text)), /record/, text);
	// Evaluation records allow finite decimals, as before.
	assert.deepEqual(parseEvaluationRecord(bytes('{"a":1.5}')), { a: 1.5 });
});

test("non-canonical but valid JSON keeps its previous meaning", () => {
	// Unsorted keys and whitespace are not canonical; they take the strict path and parse as before.
	assert.deepEqual(parseRecord(bytes('{ "b": 1, "a": [ 2 ] }')), {
		b: 1,
		a: [2],
	});
	// Escaped forms decode to the same value as their canonical spelling.
	assert.deepEqual(parseRecord(bytes('{"a":"\\u00e9"}')), { a: "é" });
});

test("invalid JSON and invalid records are refused as before", () => {
	for (const text of ["", "{", '{"a":}', "[1,]", "NaN"])
		assert.throws(() => parseRecord(bytes(text)), undefined, text);
	assert.throws(() => parseRecord(bytes('{"a":9007199254740993}')), /record/);
});

test("parsed manifests are cached by bytes without sharing state between callers", async () => {
	const { parseManifest } = await import("../src/packages.ts");
	const manifest = (version) =>
		Buffer.from(
			`schema_version: 1\npackage:\n  name: "@example/cache"\n  version: "${version}"\n  type: skill\nentrypoint: SKILL.md\nbehavior:\n  delivery: instruction\n  hosts: []\n  effects: []\n`,
		);
	const first = parseManifest(manifest("1.0.0"));
	first.package.version = "mutated";
	first.behavior.hosts.push("claude");
	const second = parseManifest(manifest("1.0.0"));
	assert.equal(second.package.version, "1.0.0");
	assert.deepEqual(second.behavior.hosts, []);
	assert.notEqual(first, second);
	// Different bytes parse afresh.
	assert.equal(parseManifest(manifest("2.0.0")).package.version, "2.0.0");
	// Invalid manifests are never cached: they fail every time.
	const invalid = Buffer.from("schema_version: 1\npackage: &a {}\n");
	for (let i = 0; i < 2; i++)
		assert.throws(() => parseManifest(invalid), /package\.yaml/);
});
