import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as packages from "../src/packages.js";

const helpers = [
	"canonicalEvaluationJSON",
	"parseEvaluationRecord",
	"hashEvaluationRecord",
];
const ready = helpers.every((name) => typeof packages[name] === "function");
const evaluationTest = (name, body) =>
	test(
		name,
		{
			skip: ready
				? false
				: "evaluation codec helpers absent; dependent body UNEXECUTED",
		},
		body,
	);
const vectorValue = { costUsd: 1.25, settings: { temperature: 0.5 } };
const vectorBytes = Buffer.from(
	'{"costUsd":1.25,"settings":{"temperature":0.5}}',
);
const vectors = [
	[
		"agent-profiles/evaluation-plan/v1",
		"6f2e7c7450a41cfc3d3b0ffba82080847eba41379b00029ad98e4e04b6915e80",
	],
	[
		"agent-profiles/evaluation-result/v1",
		"68d7fd84e40cca511c283e4f4361b5a679594d388d389f67ae986e4493ef5cba",
	],
];

test("evaluation codec prerequisite preserves actual legacy integer bytes framing and fractional refusal", () => {
	const value = { z: true, a: [-2, 0, 3] },
		bytes = Buffer.from('{"a":[-2,0,3],"z":true}');
	const domain = "agent-profiles/revision/v1",
		length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	const expected = createHash("sha256")
		.update(Buffer.from(domain))
		.update(Buffer.from([0]))
		.update(length)
		.update(bytes)
		.digest("hex");
	assert.deepEqual(packages.canonicalJSON(value), bytes);
	assert.deepEqual(packages.parseRecord(bytes), value);
	assert.equal(packages.hashRecord(domain, value), expected);
	assert.throws(() => packages.canonicalJSON({ costUsd: 1.25 }));
	assert.throws(() => packages.parseRecord(Buffer.from('{"costUsd":1.25}')));
	assert.throws(() => packages.hashRecord(domain, { costUsd: 1.25 }));
});

test("evaluation codec independent literal 47-byte fixture matches both supplied framed golden hashes", () => {
	assert.equal(vectorBytes.length, 47);
	assert.deepEqual(JSON.parse(vectorBytes.toString("utf8")), vectorValue);
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(47n);
	for (const [domain, expected] of vectors) {
		const actual = createHash("sha256")
			.update(Buffer.from(domain))
			.update(Buffer.from([0]))
			.update(length)
			.update(vectorBytes)
			.digest("hex");
		assert.equal(actual, expected);
	}
	assert.notEqual(vectors[0][1], vectors[1][1]);
});

test("explicit evaluation numeric codec helpers exist without replacing legacy interfaces", () => {
	assert.deepEqual(
		helpers.filter((name) => typeof packages[name] !== "function"),
		[],
		"packages must expose the three explicit evaluation-only helpers",
	);
});

evaluationTest(
	"evaluation codec orders nested decimal settings and roundtrips signed decimal exponent literals",
	() => {
		const value = {
			z: 2.25,
			settings: { temperature: 0.5, label: "café" },
			a: -0.125,
		};
		const bytes = Buffer.from(
			'{"a":-0.125,"settings":{"label":"café","temperature":0.5},"z":2.25}',
		);
		const raw = Buffer.from(
			'{"z":2.25e0,"settings":{"temperature":5e-1,"label":"café"},"a":-1.25e-1}',
		);
		assert.deepEqual(packages.canonicalEvaluationJSON(value), bytes);
		assert.deepEqual(packages.parseEvaluationRecord(bytes), value);
		assert.deepEqual(packages.parseEvaluationRecord(raw), value);
		assert.deepEqual(
			packages.canonicalEvaluationJSON(packages.parseEvaluationRecord(raw)),
			bytes,
		);
	},
);

for (const [domain, expected] of vectors)
	evaluationTest(`evaluation codec fixed golden hash ${domain}`, () => {
		assert.deepEqual(
			packages.canonicalEvaluationJSON(vectorValue),
			vectorBytes,
		);
		assert.equal(packages.hashEvaluationRecord(domain, vectorValue), expected);
		assert.notEqual(
			packages.hashEvaluationRecord(vectors[0][0], vectorValue),
			packages.hashEvaluationRecord(vectors[1][0], vectorValue),
		);
	});

evaluationTest(
	"evaluation integer parity leaves legacy default number semantics unchanged after use",
	() => {
		const value = {
			settings: { seed: 17 },
			bounds: [-Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER],
		};
		const bytes = packages.canonicalJSON(value);
		assert.deepEqual(packages.canonicalEvaluationJSON(value), bytes);
		assert.deepEqual(
			packages.parseEvaluationRecord(bytes),
			packages.parseRecord(bytes),
		);
		for (const [domain] of vectors)
			assert.equal(
				packages.hashEvaluationRecord(domain, value),
				packages.hashRecord(domain, value),
			);
		packages.canonicalEvaluationJSON(vectorValue);
		packages.parseEvaluationRecord(vectorBytes);
		packages.hashEvaluationRecord(vectors[1][0], vectorValue);
		assert.throws(() => packages.canonicalJSON(vectorValue));
		assert.throws(() => packages.parseRecord(vectorBytes));
		assert.throws(() => packages.hashRecord(vectors[1][0], vectorValue));
		assert.deepEqual(packages.canonicalJSON(value), bytes);
	},
);

for (const [name, value, raw] of [
	["NaN", NaN, "NaN"],
	["infinite exponent overflow", Infinity, "1e999"],
	["unsafe magnitude", Number.MAX_SAFE_INTEGER + 1, "9007199254740992"],
	["negative zero", -0, "-0.0"],
])
	evaluationTest(
		`evaluation codec rejects ${name} in encoding and parsing`,
		() => {
			assert.throws(() => packages.canonicalEvaluationJSON({ value }));
			assert.throws(() =>
				packages.parseEvaluationRecord(Buffer.from(`{"value":${raw}}`)),
			);
			assert.throws(() =>
				packages.hashEvaluationRecord(vectors[1][0], { value }),
			);
			if (value === Infinity) {
				assert.throws(() =>
					packages.canonicalEvaluationJSON({ value: -Infinity }),
				);
				assert.throws(() =>
					packages.parseEvaluationRecord(Buffer.from('{"value":-1e999}')),
				);
			}
			if (name === "unsafe magnitude") {
				assert.throws(() =>
					packages.canonicalEvaluationJSON({ value: -value }),
				);
				assert.throws(() =>
					packages.parseEvaluationRecord(
						Buffer.from('{"value":-9007199254740992}'),
					),
				);
			}
		},
	);

for (const [name, bytes] of [
	["decoded duplicate key", Buffer.from('{"a":1.25,"a":2.25}')],
	["escaped duplicate key", Buffer.from('{"a":1.25,"\\u0061":2.25}')],
	[
		"invalid UTF8",
		Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]),
	],
	["BOM", Buffer.from('\uFEFF{"a":1.25}')],
	["unpaired surrogate", Buffer.from('{"a":"\\ud800"}')],
])
	evaluationTest(`evaluation strict parser rejects ${name}`, () => {
		assert.throws(() => packages.parseEvaluationRecord(bytes));
	});

evaluationTest(
	"evaluation encoder rejects non-JSON object data and unpaired strings",
	() => {
		assert.throws(() => packages.canonicalEvaluationJSON(new Date(0)));
		assert.throws(() => packages.canonicalEvaluationJSON({ value: undefined }));
		assert.throws(() => packages.canonicalEvaluationJSON({ value: "\uD800" }));
	},
);

evaluationTest(
	"evaluation encoder refuses accessor data without invoking it",
	() => {
		let invoked = false;
		const value = Object.defineProperty({}, "metric", {
			enumerable: true,
			get() {
				invoked = true;
				return 1.25;
			},
		});
		assert.throws(() => packages.canonicalEvaluationJSON(value));
		assert.equal(invoked, false);
	},
);

evaluationTest("evaluation encoder rejects sparse arrays", () => {
	const value = [1.25];
	value.length = 2;
	assert.throws(() => packages.canonicalEvaluationJSON(value));
});

evaluationTest("evaluation encoder rejects cyclic data", () => {
	const value = { costUsd: 1.25 };
	value.self = value;
	assert.throws(() => packages.canonicalEvaluationJSON(value));
});

for (const domain of [
	"agent-profiles/revision/v1",
	"agent-profiles/stamp/v2",
	"arbitrary-domain",
]) {
	evaluationTest(`evaluation hash refuses foreign domain ${domain}`, () => {
		assert.throws(() => packages.hashEvaluationRecord(domain, vectorValue));
		assert.throws(() => packages.hashEvaluationRecord(domain, { seed: 17 }));
		assert.throws(() => packages.hashRecord(domain, vectorValue));
	});
}
