import { randomUUID } from "node:crypto";
import {
	type BigIntStats,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { errorCode, errorMessage } from "./files.ts";
import { harness2Materializer } from "./harness2-tree.ts";
import {
	encodeComponent,
	publish,
	readStoreFile,
	rootPath,
	safePath,
	sameStat,
	statOrNull,
	storeRoot,
	writeFlushed,
} from "./package-store.ts";
import {
	canonicalJSON,
	hashRecord,
	hashTree,
	parseRecord,
	type Untyped,
	validateMembers,
} from "./packages.ts";
import { reconstructStamp } from "./stamps.ts";

const PLAN_DOMAIN = "agent-profiles/materialization-plan/v1";
const TREE_DOMAIN = "agent-profiles/materialized-tree/v1";
const adapter = { id: "filesystem-v1", contractVersion: 1 };
const capabilities = {
	bytePreservation: "verified",
	filesystemIsolation: "verified",
	nativeLayout: "unsupported",
	nativeInvocation: "unsupported",
	hostVisibilityIsolation: "unverified",
	runtimeRendering: "unverified",
};
const materializers = [
	{
		identity: adapter,
		capabilities,
		validateOptions: (options: Untyped) => keys(options, "options", []),
		validateMappings: mappings,
		render: renderFilesystem,
	},
	harness2Materializer,
];
const compare = (a: Untyped, b: Untyped) =>
	Buffer.compare(Buffer.from(a), Buffer.from(b));
const equal = (a: Untyped, b: Untyped) =>
	canonicalJSON(a).equals(canonicalJSON(b));
const nullable = (a: Untyped, b: Untyped) =>
	a === b ? 0 : a === null ? -1 : b === null ? 1 : compare(a, b);
const mappingOrder = (a: Untyped, b: Untyped) =>
	compare(a.outputPath, b.outputPath) ||
	nullable(a.binding, b.binding) ||
	compare(a.sourcePath, b.sourcePath) ||
	compare(a.sourceKind, b.sourceKind) ||
	compare(a.sourceDigest, b.sourceDigest);

function fail(location: string, message: string): never {
	throw new Error(`${location}: ${message}`);
}
function object(value: Untyped, location: string) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		fail(location, "expected a plain object");
	if (
		Reflect.ownKeys(value).length !== Object.keys(value).length ||
		Object.values(Object.getOwnPropertyDescriptors(value)).some(
			(descriptor) => !Object.hasOwn(descriptor, "value"),
		)
	)
		fail(location, "expected enumerable data fields");
}
function keys(
	value: Untyped,
	location: string,
	required: readonly string[],
	optional: readonly string[] = [],
) {
	object(value, location);
	for (const key of Object.keys(value))
		if (![...required, ...optional].includes(key))
			fail(`${location}.${key}`, "unknown field");
	for (const key of required)
		if (!Object.hasOwn(value, key))
			fail(`${location}.${key}`, "required field missing");
}
function digest(value: Untyped, location: string) {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
		fail(location, "expected 64 lowercase hexadecimal characters");
}
function portable(value: Untyped) {
	validateMembers([{ path: value, type: "file", nlink: 1 }]);
	if (value.split("/").some((part: Untyped) => Buffer.byteLength(part) > 255))
		fail("path-length", value);
}
function contract(selected: Untyped, options: Untyped) {
	keys(selected, "adapter", ["id", "contractVersion"]);
	object(options, "options");
	const implementation = materializers.find((item) =>
		equal(selected, item.identity),
	);
	if (!implementation)
		fail("adapter", "unsupported adapter or contractVersion");
	implementation.validateOptions(options);
	return implementation;
}
function mappings(rows: Untyped) {
	if (!Array.isArray(rows)) fail("mappings", "expected array");
	for (const row of rows) {
		keys(row, "mapping", [
			"binding",
			"sourceKind",
			"sourceDigest",
			"packageDigest",
			"sourcePath",
			"outputPath",
			"hostName",
		]);
		if (
			row.binding !== null &&
			(typeof row.binding !== "string" ||
				!/^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/.test(row.binding))
		)
			fail("mapping.binding", "invalid owner");
		if (!["blob", "package", "snapshot", "revision"].includes(row.sourceKind))
			fail("mapping.sourceKind", "unsupported backing");
		digest(row.sourceDigest, "mapping.sourceDigest");
		if (
			row.packageDigest !==
				(row.sourceKind === "package" ? row.sourceDigest : null) ||
			row.hostName !== null
		)
			fail("mapping", "invalid packageDigest or hostName");
		portable(row.sourcePath);
		portable(row.outputPath);
		if (
			!row.outputPath.startsWith("content/") ||
			(row.sourceKind === "snapshot" && row.sourcePath !== "snapshot.json") ||
			(row.sourceKind === "revision" && row.sourcePath !== "record.json")
		)
			fail("mapping", "invalid path");
	}
	for (let i = 1; i < rows.length; i++)
		if (mappingOrder(rows[i - 1], rows[i]) >= 0)
			fail("mappings", "expected sorted unique mappings");
}

function build(
	stampDigest: Untyped,
	selected: Untyped,
	adapterSelection: Untyped,
	options: Untyped,
) {
	const implementation = contract(adapterSelection, options);
	digest(stampDigest, "stampDigest");
	let root: string, snapshotBytes: Buffer;
	try {
		root = storeRoot(selected);
		snapshotBytes = readStoreFile(
			root,
			`stamps/sha256/${stampDigest}/snapshot.json`,
		);
	} catch (error) {
		throw new Error(`stamp-missing:${stampDigest}: ${errorMessage(error)}`, {
			cause: error,
		});
	}
	const snapshot = parseRecord(snapshotBytes);
	if (
		!canonicalJSON(snapshot).equals(snapshotBytes) ||
		hashRecord(
			snapshot.stampVersion === 2
				? "agent-profiles/stamp/v2"
				: "agent-profiles/stamp/v1",
			snapshot,
		) !== stampDigest
	)
		fail("stamp-mismatch", stampDigest);
	let retained: Untyped;
	try {
		retained = reconstructStamp({ digest: stampDigest, storeRoot: root });
	} catch (error) {
		throw new Error(`backing-missing:${errorMessage(error)}`, { cause: error });
	}
	if (
		!readStoreFile(root, `stamps/sha256/${stampDigest}/snapshot.json`).equals(
			snapshotBytes,
		)
	)
		fail("stamp-mismatch", "snapshot changed during reconstruction");
	const { files, rows, content } = implementation.render({
		stampDigest,
		snapshot,
		snapshotBytes,
		retained,
		options,
	});
	validateMembers(
		files.map((file) => ({ path: file.path, type: "file", nlink: 1 })),
	);
	implementation.validateMappings(rows);
	return {
		plan: {
			planVersion: 1,
			stampDigest,
			adapter: { ...implementation.identity },
			options: { ...options },
			files,
			mappings: rows,
			capabilities: { ...implementation.capabilities },
		},
		content,
	};
}

function renderFilesystem({
	stampDigest,
	snapshot,
	snapshotBytes,
	retained,
}: Untyped) {
	const files: Untyped[] = [],
		rows: Untyped[] = [],
		content: Untyped[] = [];
	const add = (
		outputPath: Untyped,
		backing: Untyped,
		binding: Untyped,
		bytes: Untyped,
	) => {
		portable(outputPath);
		files.push({ path: outputPath, backing: { ...backing } });
		content.push({ path: outputPath.slice("content/".length), bytes });
		rows.push({
			binding,
			sourceKind: backing.type,
			sourceDigest: backing.sha256,
			packageDigest: backing.type === "package" ? backing.sha256 : null,
			sourcePath: backing.type === "snapshot" ? "snapshot.json" : backing.path,
			outputPath,
			hostName: null,
		});
	};
	add(
		"content/snapshot.json",
		{ type: "snapshot", sha256: stampDigest },
		null,
		snapshotBytes,
	);
	const owner = (e: Untyped) =>
		snapshot.stampVersion === 2 && e.package
			? (e.owner ?? e.package.binding)
			: `${e.kind === "profile" ? "profiles" : e.kind === "role" ? "roles" : "skills"}.${e.id}`;
	retained.composition.forEach((entry: Untyped, i: Untyped) => {
		add(
			`content/instructions/${String(i).padStart(4, "0")}.md`,
			entry.backing,
			owner(entry),
			entry.bytes,
		);
		if (snapshot.stampVersion === 2 && entry.package) {
			const mapping = rows.at(-1);
			for (const direct of [
				...retained.required,
				...retained.available,
				...retained.selectionBindings.map((row: Untyped) => ({
					package: row.root,
				})),
			])
				if (
					direct.package &&
					direct.package.sha256 === entry.package.sha256 &&
					direct.package.revisionDigest === entry.package.revisionDigest &&
					direct.package.binding !== mapping.binding
				)
					rows.push({ ...mapping, binding: direct.package.binding });
		}
	});
	const composed = new Set(
		retained.composition.slice(2).map((e: Untyped) => e.id),
	);
	for (const entry of retained.available)
		if (
			entry.type === "instruction" &&
			!(snapshot.stampVersion === 2
				? retained.composition.some(
						(part: Untyped) =>
							part.backing.type === entry.backing.type &&
							part.backing.sha256 === entry.backing.sha256 &&
							part.backing.path === entry.backing.path &&
							(part.package?.revisionDigest ?? null) ===
								(entry.package?.revisionDigest ?? null),
					)
				: composed.has(entry.id))
		) {
			add(
				`content/available/${encodeComponent(entry.id)}/entry.md`,
				entry.backing,
				`skills.${entry.id}`,
				entry.bytes,
			);
		}
	for (const resource of retained.resources)
		add(
			`content/resources/${encodeComponent(resource.binding)}/${resource.backing.path}`,
			resource.backing,
			resource.binding,
			resource.bytes,
		);
	const selections =
		snapshot.stampVersion === 2
			? [
					...retained.composition,
					...retained.required,
					...retained.available,
					...retained.selectionBindings.map((row: Untyped) => ({
						package: row.root,
					})),
					...retained.workflowActors.flatMap((actor: Untyped) =>
						actor.bindings.flatMap((row: Untyped) =>
							row.closure.map((pin: Untyped) => ({
								package: { ...pin, binding: row.root.binding },
							})),
						),
					),
				]
			: [
					...retained.composition.slice(0, 2),
					...retained.required,
					...retained.available,
				];
	if (snapshot.stampVersion === 2) {
		const records = new Map<string, Untyped>(
				retained.revisions.map((row: Untyped) => [
					row.recordDigest,
					parseRecord(row.bytes),
				]),
			),
			seen = new Set<string>();
		function attribute(p: Untyped, binding: Untyped) {
			const key = `${binding}:${p.name}@${p.version}:${p.sha256}:${p.revisionDigest}`;
			if (seen.has(key)) return;
			seen.add(key);
			selections.push({ package: { ...p, binding } });
			for (const dependency of records.get(p.revisionDigest)?.dependencies ??
				[])
				attribute(dependency, binding);
		}
		for (const entry of [...retained.required, ...retained.available])
			if (entry.package) attribute(entry.package, entry.package.binding);
	}
	const trees = new Set();
	for (const pkg of retained.packages) {
		if (snapshot.stampVersion === 2 && trees.has(pkg.sha256)) continue;
		trees.add(pkg.sha256);
		const owners = [
			...new Set(
				selections
					.filter((e) => e.package?.sha256 === pkg.sha256)
					.map((e) => e.package.binding),
			),
		];
		for (const member of pkg.files) {
			const outputPath = `content/packages/sha256/${pkg.sha256}/${member.path}`;
			add(
				outputPath,
				{ type: "package", sha256: pkg.sha256, path: member.path },
				owners[0],
				member.bytes,
			);
			for (const binding of owners.slice(1))
				rows.push({ ...rows.at(-1), binding });
		}
	}
	for (const entry of retained.shared)
		if (entry.status === "captured")
			add(`content/shared/${entry.path}`, entry.backing, null, entry.bytes);
	if (snapshot.stampVersion === 2) {
		for (const revision of retained.revisions)
			add(
				`content/revisions/sha256/${revision.recordDigest}.json`,
				{
					type: "revision",
					sha256: revision.recordDigest,
					path: "record.json",
				},
				null,
				revision.bytes,
			);
		const unique = [
			...new Map(
				rows.map((row) => [canonicalJSON(row).toString("hex"), row]),
			).values(),
		];
		rows.splice(0, rows.length, ...unique);
	}
	files.sort((a, b) => compare(a.path, b.path));
	rows.sort(mappingOrder);
	content.sort((a, b) => compare(a.path, b.path));
	return { files, rows, content };
}

/** @param {{stampDigest: string, storeRoot?: string, adapterId: string, adapterContractVersion: number, options?: object}} input */
export function planMaterialization(input: Untyped) {
	keys(
		input,
		"input",
		["stampDigest", "adapterId", "adapterContractVersion"],
		["storeRoot", "options"],
	);
	return build(
		input.stampDigest,
		input.storeRoot,
		{ id: input.adapterId, contractVersion: input.adapterContractVersion },
		input.options === undefined && !Object.hasOwn(input, "options")
			? {}
			: input.options,
	).plan;
}

/** @param {{stampDigest: string, storeRoot?: string, adapterId: string, adapterContractVersion: number, options?: object, destination: string, outputRoot: string, deniedRoots: string[]}} input */
export function materializeStamp(input: Untyped) {
	keys(
		input,
		"input",
		[
			"stampDigest",
			"adapterId",
			"adapterContractVersion",
			"destination",
			"outputRoot",
			"deniedRoots",
		],
		["storeRoot", "options"],
	);
	// Refuse unsafe destinations before planning can read immutable backing.
	const context = boundary(input, true);
	if (statOrNull(context.lock)) fail("materialization-busy", context.target);
	const { destination, outputRoot, deniedRoots, ...selection } = input;
	const plan = planMaterialization(selection);
	return materialize({
		plan,
		storeRoot: input.storeRoot,
		destination,
		outputRoot,
		deniedRoots,
	});
}

function receiptFor(plan: Untyped, content: Untyped) {
	return {
		receiptVersion: 1,
		stampDigest: plan.stampDigest,
		planDigest: hashRecord(PLAN_DOMAIN, plan),
		adapter: { ...plan.adapter },
		options: { ...plan.options },
		outputDigest: hashTree(content, TREE_DOMAIN),
		mappings: plan.mappings,
		capabilities: { ...plan.capabilities },
		status: "committed",
	};
}
function receiptSchema(receipt: Untyped) {
	keys(receipt, "receipt", [
		"receiptVersion",
		"stampDigest",
		"planDigest",
		"adapter",
		"options",
		"outputDigest",
		"mappings",
		"capabilities",
		"status",
	]);
	if (receipt.receiptVersion !== 1 || receipt.status !== "committed")
		fail("receipt", "unsupported version or status");
	for (const key of ["stampDigest", "planDigest", "outputDigest"])
		digest(receipt[key], key);
	const implementation = contract(receipt.adapter, receipt.options);
	implementation.validateMappings(receipt.mappings);
	if (!equal(receipt.capabilities, implementation.capabilities))
		fail("capabilities", "unsupported claims");
}
function directory(target: Untyped) {
	const stat = lstatSync(target, { bigint: true });
	if (stat.isSymbolicLink()) fail(target, "link/junction is forbidden");
	if (!stat.isDirectory()) fail(target, "expected an ordinary directory");
	return stat;
}
function identity(target: Untyped, expected: Untyped) {
	const actual = directory(target);
	if (actual.dev !== expected.dev || actual.ino !== expected.ino)
		fail(target, "directory identity changed");
}
function localAbsolute(value: Untyped, location: string) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		fail(location, "expected absolute local path");
	if (
		/^[\\/]{2}|^[a-z][a-z0-9+.-]*:/i.test(value) &&
		!/^[a-z]:[\\/]/i.test(value)
	)
		fail(location, "unsupported-filesystem: nonlocal path");
	if (
		!path.isAbsolute(value) ||
		value.split(/[\\/]/).some((part: Untyped) => part === ".." || part === ".")
	)
		fail(location, "expected absolute path without traversal");
	return path.resolve(value);
}
function inside(a: Untyped, b: Untyped) {
	const relative = path.relative(a, b);
	return (
		!path.isAbsolute(relative) &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`)
	);
}
function boundary(input: Untyped, absent: Untyped) {
	const output = localAbsolute(input.outputRoot, "outputRoot");
	const requested = localAbsolute(input.destination, "destination");
	if (!Array.isArray(input.deniedRoots) || input.deniedRoots.length === 0)
		fail("boundary-context-required", "deniedRoots must be a nonempty array");
	const denied = input.deniedRoots.map((value: Untyped) =>
		rootPath(localAbsolute(value, "deniedRoots"), "deniedRoots"),
	);
	denied.push(storeRoot(input.storeRoot));
	directory(output);
	const root = realpathSync(output),
		rootStat = directory(root);
	if (path.dirname(requested) !== output)
		fail("destination", "expected an absent direct child of outputRoot");
	const target = path.basename(requested);
	portable(target);
	const destination = path.join(root, target);
	const prefix = `.materialize-${encodeComponent(target.toLowerCase())}`;
	const check = (relative: string) => {
		portable(relative);
		const full = safePath(root, relative);
		for (const protectedRoot of denied)
			if (
				inside(protectedRoot, full) ||
				inside(full, protectedRoot) ||
				inside(root, protectedRoot)
			)
				fail("protected overlap", full);
		return full;
	};
	const lock = check(`${prefix}.lock`);
	if (absent && statOrNull(destination))
		fail("destination-exists", destination);
	check(target);
	const recheck = () => {
		identity(root, rootStat);
		if (absent && statOrNull(destination))
			fail("destination-exists", destination);
		check(target);
		check(`${prefix}.lock`);
	};
	recheck();
	return { root, rootStat, destination, target, prefix, lock, check, recheck };
}

// Guard every descendant and read regular members through the shared no-follow reader.
function tree(root: string) {
	const members: Untyped[] = [],
		files: Untyped[] = [],
		rootStat = directory(root);
	function walk(relative = "") {
		const current = relative ? safePath(root, relative) : root;
		directory(current);
		for (const name of readdirSync(current).sort(compare)) {
			const memberPath = relative ? `${relative}/${name}` : name;
			portable(memberPath);
			const full = safePath(root, memberPath),
				stat = lstatSync(full, { bigint: true });
			const type = stat.isDirectory()
				? "directory"
				: stat.isFile()
					? "file"
					: "special";
			members.push({ path: memberPath, type, nlink: Number(stat.nlink) });
			validateMembers([members.at(-1)]);
			if (type === "directory") walk(memberPath);
			else
				files.push({
					path: memberPath,
					bytes: readStoreFile(root, memberPath),
				});
			if (!sameStat(stat, lstatSync(full, { bigint: true })))
				fail(memberPath, "output changed during read");
		}
	}
	walk();
	validateMembers(members);
	if (!sameStat(rootStat, directory(root)))
		fail(root, "output membership changed during read");
	return files.sort((a, b) => compare(a.path, b.path));
}

/** @param {{destination: string, expectedStampDigest: string, storeRoot?: string}} input */
export function verifyMaterialization(input: Untyped) {
	keys(input, "input", ["destination", "expectedStampDigest"], ["storeRoot"]);
	digest(input.expectedStampDigest, "expectedStampDigest");
	const findings: string[] = [];
	const result = () => ({ verified: findings.length === 0, findings });
	let destination: string;
	try {
		const selected = localAbsolute(input.destination, "destination");
		directory(selected);
		destination = realpathSync(selected);
	} catch (error) {
		findings.push(`output-missing:${errorMessage(error)}`);
		return result();
	}
	let bytes: Buffer, receipt: Untyped;
	try {
		bytes = readStoreFile(destination, "receipt.json");
	} catch (error) {
		findings.push(`receipt-missing:receipt.json: ${errorMessage(error)}`);
		return result();
	}
	try {
		receipt = parseRecord(bytes);
		if (!canonicalJSON(receipt).equals(bytes))
			fail("receipt.json", "noncanonical encoding");
	} catch (error) {
		findings.push(`receipt-malformed:receipt.json: ${errorMessage(error)}`);
		return result();
	}
	try {
		receiptSchema(receipt);
	} catch (error) {
		findings.push(`receipt-schema:receipt.json: ${errorMessage(error)}`);
		return result();
	}
	if (receipt.stampDigest !== input.expectedStampDigest)
		findings.push(`stamp-mismatch:${input.expectedStampDigest}`);
	let expected: Untyped;
	try {
		expected = build(
			input.expectedStampDigest,
			input.storeRoot,
			receipt.adapter,
			receipt.options,
		);
	} catch (error) {
		findings.push(errorMessage(error));
		return result();
	}
	const wanted = receiptFor(expected.plan, expected.content);
	if (
		receipt.planDigest !== wanted.planDigest ||
		!equal(receipt.mappings, wanted.mappings) ||
		!equal(receipt.adapter, wanted.adapter) ||
		!equal(receipt.options, wanted.options) ||
		!equal(receipt.capabilities, wanted.capabilities)
	)
		findings.push("plan-mismatch:receipt.json");
	let actual: Untyped;
	try {
		actual = tree(destination);
	} catch (error) {
		findings.push(`output-mismatch:${errorMessage(error)}`);
		return result();
	}
	const expectedFiles = new Map<string, Buffer>(
		expected.content.map((file: Untyped) => [
			`content/${file.path}`,
			file.bytes,
		]),
	);
	const actualFiles = new Map<string, Buffer>(
		actual.map((file: Untyped) => [file.path, file.bytes]),
	);
	for (const [name, content] of expectedFiles) {
		const actualBytes = actualFiles.get(name);
		if (!actualBytes) findings.push(`output-missing:${name}`);
		else if (!content.equals(actualBytes))
			findings.push(`output-mismatch:${name}`);
	}
	for (const name of actualFiles.keys())
		if (name !== "receipt.json" && !expectedFiles.has(name))
			findings.push(`output-extra:${name}`);
	const content = actual
		.filter((file: Untyped) => file.path.startsWith("content/"))
		.map((file: Untyped) => ({
			...file,
			path: file.path.slice("content/".length),
		}));
	if (
		hashTree(content, TREE_DOMAIN) !== receipt.outputDigest ||
		wanted.outputDigest !== receipt.outputDigest
	)
		findings.push("output-digest-mismatch:content");
	return result();
}

function readOwner(context: Untyped, stampDigest: Untyped) {
	directory(context.lock);
	if (readdirSync(context.lock).join(",") !== "owner.json")
		fail("ownership", "unknown lock membership");
	const bytes = readStoreFile(context.lock, "owner.json"),
		owner = parseRecord(bytes);
	if (!canonicalJSON(owner).equals(bytes))
		fail("ownership", "noncanonical owner record");
	keys(owner, "owner", ["operation", "target", "stampDigest", "staging"]);
	if (
		typeof owner.operation !== "string" ||
		!/^[a-zA-Z0-9-]+$/.test(owner.operation) ||
		typeof owner.target !== "string" ||
		owner.target.toLowerCase() !== context.target.toLowerCase() ||
		owner.stampDigest !== stampDigest ||
		owner.staging !== `${context.prefix}-${owner.operation}.stage`
	)
		fail("ownership", "target/stamp/staging relationship mismatch");
	portable(owner.target);
	context.check(owner.staging);
	return owner;
}

/** @param {{plan: ReturnType<typeof planMaterialization>, storeRoot?: string, destination: string, outputRoot: string, deniedRoots: string[]}} input */
export function materialize(input: Untyped) {
	keys(
		input,
		"input",
		["plan", "destination", "outputRoot"],
		["storeRoot", "deniedRoots"],
	);
	const context = boundary(input, true);
	if (statOrNull(context.lock)) fail("materialization-busy", context.target);
	keys(input.plan, "plan", [
		"planVersion",
		"stampDigest",
		"adapter",
		"options",
		"files",
		"mappings",
		"capabilities",
	]);
	contract(input.plan.adapter, input.plan.options);
	const operation = randomUUID(),
		staging = `${context.prefix}-${operation}.stage`;
	const stage = context.check(staging);
	if (statOrNull(stage)) fail("ownership", "staging already exists");
	const expected = build(
		input.plan.stampDigest,
		input.storeRoot,
		input.plan.adapter,
		input.plan.options,
	);
	if (!equal(input.plan, expected.plan))
		fail("plan-mismatch", "supplied plan differs from verified reconstruction");
	const receipt = receiptFor(expected.plan, expected.content);
	const owner = {
		operation,
		target: context.target,
		stampDigest: expected.plan.stampDigest,
		staging,
	};
	context.recheck();
	try {
		mkdirSync(context.lock);
	} catch (error) {
		if (errorCode(error) === "EEXIST")
			fail("materialization-busy", context.target);
		throw error;
	}
	const lockStat = directory(context.lock);
	let stageStat: BigIntStats | null | undefined,
		committed = false,
		ownerWritten = false;
	const owned = () => {
		context.recheck();
		identity(context.lock, lockStat);
		if (!equal(readOwner(context, owner.stampDigest), owner))
			fail("ownership", "owner changed");
		if (stageStat) identity(stage, stageStat);
	};
	try {
		writeFlushed(
			safePath(context.root, `${context.prefix}.lock/owner.json`),
			canonicalJSON(owner),
		);
		ownerWritten = true;
		mkdirSync(stage);
		stageStat = directory(stage);
		for (const file of expected.content) {
			owned();
			const relative = `content/${file.path}`;
			const target = safePath(stage, relative);
			mkdirSync(path.dirname(target), { recursive: true });
			safePath(stage, relative);
			writeFlushed(target, file.bytes);
			if (!readStoreFile(stage, relative).equals(file.bytes))
				fail("output-mismatch", relative);
		}
		owned();
		writeFlushed(safePath(stage, "receipt.json"), canonicalJSON(receipt));
		const staged = verifyMaterialization({
			destination: stage,
			expectedStampDigest: owner.stampDigest,
			storeRoot: input.storeRoot,
		});
		if (!staged.verified)
			fail("staging verification", staged.findings.join("; "));
		owned();
		publish(stage, context.destination, renameSync);
		committed = true;
		if (
			!readStoreFile(context.destination, "receipt.json").equals(
				canonicalJSON(receipt),
			)
		)
			fail("readback", "receipt.json changed after publication");
		const verification = verifyMaterialization({
			destination: context.destination,
			expectedStampDigest: owner.stampDigest,
			storeRoot: input.storeRoot,
		});
		if (!verification.verified)
			fail("readback", verification.findings.join("; "));
		identity(context.root, context.rootStat);
		identity(context.lock, lockStat);
		if (!equal(readOwner(context, owner.stampDigest), owner))
			fail("ownership", "owner changed after publication");
		rmSync(context.lock, { recursive: true });
		return receipt;
	} catch (error) {
		if (committed)
			throw new Error(`committed-but-unacknowledged: ${errorMessage(error)}`, {
				cause: error,
			});
		try {
			identity(context.root, context.rootStat);
			identity(context.lock, lockStat);
			if (ownerWritten && !equal(readOwner(context, owner.stampDigest), owner))
				fail("ownership", "cleanup owner changed");
			if (statOrNull(stage)) {
				if (!stageStat) fail("ownership", "unsafe staging identity");
				identity(stage, stageStat);
				tree(stage);
				rmSync(stage, { recursive: true });
			}
			rmSync(context.lock, { recursive: true });
		} catch (cleanup) {
			throw new Error(
				`${errorMessage(error)}; cleanup: ${errorMessage(cleanup)}`,
				{
					cause: error,
				},
			);
		}
		throw error;
	}
}

/** @param {{destination: string, outputRoot: string, expectedStampDigest: string, storeRoot?: string, deniedRoots: string[], confirmNoActiveWriter: boolean}} input */
export function recoverMaterialization(input: Untyped) {
	keys(
		input,
		"input",
		[
			"destination",
			"outputRoot",
			"expectedStampDigest",
			"confirmNoActiveWriter",
		],
		["storeRoot", "deniedRoots"],
	);
	if (input.confirmNoActiveWriter !== true)
		fail("confirmation", "requires confirmNoActiveWriter === true");
	digest(input.expectedStampDigest, "expectedStampDigest");
	const context = boundary(input, false);
	const locked = statOrNull(context.lock);
	// Set together when the writer lock exists.
	let owner: Untyped,
		stage: string | undefined,
		stageStat: BigIntStats | null | undefined;
	if (locked) {
		owner = readOwner(context, input.expectedStampDigest);
		stage = context.check(owner.staging);
		stageStat = statOrNull(stage);
		if (stageStat) tree(stage);
	}
	// An orphan without its target owner cannot be attributed safely.
	for (const name of readdirSync(context.root))
		if (
			name.startsWith(`${context.prefix}-`) &&
			name.endsWith(".stage") &&
			name !== owner?.staging
		)
			fail("recovery ownership", `unknown staging ${name}`);
	const destination = owner ? context.check(owner.target) : context.destination;
	const finalStat = statOrNull(destination),
		requestedStat = statOrNull(context.destination);
	if (
		finalStat &&
		requestedStat &&
		(finalStat.dev !== requestedStat.dev || finalStat.ino !== requestedStat.ino)
	) {
		fail(
			"recovery ambiguity",
			"requested and owner-recorded finals have distinct identities",
		);
	}
	const verification = finalStat
		? verifyMaterialization({
				destination,
				expectedStampDigest: input.expectedStampDigest,
				storeRoot: input.storeRoot,
			})
		: null;
	const removed: string[] = [];
	if (verification && !verification.verified) return { removed, verification };
	if (owner) {
		context.recheck();
		identity(context.lock, locked);
		if (!equal(readOwner(context, input.expectedStampDigest), owner))
			fail("ownership", "recovery owner changed");
		if (stageStat && stage) {
			identity(stage, stageStat);
			tree(stage);
		}
		if (stageStat && stage) {
			rmSync(stage, { recursive: true });
			removed.push(owner.staging);
		}
		rmSync(context.lock, { recursive: true });
		removed.push(path.basename(context.lock));
	}
	return { removed, verification };
}
