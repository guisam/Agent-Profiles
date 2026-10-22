import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isAlias, isScalar, parseDocument, visit } from "yaml";
import { errorMessage } from "./files.js";
import { integrations } from "./integrations.js";
import {
	mapping,
	parseYaml,
	parseYamlDocument,
	skillMetadata,
} from "./resolve.js";

function fail(location, message) {
	throw new Error(`${location}: ${message}`);
}

function decode(bytes, location, allowBOM = true) {
	if (!Buffer.isBuffer(bytes)) fail(location, "expected a Buffer");
	try {
		const text = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
		if (!allowBOM && text.startsWith("\uFEFF"))
			fail(location, "JSON BOM is not allowed");
		return text;
	} catch (error) {
		fail(location, `invalid UTF-8 encoding: ${errorMessage(error)}`);
	}
}

function portablePath(value, location = "member path") {
	if (
		typeof value !== "string" ||
		!value ||
		!/^[A-Za-z0-9._/-]+$/.test(value)
	) {
		fail(location, "expected a portable relative ASCII path");
	}
	for (const component of value.split("/")) {
		if (
			!component ||
			component === "." ||
			component === ".." ||
			component.endsWith(".")
		) {
			fail(location, `invalid path component ${JSON.stringify(component)}`);
		}
		if (
			component.toLowerCase() === ".git" ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)
		) {
			fail(location, `reserved path component ${component}`);
		}
	}
	return value;
}

export function parseManifest(bytes) {
	const document = parseYamlDocument(decode(bytes, "package.yaml"));
	visit(document, {
		Node(_key, node) {
			if (isAlias(node)) fail("package.yaml", "aliases are unsupported");
			if (node.anchor) fail("package.yaml", "anchors are unsupported");
			if (node.tag && !node.tag.startsWith("tag:yaml.org,2002:"))
				fail("package.yaml", "custom tags are unsupported");
		},
		Pair(_key, pair) {
			if (isScalar(pair.key) && pair.key.value === "<<")
				fail("package.yaml", "merge key << is unsupported");
		},
	});
	const manifest = mapping(document.toJS({ mapAsMap: true }), "package.yaml", [
		"schema_version",
		"package",
		"entrypoint",
		"behavior",
	]);
	const schemaVersion = document.get("schema_version", true);
	if (
		!isScalar(schemaVersion) ||
		schemaVersion.value !== 1 ||
		(schemaVersion.tag && schemaVersion.tag !== "tag:yaml.org,2002:int") ||
		!/^(?:[-+]?[0-9]+|0x[0-9a-fA-F]+|0o[0-7]+)$/.test(schemaVersion.source)
	)
		fail("schema_version", "expected integer 1");
	const identity = mapping(
		manifest.get("package"),
		"package",
		["name", "version", "type"],
		["description", "license"],
	);
	const name = identity.get("name");
	if (
		typeof name !== "string" ||
		!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)
	)
		fail("package.name", "expected @namespace/name");
	const version = identity.get("version");
	if (
		typeof version !== "string" ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) ||
		version.split(".").some((n) => !Number.isSafeInteger(Number(n)))
	) {
		fail(
			"package.version",
			"expected an exact safe three-component release version",
		);
	}
	const type = identity.get("type");
	if (!["skill", "instruction"].includes(type))
		fail("package.type", "expected skill or instruction");
	for (const field of ["description", "license"]) {
		if (
			identity.has(field) &&
			(typeof identity.get(field) !== "string" || !identity.get(field).trim())
		)
			fail(`package.${field}`, "expected a nonempty string");
	}
	const entrypoint = portablePath(manifest.get("entrypoint"), "entrypoint");
	if (!entrypoint.endsWith(".md"))
		fail("entrypoint", "expected a Markdown .md file");
	const behavior = mapping(manifest.get("behavior"), "behavior", [
		"delivery",
		"hosts",
		"effects",
	]);
	const delivery = behavior.get("delivery");
	if (!["instruction", "native"].includes(delivery))
		fail("behavior.delivery", "expected instruction or native");
	for (const [field, allowed] of [
		["hosts", integrations.map((host) => host.id)],
		[
			"effects",
			["commands", "substitution", "external-references", "host-configuration"],
		],
	]) {
		const list = behavior.get(field);
		if (
			!Array.isArray(list) ||
			list.some(
				(item) => typeof item !== "string" || !allowed.includes(item),
			) ||
			new Set(list).size !== list.length
		) {
			fail(
				`behavior.${field}`,
				"expected a duplicate-free list of supported strings",
			);
		}
	}
	if (delivery === "native" && type !== "skill")
		fail("package.type", "native delivery requires a skill");
	if (delivery === "native" && !behavior.get("hosts").length)
		fail("behavior.hosts", "native delivery requires nonempty hosts");
	if (delivery === "instruction" && behavior.get("hosts").length)
		fail("behavior.hosts", "instruction delivery requires empty hosts");
	return document.toJS();
}

export function validateMembers(members) {
	const spellings = new Map();
	const explicit = new Map();
	const files = new Set();
	const parents = new Set();
	for (const member of members) {
		const name = portablePath(member.path);
		if (!["file", "directory"].includes(member.type))
			fail(
				name,
				`unsupported member type ${member.type}; links and special files are forbidden`,
			);
		if (member.type === "file" && member.nlink > 1)
			fail(name, "hard-linked file (nlink > 1) is forbidden");
		const folded = name.toLowerCase();
		if (explicit.has(folded)) fail(name, "duplicate member collision");
		explicit.set(folded, member.type);
		const components = name.split("/");
		for (let i = 1; i <= components.length; i++) {
			const prefix = components.slice(0, i).join("/");
			const key = prefix.toLowerCase();
			if (spellings.has(key) && spellings.get(key) !== prefix)
				fail(name, `case collision at ${prefix}`);
			spellings.set(key, prefix);
			if (i < components.length) parents.add(key);
		}
		if (member.type === "file") files.add(folded);
	}
	for (const file of files) {
		if (parents.has(file)) fail(file, "file/directory prefix collision");
	}
}

function sortFiles(files) {
	return [...files].sort((a, b) =>
		Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
	);
}

export function readPackage({ root, approvedRoot = undefined }) {
	let selected = path.resolve(root);
	if (approvedRoot !== undefined) {
		const boundary = realpathSync(approvedRoot);
		const relative = [path.resolve(approvedRoot), boundary]
			.map((base) => path.relative(base, selected))
			.find(
				(relative) =>
					!path.isAbsolute(relative) &&
					relative !== ".." &&
					!relative.startsWith(`..${path.sep}`),
			);
		if (relative === undefined) fail("root", "outside approved root");
		let current = boundary;
		for (const component of relative.split(path.sep).filter(Boolean)) {
			current = path.join(current, component);
			if (lstatSync(current).isSymbolicLink())
				fail("root", `${current}: link/junction is forbidden`);
		}
		selected = path.join(boundary, relative);
	}
	const rootStat = lstatSync(selected);
	if (rootStat.isSymbolicLink()) fail("root", "link/junction is forbidden");
	if (!rootStat.isDirectory()) fail("root", "expected a directory");
	const canonicalRoot = realpathSync(selected);
	const members = [];
	function scan(relative = "") {
		for (const name of readdirSync(path.join(canonicalRoot, relative))) {
			const memberPath = relative ? `${relative}/${name}` : name;
			portablePath(memberPath);
			const stat = lstatSync(path.join(canonicalRoot, memberPath));
			const type = stat.isSymbolicLink()
				? "symlink"
				: stat.isDirectory()
					? "directory"
					: stat.isFile()
						? "file"
						: "special";
			const member = { path: memberPath, type, nlink: stat.nlink };
			validateMembers([member]);
			members.push(member);
			if (type === "directory") scan(memberPath);
		}
	}
	scan();
	validateMembers(members);
	const files = sortFiles(
		members
			.filter((member) => member.type === "file")
			.map((member) => ({
				path: member.path,
				bytes: readFileSync(path.join(canonicalRoot, member.path)),
			})),
	);
	const manifestFile = files.find((file) => file.path === "package.yaml");
	if (!manifestFile) fail("package.yaml", "required manifest file is missing");
	const manifest = parseManifest(manifestFile.bytes);
	const entrypoint = files.find((file) => file.path === manifest.entrypoint);
	if (!entrypoint)
		fail(manifest.entrypoint, "entrypoint must be an existing regular file");
	const text = decode(entrypoint.bytes, manifest.entrypoint).replace(
		/^\uFEFF/,
		"",
	);
	if (manifest.package.type === "skill")
		skillMetadata(
			"unused",
			"package entrypoint",
			entrypoint.bytes,
			manifest.entrypoint,
		);
	if (manifest.behavior.delivery === "native") {
		const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
		const metadata = parseYaml(match[1]);
		const body = text.slice(match[0].length);
		const signals = [
			["commands", /!`|^```!/m.test(body)],
			["substitution", /\$ARGUMENTS|\$\{[A-Za-z0-9_.]+\}/.test(body)],
			["external-references", /^@\S+/m.test(body)],
			[
				"host-configuration",
				["hooks", "allowed-tools", "model", "effort", "context", "agent"].some(
					(key) => metadata.has(key),
				),
			],
		];
		const resource = files.find(
			(member) =>
				member.path.startsWith("hooks/") ||
				member.path.startsWith(".claude-plugin/") ||
				member.path === ".mcp.json",
		);
		if (resource) signals.push(["host-configuration", true]);
		for (const [effect, present] of signals) {
			if (present && !manifest.behavior.effects.includes(effect))
				fail(
					manifest.entrypoint,
					`undeclared ${effect}${effect === "host-configuration" && resource ? ` (${resource.path})` : ""}`,
				);
		}
	}
	return { manifest, files, sha256: hashTree(files) };
}

function u64(value) {
	if (!Number.isSafeInteger(value) || value < 0)
		fail("length", "expected a nonnegative safe integer");
	const bytes = Buffer.alloc(8);
	bytes.writeBigUInt64BE(BigInt(value));
	return bytes;
}

function validString(value) {
	if (
		typeof value !== "string" ||
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
			value,
		)
	) {
		fail("record", "expected a string without unpaired surrogates");
	}
	return value;
}

export function hashTree(files, domain = "agent-profiles/package-tree/v1") {
	validateMembers(
		files.map((file) => ({ path: file.path, type: "file", nlink: 1 })),
	);
	const hash = createHash("sha256")
		.update(Buffer.from(validString(domain)))
		.update(Buffer.from([0]))
		.update(u64(files.length));
	for (const file of sortFiles(files)) {
		if (!Buffer.isBuffer(file.bytes))
			fail(file.path, "expected raw Buffer bytes");
		const name = Buffer.from(file.path);
		hash
			.update(Buffer.from([0x46]))
			.update(u64(name.length))
			.update(name)
			.update(u64(file.bytes.length))
			.update(file.bytes);
	}
	return hash.digest("hex");
}

function canonicalRecord(value, evaluation) {
	const active = new Set();
	function string(text) {
		return (
			'"' +
			validString(text).replace(/["\\\u0000-\u001F]/g, (character) =>
				character === '"' || character === "\\"
					? `\\${character}`
					: `\\u00${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
			) +
			'"'
		);
	}
	function encode(item) {
		if (item === null) return "null";
		if (typeof item === "boolean") return String(item);
		if (typeof item === "string") return string(item);
		if (typeof item === "number") {
			if (evaluation) {
				if (
					!Number.isFinite(item) ||
					Math.abs(item) > Number.MAX_SAFE_INTEGER ||
					Object.is(item, -0)
				)
					fail(
						"record",
						"expected a finite safe-magnitude number, not negative zero",
					);
			} else if (!Number.isSafeInteger(item) || Object.is(item, -0))
				fail("record", "expected a safe integer, not negative zero");
			return String(item);
		}
		if (
			typeof item !== "object" ||
			(!Array.isArray(item) &&
				Object.getPrototypeOf(item) !== Object.prototype &&
				Object.getPrototypeOf(item) !== null)
		)
			fail("record", "expected a plain JSON value");
		if (active.has(item)) fail("record", "cyclic value");
		active.add(item);
		let result;
		if (Array.isArray(item)) {
			if (
				Object.keys(item).length !== item.length ||
				Reflect.ownKeys(item).length !== item.length + 1
			)
				fail("record", "expected a dense JSON array without extra properties");
			const values = evaluation
				? Array.from({ length: item.length }, (_unused, index) => {
						const descriptor = Object.getOwnPropertyDescriptor(
							item,
							String(index),
						);
						if (!Object.hasOwn(descriptor, "value"))
							fail("record", "accessor properties are not JSON data");
						return descriptor.value;
					})
				: item;
			result = `[${Array.from(values, encode).join(",")}]`;
		} else {
			if (Reflect.ownKeys(item).length !== Object.keys(item).length)
				fail("record", "expected enumerable string keys");
			const keys = Object.keys(item);
			keys.forEach(validString);
			keys.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
			result =
				"{" +
				keys
					.map((key) => {
						const descriptor = Object.getOwnPropertyDescriptor(item, key);
						if (!Object.hasOwn(descriptor, "value"))
							fail("record", "accessor properties are not JSON data");
						return `${string(key)}:${encode(descriptor.value)}`;
					})
					.join(",") +
				"}";
		}
		active.delete(item);
		return result;
	}
	return Buffer.from(encode(value));
}

export function canonicalJSON(value) {
	return canonicalRecord(value, false);
}
export function canonicalEvaluationJSON(value) {
	return canonicalRecord(value, true);
}

function framedRecordHash(domain, bytes) {
	return createHash("sha256")
		.update(Buffer.from(validString(domain)))
		.update(Buffer.from([0]))
		.update(u64(bytes.length))
		.update(bytes)
		.digest("hex");
}

export function hashRecord(domain, value) {
	return framedRecordHash(domain, canonicalJSON(value));
}

export function hashEvaluationRecord(domain, value) {
	if (
		![
			"agent-profiles/evaluation-plan/v1",
			"agent-profiles/evaluation-result/v1",
		].includes(domain)
	)
		fail("record domain", "expected an evaluation plan or result domain");
	return framedRecordHash(domain, canonicalEvaluationJSON(value));
}

function parseJSONRecord(bytes, evaluation) {
	const text = decode(bytes, "record", false);
	const value = JSON.parse(text);
	// JSON.parse enforces JSON syntax; the existing YAML AST parser detects decoded duplicate keys.
	const document = parseDocument(text, { schema: "json" });
	if (document.errors.length || document.warnings.length)
		fail(
			"record",
			[...document.errors, ...document.warnings]
				.map((error) => error.message)
				.join("\n"),
		);
	visit(document, {
		Scalar(_key, node) {
			if (
				!evaluation &&
				typeof node.value === "number" &&
				!/^-?(?:0|[1-9][0-9]*)$/.test(node.source)
			)
				fail("record", "expected a decimal integer literal");
		},
	});
	canonicalRecord(value, evaluation);
	return value;
}

export function parseRecord(bytes) {
	return parseJSONRecord(bytes, false);
}
export function parseEvaluationRecord(bytes) {
	return parseJSONRecord(bytes, true);
}
