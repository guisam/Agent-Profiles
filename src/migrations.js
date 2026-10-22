import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { applyChanges, errorCode, errorMessage } from "./files.ts";
import { integrations } from "./integrations.ts";
import { installDependencies } from "./package-lock.ts";
import {
	candidateIndex,
	candidateReservation,
	inStoreSession,
	lookupPackage,
	storeRoot as packageStoreRoot,
	publish,
	readStoreFile,
	readTree,
	retainPackageObject,
	rootPath,
	safePath,
	writeFlushed,
} from "./package-store.ts";
import {
	canonicalEvaluationJSON,
	canonicalJSON,
	hashEvaluationRecord,
	hashRecord,
	parseEvaluationRecord,
	parseRecord,
	readPackage,
	validateMembers,
} from "./packages.ts";
import {
	parseYaml,
	parseYamlDocument,
	resolveCapture,
	resolveSharingSelection,
	validateConfiguration,
} from "./resolve.ts";
import {
	labelPath,
	lookupRevisionManifest,
	readPromotionDecision,
	readPromotionIndex,
	readRevisionRecord,
	retainCandidateRevision,
	validateDecision,
} from "./revisions.ts";
import {
	createCandidateStamp,
	createStamp,
	reconstructStamp,
} from "./stamps.js";

const directory = ".agent-profiles/migrations";
const writer = ".agent-profiles/.migration-writer";
const configFile = ".agent-profiles/agents.yaml";
const lockFile = ".agent-profiles/agent-profiles.lock";
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^migration-[a-f0-9-]{36}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const assignmentKey = (a) => JSON.stringify([a.role, a.model, a.host]);

function fields(value, required, optional = [], label = "migration") {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label}: expected object`);
	for (const key of Object.keys(value))
		if (![...required, ...optional].includes(key))
			throw new Error(`${label}: unknown field ${key}`);
	for (const key of required)
		if (!Object.hasOwn(value, key)) throw new Error(`${label}: missing ${key}`);
}
function text(value, label) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		throw new Error(`${label}: expected nonempty text without NUL`);
}
function assignment(value) {
	fields(value, ["role", "model", "host"], [], "assignment");
	for (const key of ["role", "model", "host"]) text(value[key], key);
	if (!integrations.some((adapter) => adapter.id === value.host))
		throw new Error("host: unsupported host");
}
function migrationId(id) {
	if (typeof id !== "string" || !idPattern.test(id))
		throw new Error("migration id: expected a generated migration UUID");
	return id;
}
function portablePath(value) {
	validateMembers([{ path: value, type: "file", nlink: 1 }]);
	return value;
}
function file(root, relative) {
	return safePath(root, portablePath(relative));
}
function rootDirectory(root) {
	const selected = rootPath(root, "root");
	if (!existsSync(file(selected, ".agent-profiles")))
		throw new Error("migration: initialize .agent-profiles first");
	return selected;
}
function records(root) {
	const folder = file(root, directory);
	if (!existsSync(folder)) return [];
	if (!lstatSync(folder).isDirectory())
		throw new Error("migrations: expected directory");
	return readdirSync(folder)
		.sort(compare)
		.map((id) => readRecord(root, migrationId(id)));
}
function readRecord(root, id, bytes = undefined) {
	migrationId(id);
	const record = parseRecord(
		bytes ?? readStoreFile(root, `${directory}/${id}/record.json`),
	);
	fields(record, [
		"recordVersion",
		"id",
		"state",
		"scope",
		"sharing",
		"shared",
		"collateral",
		"bases",
		"workspace",
		"files",
		"reason",
	]);
	if (
		record.recordVersion !== 1 ||
		record.id !== id ||
		!["open", "abandoned"].includes(record.state)
	)
		throw new Error("migration: unsupported record identity/version/state");
	if (!["fork", "shared"].includes(record.sharing))
		throw new Error("sharing: expected fork or shared");
	if (record.workspace !== `${directory}/${id}/workspace`)
		throw new Error("migration workspace: unexpected path");
	for (const key of ["scope", "shared", "collateral", "bases", "files"])
		if (!Array.isArray(record[key]))
			throw new Error(`migration ${key}: expected array`);
	if (record.scope.length !== 1)
		throw new Error("migration scope: expected one primary assignment");
	[...record.scope, ...record.collateral].forEach(assignment);
	const expected = [...record.scope, ...record.collateral].map(assignmentKey);
	if (new Set(expected).size !== expected.length)
		throw new Error("migration scope: duplicate assignment");
	for (const item of record.shared) {
		fields(item, ["assignment", "bindings"]);
		assignment(item.assignment);
		if (
			!Array.isArray(item.bindings) ||
			!item.bindings.length ||
			item.bindings.some(
				(b) =>
					typeof b !== "string" ||
					!/^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/.test(b),
			)
		)
			throw new Error("shared bindings: invalid binding");
	}
	if (
		(record.sharing === "fork" && record.collateral.length) ||
		(record.sharing === "shared" &&
			JSON.stringify(record.collateral) !==
				JSON.stringify(record.shared.map((item) => item.assignment)))
	)
		throw new Error("migration collateral: inconsistent sharing decision");
	if (record.bases.length !== expected.length)
		throw new Error("migration bases: incomplete scope coverage");
	record.bases.forEach((base, index) => {
		fields(base, ["assignment", "stamp"]);
		assignment(base.assignment);
		if (
			assignmentKey(base.assignment) !== expected[index] ||
			!digestPattern.test(base.stamp)
		)
			throw new Error("migration bases: invalid assignment or stamp");
	});
	record.files.forEach((member) => {
		fields(member, ["path", "sha256"]);
		portablePath(member.path);
		if (!digestPattern.test(member.sha256))
			throw new Error("migration files: invalid digest");
	});
	validateMembers(
		record.files.map((member) => ({
			path: member.path,
			type: "file",
			nlink: 1,
		})),
	);
	if (
		record.state === "open"
			? record.reason !== null
			: typeof record.reason !== "string" || !record.reason.trim()
	)
		throw new Error("migration reason: inconsistent state");
	file(root, record.workspace);
	return record;
}
function withWriter(root, action) {
	const lock = file(root, writer);
	try {
		mkdirSync(lock);
	} catch (error) {
		if (errorCode(error) === "EEXIST")
			throw new Error(
				"migration-busy: inspect the existing project migration writer before retrying",
			);
		throw error;
	}
	try {
		return action(lock);
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}
function selected({ resolution: resolved, evidence }) {
	const members = new Map(),
		identity = (pkg) => `package:${pkg.name}@${pkg.version}:${pkg.sha256}`;
	// Direct profile/role roots by kind: dependency and workflow parts can precede them in dependency-first context.
	for (const e of [
		...resolved.loaded.filter(
			(part) => part.kind === "profile" || part.kind === "role",
		),
		...resolved.required,
		...resolved.available,
	]) {
		const binding = `${e.kind === "profile" ? "profiles" : e.kind === "role" ? "roles" : "skills"}.${e.id}`;
		// Package identity is the exact revision; local declarations share by path.
		if (e.package) members.set(binding, identity(e.package));
		else if (e.type !== "host" && e.path)
			members.set(binding, `local:${e.path}`);
	}
	// Resolver-recorded package roots keep a root whose physical body was deduplicated with another root.
	for (const row of evidence.primary)
		members.set(row.root.binding, identity(row.root));
	return members;
}
function sharedAssignments(root, storeRoot, configuration, primary, captured) {
	const wanted = selected(captured),
		shared = [];
	const models = [
		...new Set([primary.model, ...configuration.get("models").keys()]),
	].sort(compare);
	for (const model of models)
		for (const role of [...configuration.get("roles").keys()].sort(compare))
			for (const adapter of integrations) {
				const item = { role, model, host: adapter.id };
				if (assignmentKey(item) === assignmentKey(primary)) continue;
				const other = selected(
					resolveSharingSelection({ root, storeRoot, configuration, ...item }),
				);
				const bindings = [...other]
					.filter(([, identity]) => [...wanted.values()].includes(identity))
					.map(([binding]) => binding)
					.sort(compare);
				if (bindings.length) shared.push({ assignment: item, bindings });
			}
	return shared.sort((a, b) =>
		compare(assignmentKey(a.assignment), assignmentKey(b.assignment)),
	);
}
function overlay(rebuilt) {
	const files = new Map();
	const add = (relative, bytes) => {
		portablePath(relative);
		if (files.has(relative) && !files.get(relative).equals(bytes))
			throw new Error(`migration workspace: conflicting backing ${relative}`);
		files.set(relative, bytes);
	};
	for (const e of [
		...rebuilt.composition,
		...rebuilt.available,
		...rebuilt.resources,
	]) {
		if (e.backing?.type === "blob" && e.bytes)
			add(`local/${e.backing.path}`, e.bytes);
	}
	for (const pkg of rebuilt.packages)
		for (const member of pkg.files)
			add(`packages/${pkg.sha256}/${member.path}`, member.bytes);
	validateMembers(
		[...files.keys()].map((p) => ({ path: p, type: "file", nlink: 1 })),
	);
	return files;
}

/** Start-only groundwork: no candidate publication, package fork or active binding mutation. */
function startMigrationOperation(input) {
	fields(input, ["root", "role", "model", "host"], ["storeRoot", "sharing"]);
	const scope = { role: input.role, model: input.model, host: input.host };
	assignment(scope);
	if (!["fork", "shared"].includes(input.sharing))
		throw new Error("sharing: explicitly choose fork or shared");
	const root = rootDirectory(input.root);
	// Refuse a redirected migration tree before any stamp/store writes.
	file(root, directory);
	const storeRoot = packageStoreRoot(input.storeRoot);
	for (const reserved of [directory, writer]) {
		const relative = path.relative(file(root, reserved), storeRoot);
		if (
			!relative ||
			(!path.isAbsolute(relative) &&
				relative !== ".." &&
				!relative.startsWith(`..${path.sep}`))
		) {
			throw new Error(
				"store overlap: choose a store outside migration records and the migration writer",
			);
		}
	}
	return withWriter(root, (lock) => {
		const configBytes = readStoreFile(root, configFile),
			configuration = parseYaml(configBytes.toString("utf8"));
		const lockBytes = existsSync(file(root, lockFile))
			? readStoreFile(root, lockFile)
			: null;
		const captured = resolveCapture({
				root,
				storeRoot,
				configuration,
				...scope,
			}),
			resolved = captured.resolution;
		scope.model = resolved.identity.canonical ?? resolved.identity.raw;
		const occupied = records(root).filter((record) => record.state === "open");
		const reserve = (assignments) => {
			for (const record of occupied)
				if (
					[...record.scope, ...record.collateral].some((a) =>
						assignments.some((b) => assignmentKey(a) === assignmentKey(b)),
					)
				) {
					throw new Error(
						`open migration ${record.id} already targets an assignment in this scope`,
					);
				}
		};
		// An occupied primary refuses before resolving unrelated tuples for sharing discovery.
		reserve([scope]);
		const shared = sharedAssignments(
			root,
			storeRoot,
			configuration,
			scope,
			captured,
		);
		const collateral =
			input.sharing === "shared" ? shared.map((item) => item.assignment) : [];
		const assignments = [scope, ...collateral];
		reserve(assignments);
		// Check all captured collateral before the first stamp can retain backing.
		for (const item of collateral)
			resolveCapture({ root, storeRoot, configuration, ...item });
		const captures = assignments.map((a) => ({
			assignment: a,
			captured: createStamp({ root, storeRoot, ...a }),
		}));
		const rebuilt = captures.map((base) =>
			reconstructStamp({ storeRoot, digest: base.captured.digest }),
		);
		const files = overlay(rebuilt[0]);
		const id = `migration-${randomUUID()}`;
		const record = {
			recordVersion: 1,
			id,
			state: "open",
			scope: [scope],
			sharing: input.sharing,
			shared,
			collateral,
			bases: captures.map((base) => ({
				assignment: base.assignment,
				stamp: base.captured.digest,
			})),
			workspace: `${directory}/${id}/workspace`,
			files: [...files]
				.map(([p, bytes]) => ({ path: p, sha256: hash(bytes) }))
				.sort((a, b) => compare(a.path, b.path)),
			reason: null,
		};
		const stage = path.join(lock, id);
		mkdirSync(path.join(stage, "workspace"), { recursive: true });
		for (const [p, bytes] of files) {
			const destination = file(stage, `workspace/${p}`);
			mkdirSync(path.dirname(destination), { recursive: true });
			writeFlushed(destination, bytes);
		}
		writeFlushed(path.join(stage, "record.json"), canonicalJSON(record));
		for (const [p, bytes] of files)
			if (!readStoreFile(stage, `workspace/${p}`).equals(bytes))
				throw new Error(`migration workspace: copied bytes mismatch at ${p}`);
		if (!readStoreFile(stage, "record.json").equals(canonicalJSON(record)))
			throw new Error("migration record: copied bytes mismatch");
		if (
			!readStoreFile(root, configFile).equals(configBytes) ||
			(lockBytes === null
				? existsSync(file(root, lockFile))
				: !readStoreFile(root, lockFile).equals(lockBytes))
		)
			throw new Error(
				"stale-input: configuration or dependency lock changed during migration start",
			);
		// Recheck local captured inputs; immutable additions may remain after refusal.
		for (const snapshot of rebuilt)
			for (const e of [
				...snapshot.composition,
				...snapshot.available,
				...snapshot.resources,
			]) {
				if (
					e.backing?.type === "blob" &&
					e.bytes &&
					!readStoreFile(root, e.backing.path).equals(e.bytes)
				)
					throw new Error(
						`stale-input: ${e.backing.path} changed during migration start`,
					);
			}
		mkdirSync(file(root, directory), { recursive: true });
		renameSync(stage, file(root, `${directory}/${id}`));
		return record;
	});
}

function status(root, record) {
	const workspace = file(root, record.workspace),
		actual = new Map();
	if (!existsSync(workspace) || !lstatSync(workspace).isDirectory())
		throw new Error("migration workspace: missing directory");
	function scan(relative = "") {
		for (const name of readdirSync(
			file(
				root,
				relative ? `${record.workspace}/${relative}` : record.workspace,
			),
		).sort(compare)) {
			const member = relative ? `${relative}/${name}` : name,
				absolute = file(root, `${record.workspace}/${member}`);
			const stat = lstatSync(absolute);
			if (stat.isDirectory()) scan(member);
			else
				actual.set(
					member,
					hash(readStoreFile(root, `${record.workspace}/${member}`)),
				);
		}
	}
	scan();
	const expected = new Map(
		record.files.map((member) => [member.path, member.sha256]),
	);
	const changes = [...new Set([...expected.keys(), ...actual.keys()])]
		.sort(compare)
		.flatMap((p) =>
			!expected.has(p)
				? [{ path: p, kind: "added" }]
				: !actual.has(p)
					? [{ path: p, kind: "removed" }]
					: expected.get(p) !== actual.get(p)
						? [{ path: p, kind: "changed" }]
						: [],
		);
	return {
		...record,
		dirty: true,
		workspaceChanged: changes.length > 0,
		changes,
	};
}

function migrationStatusOperation(input) {
	fields(input, ["root"], ["id"]);
	const root = rootDirectory(input.root);
	return input.id === undefined
		? records(root).map((record) => status(root, record))
		: status(root, readRecord(root, input.id));
}

function abandonMigrationOperation(input) {
	fields(input, ["root", "id", "reason"]);
	migrationId(input.id);
	text(input.reason, "reason");
	const root = rootDirectory(input.root);
	return withWriter(root, (lock) => {
		const before = readStoreFile(root, `${directory}/${input.id}/record.json`),
			record = readRecord(root, input.id);
		if (record.state !== "open") throw new Error("migration is not open");
		const next = { ...record, state: "abandoned", reason: input.reason };
		const temporary = path.join(lock, "record.json");
		writeFlushed(temporary, canonicalJSON(next));
		const target = file(root, `${directory}/${input.id}/record.json`);
		if (
			!readStoreFile(root, `${directory}/${input.id}/record.json`).equals(
				before,
			)
		)
			throw new Error("stale-input: migration record changed during abandon");
		renameSync(temporary, target);
		return next;
	});
}

function proposalId(id) {
	if (typeof id !== "string" || !/^proposal-[a-f0-9-]{36}$/.test(id))
		throw new Error("proposal id: expected a generated proposal UUID");
	return id;
}
function proposalShape(value) {
	fields(
		value,
		["proposalVersion", "classification", "target", "change", "evidence"],
		["draftCase"],
		"proposal",
	);
	if (value.proposalVersion !== 1)
		throw new Error("proposal version: expected 1");
	if (
		!["repo", "role", "package", "model-specific"].includes(
			value.classification,
		)
	)
		throw new Error("proposal classification: unsupported");
	fields(value.target, ["path"], [], "proposal target");
	portablePath(value.target.path);
	fields(value.change, ["before", "after"], [], "proposal change");
	for (const key of ["before", "after"]) {
		if (
			typeof value.change[key] !== "string" ||
			value.change[key].includes("\0")
		)
			throw new Error(`proposal change ${key}: expected text without NUL`);
	}
	if (!Array.isArray(value.evidence) || !value.evidence.length)
		throw new Error("proposal evidence: expected nonempty array");
	for (const entry of value.evidence) {
		fields(
			entry,
			["sessionId", "excerpt", "baseStamp"],
			[],
			"proposal evidence",
		);
		for (const key of ["sessionId", "excerpt", "baseStamp"])
			text(entry[key], `proposal evidence ${key}`);
		if (!digestPattern.test(entry.baseStamp))
			throw new Error("proposal evidence baseStamp: invalid digest");
	}
	if (Object.hasOwn(value, "draftCase")) {
		fields(value.draftCase, ["input", "expected"], [], "proposal draftCase");
		text(value.draftCase.input, "draftCase input");
		text(value.draftCase.expected, "draftCase expected");
	}
	canonicalJSON(value);
}
function proposalHistory(root, record) {
	const relative = `${directory}/${record.id}/proposals.json`,
		target = file(root, relative);
	const bytes = existsSync(target) ? readStoreFile(root, relative) : null;
	const entries = bytes === null ? [] : parseRecord(bytes);
	if (!Array.isArray(entries))
		throw new Error("proposal records: expected array");
	const ids = new Set();
	for (const entry of entries) {
		fields(
			entry,
			["id", "proposal", "status", "reason"],
			[],
			"proposal record",
		);
		proposalId(entry.id);
		proposalShape(entry.proposal);
		if (ids.has(entry.id)) throw new Error("proposal records: duplicate id");
		ids.add(entry.id);
		if (!["proposed", "accepted", "rejected"].includes(entry.status))
			throw new Error("proposal status: unsupported");
		if (entry.status === "rejected")
			text(entry.reason, "proposal rejection reason");
		else if (entry.reason !== null)
			throw new Error("proposal reason: inconsistent status");
		if (entry.status === "accepted" && entry.proposal.classification === "repo")
			throw new Error("repo recommendation cannot be accepted");
	}
	return { relative, bytes, entries };
}
function openProposalMigration(root, id, bytes = undefined) {
	const record = readRecord(root, id, bytes);
	if (record.state !== "open") throw new Error("migration is not open");
	return record;
}
function verifiedProposalBase(storeRoot, base) {
	const relative = `stamps/sha256/${base.stamp}/snapshot.json`;
	const before = readStoreFile(storeRoot, relative);
	const rebuilt = reconstructStamp({ storeRoot, digest: base.stamp });
	if (!readStoreFile(storeRoot, relative).equals(before))
		throw new Error("stale-input: base stamp changed during verification");
	const { selection } = parseRecord(before);
	const actual = {
		role: selection.role,
		model: selection.identity.canonical ?? selection.identity.raw,
		host: selection.host,
	};
	if (assignmentKey(actual) !== assignmentKey(base.assignment))
		throw new Error("proposal base: stamp belongs to another assignment");
	return rebuilt;
}
function proposalBases(storeRoot, record, value) {
	const verified = new Map();
	for (const entry of value.evidence) {
		const base = record.bases.find((base) => base.stamp === entry.baseStamp);
		if (!base)
			throw new Error(
				"proposal evidence: base stamp is not retained by this migration",
			);
		if (!verified.has(base.stamp))
			verified.set(base.stamp, verifiedProposalBase(storeRoot, base));
	}
	return verified;
}
function proposalTarget(root, storeRoot, record, value) {
	const verified = proposalBases(storeRoot, record, value);
	const primary = record.bases[0];
	const rebuilt =
		verified.get(primary.stamp) ?? verifiedProposalBase(storeRoot, primary);
	const instructionPath = (entry) =>
		entry?.backing?.type === "blob"
			? `local/${entry.backing.path}`
			: entry?.backing?.type === "package"
				? `packages/${entry.backing.sha256}/${entry.backing.path}`
				: null;
	const profile = instructionPath(
		rebuilt.composition.find((entry) => entry.kind === "profile"),
	);
	const role = instructionPath(
		rebuilt.composition.find((entry) => entry.kind === "role"),
	);
	const packages = [
		...rebuilt.composition,
		...rebuilt.required,
		...rebuilt.available,
	]
		.filter((entry) => entry.backing?.type === "package")
		.map(instructionPath);
	const target = value.target.path;
	if (
		target.split("/").at(-1) === "package.yaml" ||
		["local/AGENTS.md", `local/${configFile}`, `local/${lockFile}`].includes(
			target,
		) ||
		target.startsWith(`local/${directory}/`) ||
		target.startsWith(`local/${writer}/`)
	) {
		throw new Error(
			"proposal target: metadata and repository rules are not editable instructions",
		);
	}
	if (
		value.classification === "model-specific" &&
		record.sharing === "shared" &&
		target.startsWith("packages/")
	) {
		throw new Error("model-specific shared package requires fork intent");
	}
	const allowed =
		value.classification === "role"
			? [role]
			: value.classification === "package"
				? packages
				: value.classification === "model-specific"
					? [profile, ...(record.sharing === "fork" ? packages : [])]
					: [profile, role, ...packages];
	if (
		!allowed.includes(target) ||
		!record.files.some((member) => member.path === target)
	) {
		throw new Error(
			"proposal target: expected selected instruction for classification; model-specific shared package requires fork intent",
		);
	}
	const relative = `${record.workspace}/${target}`;
	const bytes = readStoreFile(root, relative);
	new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	if (bytes.includes(0))
		throw new Error(
			"proposal target: expected UTF-8 instruction text without NUL",
		);
	return { relative, bytes };
}
function stagedProposalHistory(root, lock, record, history, entries) {
	const recordRelative = `${directory}/${record.id}/record.json`,
		recordBytes = readStoreFile(root, recordRelative);
	if (!canonicalJSON(parseRecord(recordBytes)).equals(canonicalJSON(record)))
		throw new Error("stale-input: migration record changed");
	const next = canonicalJSON(entries),
		temporary = path.join(lock, "proposals.json");
	writeFlushed(temporary, next);
	if (!readStoreFile(lock, "proposals.json").equals(next))
		throw new Error("proposal record: staged bytes mismatch");
	const unchanged = () => {
		if (!readStoreFile(root, recordRelative).equals(recordBytes))
			throw new Error("stale-input: migration record changed");
		const target = file(root, history.relative);
		if (
			history.bytes === null
				? existsSync(target)
				: !readStoreFile(root, history.relative).equals(history.bytes)
		) {
			throw new Error("stale-input: proposal records changed");
		}
	};
	return {
		unchanged,
		publish: () => {
			unchanged();
			if (!readStoreFile(lock, "proposals.json").equals(next))
				throw new Error("proposal record: staged bytes changed");
			renameSync(temporary, file(root, history.relative));
			if (!readStoreFile(root, history.relative).equals(next))
				throw new Error(
					"proposal record: published bytes mismatch; inspect retained records",
				);
		},
	};
}

/** Import caller-supplied claims as advisory data; no workspace or active edits. */
function proposeMigrationOperation(input) {
	fields(input, ["root", "id", "proposalFile"], ["storeRoot"]);
	migrationId(input.id);
	text(input.proposalFile, "proposalFile");
	const root = rootDirectory(input.root),
		storeRoot = packageStoreRoot(input.storeRoot);
	return withWriter(root, (lock) => {
		const record = openProposalMigration(root, input.id),
			history = proposalHistory(root, record);
		const source = path.resolve(input.proposalFile);
		const value = parseRecord(
			readStoreFile(
				rootPath(path.dirname(source), "proposal directory"),
				path.basename(source),
			),
		);
		proposalShape(value);
		for (const entry of history.entries) {
			if (canonicalJSON(entry.proposal).equals(canonicalJSON(value)))
				throw new Error("duplicate proposal already retained");
			const sameChange = ["classification", "target", "change"].every((key) =>
				canonicalJSON(entry.proposal[key]).equals(canonicalJSON(value[key])),
			);
			if (
				entry.status === "rejected" &&
				sameChange &&
				!value.evidence.some(
					(item) =>
						!entry.proposal.evidence.some((old) =>
							canonicalJSON(old).equals(canonicalJSON(item)),
						),
				)
			) {
				throw new Error("rejected proposal requires new evidence");
			}
		}
		proposalTarget(root, storeRoot, record, value);
		const entry = {
			id: `proposal-${randomUUID()}`,
			proposal: value,
			status: "proposed",
			reason: null,
		};
		stagedProposalHistory(root, lock, record, history, [
			...history.entries,
			entry,
		]).publish();
		return entry;
	});
}

function migrationProposalsOperation(input) {
	fields(input, ["root", "id"]);
	const root = rootDirectory(input.root),
		record = readRecord(root, input.id);
	return proposalHistory(root, record).entries;
}

function rejectMigrationProposalOperation(input) {
	fields(input, ["root", "id", "proposalId", "reason"], ["storeRoot"]);
	migrationId(input.id);
	proposalId(input.proposalId);
	text(input.reason, "proposal rejection reason");
	const root = rootDirectory(input.root),
		storeRoot = packageStoreRoot(input.storeRoot);
	return withWriter(root, (lock) => {
		const record = openProposalMigration(root, input.id),
			history = proposalHistory(root, record);
		const entry = history.entries.find(
			(entry) => entry.id === input.proposalId,
		);
		if (!entry) throw new Error("proposal id: not found in migration");
		if (entry.status !== "proposed")
			throw new Error(`proposal status: already ${entry.status}`);
		proposalBases(storeRoot, record, entry.proposal);
		const next = { ...entry, status: "rejected", reason: input.reason };
		stagedProposalHistory(
			root,
			lock,
			record,
			history,
			history.entries.map((item) => (item.id === entry.id ? next : item)),
		).publish();
		return next;
	});
}

function acceptMigrationProposalOperation(input) {
	fields(input, ["root", "id", "proposalId"], ["storeRoot"]);
	migrationId(input.id);
	proposalId(input.proposalId);
	const root = rootDirectory(input.root),
		storeRoot = packageStoreRoot(input.storeRoot);
	return withWriter(root, (lock) => {
		const record = openProposalMigration(root, input.id),
			history = proposalHistory(root, record);
		const entry = history.entries.find(
			(entry) => entry.id === input.proposalId,
		);
		if (!entry) throw new Error("proposal id: not found in migration");
		if (entry.status !== "proposed")
			throw new Error(`proposal status: already ${entry.status}`);
		if (entry.proposal.classification === "repo")
			throw new Error("repo recommendation: cannot apply to workspace");
		const target = proposalTarget(root, storeRoot, record, entry.proposal);
		const before = Buffer.from(entry.proposal.change.before, "utf8"),
			after = Buffer.from(entry.proposal.change.after, "utf8");
		if (!target.bytes.equals(before))
			throw new Error("stale-input: proposal before bytes no longer match");
		const next = { ...entry, status: "accepted" };
		const staged = stagedProposalHistory(
			root,
			lock,
			record,
			history,
			history.entries.map((item) => (item.id === entry.id ? next : item)),
		);
		const temporary = path.join(lock, "instruction"),
			restore = path.join(lock, "before");
		writeFlushed(temporary, after);
		writeFlushed(restore, before);
		if (
			!readStoreFile(lock, "instruction").equals(after) ||
			!readStoreFile(lock, "before").equals(before)
		)
			throw new Error("proposal instruction: staged bytes mismatch");
		staged.unchanged();
		if (!readStoreFile(root, target.relative).equals(before))
			throw new Error(
				"stale-input: proposal before bytes changed during acceptance",
			);
		let applied = false;
		try {
			renameSync(temporary, file(root, target.relative));
			applied = true;
			if (!readStoreFile(root, target.relative).equals(after))
				throw new Error("stale-input: workspace changed during acceptance");
			staged.publish();
			if (!readStoreFile(root, target.relative).equals(after))
				throw new Error(
					"stale-input: workspace changed after proposal publication",
				);
		} catch (error) {
			if (applied) {
				try {
					// Do not undo a published outcome or overwrite a subsequent user edit.
					if (
						readStoreFile(root, target.relative).equals(after) &&
						(history.bytes === null
							? !existsSync(file(root, history.relative))
							: readStoreFile(root, history.relative).equals(history.bytes))
					) {
						renameSync(restore, file(root, target.relative));
					} else
						throw new Error(
							"workspace or proposal records changed; retained current data for inspection",
						);
				} catch (compensation) {
					throw new Error(
						`proposal acceptance incomplete: ${errorMessage(error)}; compensation: ${errorMessage(compensation)}`,
						{ cause: error },
					);
				}
			}
			throw error;
		}
		return next;
	});
}

// Live routing must still reproduce the retained evaluation base exactly; routing changes refuse without touching history.
function evaluationContext(root, selectors, configuration, evaluation) {
	const current = resolveCapture({ ...selectors, configuration });
	const same = (a, b) => canonicalJSON(a).equals(canonicalJSON(b));
	const actors = [...current.evidence.actors].sort((a, b) =>
		compare(assignmentKey(a.assignment), assignmentKey(b.assignment)),
	);
	if (
		!same(current.evidence.primary, evaluation.selectionBindings) ||
		!same(actors, evaluation.workflowActors) ||
		!same(current.resolution.workflow.peers, evaluation.workflowPeers)
	)
		throw new Error(
			"candidate evaluation base: stale selection or workflow peers changed",
		);
	if (current.resolution.workflow.status !== "declared-compatible")
		throw new Error(
			"candidate workflow: unresolved declarations are not ready",
		);
	if (current.resolution.unsatisfied.length)
		throw new Error(
			"candidate workflow: required context has unsatisfied host prerequisites; runtime remains unverified",
		);
	if (
		current.resolution.loaded.length !== evaluation.composition.length ||
		current.resolution.loaded.some(
			(entry, i) =>
				entry.kind !== evaluation.composition[i].kind ||
				!Buffer.from(entry.content).equals(evaluation.composition[i].bytes),
		)
	)
		throw new Error("candidate evaluation base: stale loaded bytes changed");
	for (const entry of [
		...evaluation.composition,
		...evaluation.available,
		...evaluation.resources,
		...evaluation.shared,
	]) {
		if (
			entry.backing?.type === "blob" &&
			entry.bytes &&
			!readStoreFile(root, entry.backing.path).equals(entry.bytes)
		)
			throw new Error("candidate evaluation base: stale local inputs changed");
	}
	return current;
}

function candidateManifest(value) {
	fields(
		value,
		[
			"candidateVersion",
			"id",
			"binding",
			"release",
			"migrationBase",
			"evaluationBase",
			"configSha256",
			"expectedTreeSha256",
			"proposalIds",
			"workflowChange",
		],
		[],
		"candidate",
	);
	if (value.candidateVersion !== 1)
		throw new Error("candidate version: expected 1");
	if (
		typeof value.id !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id)
	)
		throw new Error("candidate id: expected portable identifier");
	if (
		typeof value.binding !== "string" ||
		!/^skills\.[a-z0-9][a-z0-9-]*$/.test(value.binding)
	)
		throw new Error(
			"candidate binding: only one managed skill package is supported",
		);
	fields(value.release, ["name", "version"], [], "candidate release");
	if (
		typeof value.release.name !== "string" ||
		!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(value.release.name) ||
		typeof value.release.version !== "string" ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
			value.release.version,
		) ||
		value.release.version
			.split(".")
			.some((n) => !Number.isSafeInteger(Number(n)))
	)
		throw new Error("candidate release: expected exact package identity");
	for (const field of [
		"migrationBase",
		"evaluationBase",
		"configSha256",
		"expectedTreeSha256",
	])
		if (typeof value[field] !== "string" || !digestPattern.test(value[field]))
			throw new Error(`candidate ${field}: invalid digest`);
	if (
		!Array.isArray(value.proposalIds) ||
		!value.proposalIds.length ||
		new Set(value.proposalIds).size !== value.proposalIds.length
	)
		throw new Error("candidate proposals: expected nonempty unique ids");
	value.proposalIds.forEach(proposalId);
	fields(
		value.workflowChange,
		["kind", "reason"],
		[],
		"candidate workflowChange",
	);
	if (value.workflowChange.kind !== "task-only")
		throw new Error("candidate workflowChange: only task-only supported");
	text(value.workflowChange.reason, "candidate workflowChange reason");
	canonicalJSON(value);
}

function migrationCandidateOperation(input) {
	fields(input, ["id"], ["storeRoot"], "candidate read");
	const storeRoot = packageStoreRoot(input.storeRoot),
		index = candidateIndex(storeRoot, input.id);
	const revision = readRevisionRecord({
		storeRoot,
		recordDigest: index.revisionDigest,
	});
	if (revision.provenance.migrationId !== index.migrationId)
		throw new Error("candidate index: workspace mismatch");
	const rebuilt = reconstructStamp({ storeRoot, digest: index.stampDigest });
	if (
		rebuilt.capture.kind !== "candidate" ||
		rebuilt.capture.candidate !== index.revisionDigest ||
		rebuilt.capture.migration !== index.migrationId
	)
		throw new Error("candidate index: captured relation mismatch");
	return index;
}

function publishMigrationCandidateOperation(input) {
	fields(
		input,
		["root", "id", "manifestFile"],
		["storeRoot"],
		"candidate publication",
	);
	migrationId(input.id);
	text(input.manifestFile, "candidate manifestFile");
	const root = rootDirectory(input.root),
		storeRoot = packageStoreRoot(input.storeRoot);
	const workspace = file(root, `${directory}/${input.id}/workspace`);
	const inside = (a, b) => {
		const r = path.relative(a, b);
		return !path.isAbsolute(r) && r !== ".." && !r.startsWith(`..${path.sep}`);
	};
	if (
		inside(file(root, directory), storeRoot) ||
		inside(workspace, storeRoot) ||
		inside(storeRoot, workspace) ||
		inside(file(root, writer), storeRoot)
	)
		throw new Error("candidate source/store overlap is forbidden");
	const source = path.resolve(input.manifestFile),
		sourceRoot = rootPath(path.dirname(source), "candidate source");
	const manifestBytes = readStoreFile(sourceRoot, path.basename(source)),
		manifest = parseRecord(manifestBytes);
	candidateManifest(manifest);
	const indexRelative = `candidates/ids/${manifest.id}.json`,
		indexFile = safePath(storeRoot, indexRelative);
	const existing = existsSync(indexFile)
		? migrationCandidate({ storeRoot, id: manifest.id })
		: null;
	if (existing) {
		const retained = readRevisionRecord({
				storeRoot,
				recordDigest: existing.revisionDigest,
			}),
			p = retained.provenance;
		if (
			existing.migrationId !== input.id ||
			!canonicalJSON(existing.release).equals(
				canonicalJSON(manifest.release),
			) ||
			existing.content.sha256 !== manifest.expectedTreeSha256 ||
			p.binding !== manifest.binding ||
			p.migrationBase !== manifest.migrationBase ||
			p.evaluationBase !== manifest.evaluationBase ||
			p.configSha256 !== manifest.configSha256 ||
			!canonicalJSON(p.proposals.map((entry) => entry.id)).equals(
				canonicalJSON(manifest.proposalIds),
			) ||
			!canonicalJSON(p.workflowChange).equals(
				canonicalJSON(manifest.workflowChange),
			)
		)
			throw new Error(
				"candidate immutable identity conflict: cannot repoint an existing id",
			);
	}
	const recordRelative = `${directory}/${input.id}/record.json`,
		recordBytes = readStoreFile(root, recordRelative);
	const record = openProposalMigration(root, input.id, recordBytes);
	if (
		record.sharing !== "fork" ||
		record.collateral.length ||
		record.bases.length !== 1
	)
		throw new Error("candidate: only one fork-intent assignment is supported");
	if (record.bases[0].stamp !== manifest.migrationBase)
		throw new Error("candidate migration base: not owned by workspace");
	const history = proposalHistory(root, record),
		accepted = history.entries.filter((entry) => entry.status === "accepted");
	if (
		!canonicalJSON(accepted.map((entry) => entry.id)).equals(
			canonicalJSON(manifest.proposalIds),
		)
	)
		throw new Error(
			"candidate accepted proposal history: incomplete or foreign ids",
		);
	const original = verifiedProposalBase(storeRoot, record.bases[0]);
	const evaluation = verifiedProposalBase(storeRoot, {
		stamp: manifest.evaluationBase,
		assignment: record.scope[0],
	});
	const evaluationSnapshot = parseRecord(
		readStoreFile(
			storeRoot,
			`stamps/sha256/${manifest.evaluationBase}/snapshot.json`,
		),
	);
	if (
		evaluationSnapshot.stampVersion !== 2 ||
		evaluationSnapshot.capture.kind !== "active"
	)
		throw new Error(
			"candidate evaluation base: requires active compatible config3 stamp2",
		);
	const basePin = evaluation.selectionBindings.find(
		(row) => row.root.binding === manifest.binding,
	)?.root;
	if (!basePin || basePin.revisionDigest === null)
		throw new Error(
			"candidate parent: explicit adopted selected metadata required",
		);
	const parent = lookupRevisionManifest({
		storeRoot,
		recordDigest: basePin.revisionDigest,
	});
	// A native stamp2 base names its selected root; its dependency-first composition can tag a dependency with the root binding.
	const origin = original.selectionBindings
		? original.selectionBindings.find(
				(row) => row.root.binding === manifest.binding,
			)?.root
		: [
				...original.composition,
				...original.required,
				...original.available,
			].find((entry) => entry.package?.binding === manifest.binding)?.package;
	if (
		!origin ||
		origin.sha256 !== parent.content.sha256 ||
		origin.name !== parent.identity.name ||
		origin.version !== parent.identity.version
	)
		throw new Error("candidate base: target origin/selection mismatch");
	if (
		manifest.release.name !== parent.identity.name ||
		manifest.release.version === parent.identity.version
	)
		throw new Error(
			"candidate release: distinct version of the same name required",
		);
	if (lookupPackage({ storeRoot, ...manifest.release }))
		throw new Error("candidate release: planned identity is already published");
	if (!existing && candidateReservation(storeRoot, manifest.release)) {
		// Multiple immutable attempts may reserve the same still-unpublished planned label.
		if (lookupPackage({ storeRoot, ...manifest.release }))
			throw new Error("candidate release: identity conflict");
	}
	const configBytes = readStoreFile(root, configFile),
		lockBytes = readStoreFile(root, lockFile);
	const config = parseYaml(configBytes.toString("utf8")),
		lock = parseRecord(lockBytes);
	if (!(config instanceof Map) || config.get("version") !== 3)
		throw new Error(
			"candidate: explicitly prepare config3 evaluation context first",
		);
	if (lock.configSha256 !== manifest.configSha256)
		throw new Error("stale-input: configuration/lock guard mismatch");
	const selectors = { root, storeRoot, ...record.scope[0] };
	evaluationContext(root, selectors, config, evaluation);
	const originalFiles = overlay(original),
		actual = readTree(workspace),
		byPath = new Map(actual.map((member) => [member.path, member.bytes]));
	if (
		record.files.length !== originalFiles.size ||
		record.files.some(
			(member) =>
				!originalFiles.has(member.path) ||
				hash(originalFiles.get(member.path)) !== member.sha256,
		)
	)
		throw new Error("candidate migration base: workspace inventory mismatch");
	const treeRelative = `packages/${parent.content.sha256}`,
		tree = file(workspace, treeRelative),
		pkg = readPackage({ root: tree });
	if (
		pkg.manifest.package.type !== "skill" ||
		pkg.manifest.behavior.delivery !== "instruction"
	)
		throw new Error(
			"candidate: only a managed skill package target is supported",
		);
	if (pkg.sha256 !== manifest.expectedTreeSha256)
		throw new Error("stale-input: expected workspace tree digest mismatch");
	const target = `${treeRelative}/${pkg.manifest.entrypoint}`;
	let task = originalFiles.get(target);
	for (const entry of accepted) {
		const proposal = entry.proposal;
		if (
			proposal.classification !== "package" ||
			proposal.target.path !== target ||
			proposal.evidence.some((e) => e.baseStamp !== manifest.migrationBase)
		)
			throw new Error(
				"candidate accepted proposal history: unsupported target or foreign base",
			);
		proposalBases(storeRoot, record, proposal);
		if (!task?.equals(Buffer.from(proposal.change.before)))
			throw new Error(
				"candidate accepted proposal history: before bytes mismatch",
			);
		task = Buffer.from(proposal.change.after);
	}
	if (!task || !byPath.get(target)?.equals(task))
		throw new Error(
			"candidate task: unapproved bytes not explained by accepted proposal history",
		);
	if (
		byPath.size !== originalFiles.size ||
		[...originalFiles].some(
			([p, bytes]) => !byPath.get(p)?.equals(p === target ? task : bytes),
		)
	)
		throw new Error(
			"candidate task-only: unapproved workspace/workflow/resource change outside target",
		);
	/** @type {Map<string, Buffer>} */
	const guarded = new Map([
		[configFile, configBytes],
		[lockFile, lockBytes],
		[recordRelative, recordBytes],
		[history.relative, history.bytes],
	]);
	for (const member of actual)
		guarded.set(`${record.workspace}/${member.path}`, member.bytes);
	const unchanged = () => {
		for (const [relative, bytes] of guarded)
			if (
				bytes === null
					? existsSync(file(root, relative))
					: !readStoreFile(root, relative).equals(bytes)
			)
				throw new Error(
					`stale-input: ${relative} changed during candidate publication`,
				);
		const latest = readTree(workspace);
		if (
			!readStoreFile(sourceRoot, path.basename(source)).equals(manifestBytes) ||
			latest.length !== actual.length ||
			latest.some(
				(member, i) =>
					member.path !== actual[i].path ||
					!member.bytes.equals(actual[i].bytes),
			)
		)
			throw new Error("stale-input: candidate manifest or workspace changed");
	};
	unchanged();
	if (existing) return { ...existing, status: "reused" };
	return withWriter(root, () => {
		unchanged();
		openProposalMigration(root, input.id);
		const content = retainPackageObject({
			storeRoot,
			sourceDirectory: tree,
			expectedDigest: manifest.expectedTreeSha256,
		});
		unchanged();
		const metadata = {
			revisionVersion: 2,
			kind: "candidate",
			identity: manifest.release,
			content,
			parent: basePin.revisionDigest,
			candidate: manifest.id,
			dependencies: parent.dependencies,
			workflow: parent.workflow,
			provenance: {
				migrationId: record.id,
				binding: manifest.binding,
				migrationBase: manifest.migrationBase,
				evaluationBase: manifest.evaluationBase,
				configSha256: manifest.configSha256,
				expectedTreeSha256: manifest.expectedTreeSha256,
				proposals: accepted,
				workflowChange: manifest.workflowChange,
			},
		};
		const revisionDigest = retainCandidateRevision({
			storeRoot,
			manifest: metadata,
		});
		unchanged();
		const captured = createCandidateStamp(selectors, revisionDigest);
		unchanged();
		const index = {
			candidateVersion: 1,
			id: manifest.id,
			migrationId: record.id,
			release: manifest.release,
			content,
			revisionDigest,
			stampDigest: captured.digest,
		};
		const bytes = canonicalJSON(index);
		// Final staging is on the store device, independent of the project writer's device.
		const storeWriter = safePath(storeRoot, ".writer-lock");
		try {
			mkdirSync(storeWriter);
		} catch (error) {
			if (errorCode(error) === "EEXIST")
				throw new Error("store-busy: writer lock exists");
			throw error;
		}
		try {
			const ownership = canonicalJSON({
				pid: process.pid,
				operation: randomUUID(),
			});
			writeFlushed(path.join(storeWriter, "owner.json"), ownership);
			if (lookupPackage({ storeRoot, ...manifest.release }))
				throw new Error(
					"candidate release: planned identity was published before final commit",
				);
			const staged = path.join(storeWriter, "candidate.json");
			writeFlushed(staged, bytes);
			if (!readStoreFile(storeWriter, "candidate.json").equals(bytes))
				throw new Error("candidate index: staged readback mismatch");
			readRevisionRecord({ storeRoot, recordDigest: revisionDigest });
			reconstructStamp({ storeRoot, digest: captured.digest });
			mkdirSync(path.dirname(indexFile), { recursive: true });
			unchanged();
			if (!readStoreFile(storeWriter, "owner.json").equals(ownership))
				throw new Error(
					"candidate writer: ownership changed before publication",
				);
			publish(staged, indexFile, renameSync);
			return {
				...migrationCandidate({ storeRoot, id: manifest.id }),
				status: "published",
			};
		} catch (error) {
			if (existsSync(indexFile))
				throw new Error(
					`candidate publication incomplete: committed index retained for inspection; ${errorMessage(error)}`,
					{ cause: error },
				);
			throw error;
		} finally {
			rmSync(storeWriter, { recursive: true, force: true });
		}
	});
}

const evaluationDomains = {
	plans: "agent-profiles/evaluation-plan/v1",
	results: "agent-profiles/evaluation-result/v1",
};
const evaluationMetrics = [
	"costUsd",
	"tokens",
	"turns",
	"toolCalls",
	"latencyMs",
];
const evaluationEqual = (a, b) =>
	canonicalEvaluationJSON(a).equals(canonicalEvaluationJSON(b));
function evaluationId(id) {
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(id))
		throw new Error("evaluation id: expected portable identifier");
	return id;
}
function evaluationDigest(value, label) {
	if (typeof value !== "string" || !digestPattern.test(value))
		throw new Error(`evaluation ${label}: invalid digest`);
}
function evaluationConditions(value) {
	fields(value, ["harness", "judge", "rubric"], [], "evaluation conditions");
	for (const key of ["harness", "judge", "rubric"]) {
		fields(value[key], ["id", "version", "settings"], [], `conditions ${key}`);
		text(value[key].id, `${key} id`);
		text(value[key].version, `${key} version`);
		const settings = value[key].settings;
		if (!settings || typeof settings !== "object" || Array.isArray(settings))
			throw new Error(`${key} settings: expected JSON object`);
		canonicalEvaluationJSON(settings);
	}
}
function evaluationIndex(store, kind, id) {
	evaluationId(id);
	const bytes = readStoreFile(store, `evaluations/${kind}/ids/${id}.json`),
		index = parseRecord(bytes);
	const key = kind === "plans" ? "planDigest" : "resultDigest";
	fields(index, ["evaluationIndexVersion", "id", key], [], "evaluation index");
	if (
		index.evaluationIndexVersion !== 1 ||
		index.id !== id ||
		!canonicalJSON(index).equals(bytes)
	)
		throw new Error("evaluation index: corrupt canonical identity/version");
	evaluationDigest(index[key], key);
	return index;
}
function evaluationObject(store, kind, digest) {
	evaluationDigest(digest, `${kind} digest`);
	const bytes = readStoreFile(
			store,
			`evaluations/${kind}/sha256/${digest}.json`,
		),
		value = parseEvaluationRecord(bytes);
	if (
		!canonicalEvaluationJSON(value).equals(bytes) ||
		hashEvaluationRecord(evaluationDomains[kind], value) !== digest
	)
		throw new Error("evaluation record: canonical integrity/digest mismatch");
	return value;
}
function evaluationPlanBacking(store, plan) {
	fields(
		plan,
		[
			"planVersion",
			"id",
			"candidateId",
			"candidateRevisionDigest",
			"baseStamp",
			"candidateStamp",
			"context",
			"cases",
			"trials",
			"conditions",
		],
		[],
		"evaluation plan",
	);
	if (plan.planVersion !== 1)
		throw new Error("evaluation planVersion: unsupported version");
	evaluationId(plan.id);
	evaluationId(plan.candidateId);
	for (const key of ["candidateRevisionDigest", "baseStamp", "candidateStamp"])
		evaluationDigest(plan[key], key);
	fields(
		plan.context,
		["assignment", "requestedSkills", "workflowPeers"],
		[],
		"evaluation context",
	);
	assignment(plan.context.assignment);
	if (
		!Array.isArray(plan.context.requestedSkills) ||
		plan.context.requestedSkills.some((id) => typeof id !== "string") ||
		new Set(plan.context.requestedSkills).size !==
			plan.context.requestedSkills.length
	)
		throw new Error("evaluation context requestedSkills: expected unique ids");
	fields(
		plan.context.workflowPeers,
		["base", "candidate"],
		[],
		"evaluation workflow peers",
	);
	evaluationConditions(plan.conditions);
	if (!Number.isSafeInteger(plan.trials) || plan.trials < 1)
		throw new Error("evaluation trials: expected positive safe integer");
	if (
		!Array.isArray(plan.cases) ||
		!plan.cases.length ||
		!Number.isSafeInteger(plan.cases.length * plan.trials * 2)
	)
		throw new Error("evaluation cases/trials: unsafe or missing coverage");
	const candidate = migrationCandidate({
		storeRoot: store,
		id: plan.candidateId,
	});
	if (
		candidate.revisionDigest !== plan.candidateRevisionDigest ||
		candidate.stampDigest !== plan.candidateStamp
	)
		throw new Error("evaluation candidate revision/stamp binding mismatch");
	const revision = readRevisionRecord({
		storeRoot: store,
		recordDigest: candidate.revisionDigest,
	});
	if (revision.provenance.evaluationBase !== plan.baseStamp)
		throw new Error("evaluation base stamp binding mismatch");
	const captures = [plan.baseStamp, plan.candidateStamp].map((digest) => {
		const rebuilt = verifiedProposalBase(store, {
			stamp: digest,
			assignment: plan.context.assignment,
		});
		const snapshot = parseRecord(
			readStoreFile(store, `stamps/sha256/${digest}/snapshot.json`),
		);
		if (
			snapshot.stampVersion !== 2 ||
			snapshot.selection.identity.canonical !== plan.context.assignment.model ||
			snapshot.selection.host !== plan.context.assignment.host ||
			!evaluationEqual(snapshot.requested, plan.context.requestedSkills)
		)
			throw new Error("evaluation context: requested selection mismatch");
		return { rebuilt, snapshot };
	});
	if (
		captures[0].snapshot.capture.kind !== "active" ||
		captures[1].snapshot.capture.kind !== "candidate"
	)
		throw new Error("evaluation base/candidate capture mismatch");
	for (const [index, side] of ["base", "candidate"].entries()) {
		const { snapshot, rebuilt } = captures[index];
		if (
			!evaluationEqual(snapshot.workflowPeers, plan.context.workflowPeers[side])
		)
			throw new Error("evaluation workflow peer context mismatch");
		const records = new Map(
			rebuilt.revisions.map((row) => [
				row.recordDigest,
				parseRecord(row.bytes),
			]),
		);
		const rows = [
			...rebuilt.selectionBindings,
			...rebuilt.workflowActors.flatMap((actor) => actor.bindings),
		];
		for (const row of rows)
			for (const pin of row.closure) {
				if (
					pin.revisionDigest === null ||
					!records.get(pin.revisionDigest)?.workflow
				)
					throw new Error(
						"evaluation workflow readiness: unknown required declaration",
					);
			}
	}
	const targetExists = (capture, target) => {
		const { rebuilt } = capture;
		const rows =
			assignmentKey(target.assignment) ===
			assignmentKey(plan.context.assignment)
				? rebuilt.selectionBindings
				: rebuilt.workflowActors.find(
						(actor) =>
							assignmentKey(actor.assignment) ===
							assignmentKey(target.assignment),
					)?.bindings;
		const row = rows?.find((row) => row.root.binding === target.binding);
		const member = row?.closure.find((pin) => pin.name === target.member);
		return (
			member &&
			rebuilt.packages.some(
				(pkg) =>
					pkg.name === member.name &&
					pkg.sha256 === member.sha256 &&
					pkg.revisionDigest === member.revisionDigest &&
					pkg.behavior.delivery === "instruction",
			)
		);
	};
	const ids = new Set();
	for (const item of plan.cases) {
		fields(
			item,
			["id", "kind", "input", "expected", "target"],
			[],
			"evaluation case",
		);
		evaluationId(item.id);
		if (ids.has(item.id)) throw new Error("evaluation case: duplicate case id");
		ids.add(item.id);
		if (
			!["motivating", "regression", "workflow", "collateral"].includes(
				item.kind,
			)
		)
			throw new Error("evaluation case kind: unsupported");
		text(item.input, "case input");
		text(item.expected, "case expected");
		fields(
			item.target,
			["assignment", "binding", "member", "protocol"],
			[],
			"case target",
		);
		assignment(item.target.assignment);
		text(item.target.binding, "case target binding");
		text(item.target.member, "case target member");
		if (!captures.every((capture) => targetExists(capture, item.target)))
			throw new Error(
				"evaluation case target scope: not in actual captured binding closure",
			);
		if (item.kind === "workflow") {
			fields(
				item.target.protocol,
				["protocol", "major"],
				[],
				"case workflow protocol",
			);
			text(item.target.protocol.protocol, "case workflow protocol");
			if (
				!Number.isSafeInteger(item.target.protocol.major) ||
				item.target.protocol.major < 1
			)
				throw new Error(
					"case workflow protocol major: expected positive safe integer",
				);
		} else if (item.target.protocol !== null)
			throw new Error(
				"case target protocol: expected null for non-workflow case",
			);
	}
	for (const kind of ["motivating", "regression"])
		if (!plan.cases.some((item) => item.kind === kind))
			throw new Error(`evaluation coverage: missing ${kind} case`);
	const obligations = captures.flatMap(({ snapshot, rebuilt }) =>
		snapshot.workflowPeers.map((peer) => {
			const record = rebuilt.revisions.find(
				(row) => row.recordDigest === peer.consumer.revisionDigest,
			);
			return {
				assignment: peer.consumer.assignment,
				binding: peer.consumer.binding,
				member: record.name,
				protocol: { protocol: peer.protocol, major: peer.major },
			};
		}),
	);
	for (const obligation of obligations)
		if (
			!plan.cases.some(
				(item) =>
					item.kind === "workflow" && evaluationEqual(item.target, obligation),
			)
		)
			throw new Error(
				"evaluation workflow coverage: missing required protocol case",
			);
	for (const item of plan.cases.filter((item) => item.kind === "workflow"))
		if (!obligations.some((target) => evaluationEqual(target, item.target)))
			throw new Error("evaluation workflow case: foreign protocol obligation");
	return plan;
}
function evaluationPlanByDigest(store, digest) {
	const plan = evaluationObject(store, "plans", digest);
	if (evaluationIndex(store, "plans", plan.id).planDigest !== digest)
		throw new Error("evaluation plan: immutable index binding mismatch");
	return evaluationPlanBacking(store, plan);
}
function migrationEvaluationPlanOperation(input) {
	fields(input, ["id"], ["storeRoot"], "evaluation plan read");
	const store = packageStoreRoot(input.storeRoot),
		index = evaluationIndex(store, "plans", input.id);
	const plan = evaluationPlanByDigest(store, index.planDigest);
	if (plan.id !== input.id)
		throw new Error("evaluation plan index: record id binding mismatch");
	return { planDigest: index.planDigest, plan };
}
function evaluationResults(store, results, planDigest) {
	fields(
		results,
		[
			"resultVersion",
			"id",
			"planDigest",
			"candidateRevisionDigest",
			"conditions",
			"outcomes",
		],
		[],
		"evaluation results",
	);
	if (results.resultVersion !== 1)
		throw new Error("evaluation resultVersion: unsupported");
	evaluationId(results.id);
	evaluationDigest(results.planDigest, "planDigest");
	if (results.planDigest !== planDigest)
		throw new Error("evaluation plan digest binding mismatch");
	const plan = evaluationPlanByDigest(store, planDigest);
	if (results.candidateRevisionDigest !== plan.candidateRevisionDigest)
		throw new Error("evaluation candidate revision binding mismatch");
	fields(
		results.conditions,
		["base", "candidate"],
		[],
		"evaluation conditions",
	);
	for (const side of ["base", "candidate"]) {
		evaluationConditions(results.conditions[side]);
		if (!evaluationEqual(results.conditions[side], plan.conditions))
			throw new Error(
				`evaluation conditions: ${side} harness/judge/rubric settings mismatch`,
			);
	}
	if (!Array.isArray(results.outcomes))
		throw new Error("evaluation outcomes: expected array");
	const seen = new Set(),
		cases = new Set(plan.cases.map((item) => item.id));
	for (const row of results.outcomes) {
		fields(
			row,
			[
				"caseId",
				"trial",
				"side",
				"stampDigest",
				"assignment",
				"correct",
				"metrics",
				"evidenceRef",
			],
			[],
			"evaluation outcome",
		);
		if (!cases.has(row.caseId))
			throw new Error("evaluation outcome case: foreign case");
		if (
			!Number.isSafeInteger(row.trial) ||
			row.trial < 1 ||
			row.trial > plan.trials
		)
			throw new Error("evaluation outcome trial: out of range");
		if (!["base", "candidate"].includes(row.side))
			throw new Error("evaluation outcome side: unsupported");
		const key = JSON.stringify([row.caseId, row.trial, row.side]);
		if (seen.has(key))
			throw new Error("evaluation outcome: duplicate case/trial/side");
		seen.add(key);
		if (
			row.stampDigest !==
			(row.side === "base" ? plan.baseStamp : plan.candidateStamp)
		)
			throw new Error("evaluation side stamp binding mismatch");
		assignment(row.assignment);
		if (!evaluationEqual(row.assignment, plan.context.assignment))
			throw new Error("evaluation assignment context binding mismatch");
		if (typeof row.correct !== "boolean")
			throw new Error("evaluation correct: expected boolean");
		text(row.evidenceRef, "evaluation evidenceRef");
		fields(row.metrics, evaluationMetrics, [], "evaluation metrics");
		for (const metric of evaluationMetrics) {
			const value = row.metrics[metric];
			if (value === null) continue;
			if (
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				value < 0 ||
				value > Number.MAX_SAFE_INTEGER ||
				Object.is(value, -0) ||
				(!["costUsd", "latencyMs"].includes(metric) &&
					!Number.isSafeInteger(value))
			)
				throw new Error(
					`evaluation metric ${metric}: expected finite nonnegative safe ${["costUsd", "latencyMs"].includes(metric) ? "number" : "integer"} or null`,
				);
		}
	}
	if (seen.size !== plan.cases.length * plan.trials * 2)
		throw new Error("evaluation outcomes: incomplete/missing paired coverage");
	// Validate all aggregate bounds before the result can acquire a success index.
	evaluationReport(
		plan,
		results,
		planDigest,
		hashEvaluationRecord(evaluationDomains.results, results),
	);
	return plan;
}
function evaluationSummary(rows) {
	return Object.fromEntries(
		evaluationMetrics.map((metric) => {
			const pairs = new Map();
			for (const row of rows) {
				const key = JSON.stringify([row.caseId, row.trial]);
				if (!pairs.has(key)) pairs.set(key, {});
				pairs.get(key)[row.side] = row.metrics[metric];
			}
			const sum = (values) => {
				let total = 0;
				for (const value of values) {
					total += value;
					if (
						!Number.isFinite(total) ||
						Math.abs(total) > Number.MAX_SAFE_INTEGER ||
						(!["costUsd", "latencyMs"].includes(metric) &&
							!Number.isSafeInteger(total))
					)
						throw new Error(
							`evaluation metric ${metric}: unsafe aggregate overflow`,
						);
				}
				return total;
			};
			const entries = [...pairs.values()],
				available = entries.filter(
					(pair) => pair.base !== null && pair.candidate !== null,
				);
			const base = entries.every((pair) => pair.base !== null)
				? sum(entries.map((pair) => pair.base))
				: null;
			const candidate = entries.every((pair) => pair.candidate !== null)
				? sum(entries.map((pair) => pair.candidate))
				: null;
			// Also check measured partial sums even when the complete-side total is unavailable.
			sum(
				entries.filter((pair) => pair.base !== null).map((pair) => pair.base),
			);
			sum(
				entries
					.filter((pair) => pair.candidate !== null)
					.map((pair) => pair.candidate),
			);
			const pairedBase = available.length
				? sum(available.map((pair) => pair.base))
				: null;
			const pairedCandidate = available.length
				? sum(available.map((pair) => pair.candidate))
				: null;
			return [
				metric,
				{
					expectedPairs: entries.length,
					availablePairs: available.length,
					baseTotal: base,
					candidateTotal: candidate,
					delta: base === null || candidate === null ? null : candidate - base,
					paired: {
						base: pairedBase,
						candidate: pairedCandidate,
						delta:
							pairedBase === null || pairedCandidate === null
								? null
								: pairedCandidate - pairedBase,
					},
				},
			];
		}),
	);
}
function evaluationReport(plan, results, planDigest, resultDigest) {
	const cases = plan.cases.map((item) => {
		const rows = results.outcomes.filter((row) => row.caseId === item.id);
		const score = (side) => {
			const passed = rows.filter(
				(row) => row.side === side && row.correct,
			).length;
			return { passed, trials: plan.trials, rate: passed / plan.trials };
		};
		return {
			id: item.id,
			kind: item.kind,
			target: item.target,
			base: score("base"),
			candidate: score("candidate"),
			metrics: evaluationSummary(rows),
		};
	});
	const regressions = cases
		.filter((item) => item.candidate.passed < item.base.passed)
		.map((item) => ({
			caseId: item.id,
			basePassed: item.base.passed,
			candidatePassed: item.candidate.passed,
			trials: plan.trials,
			reason: "per-case-correctness-drop",
		}));
	return {
		reportVersion: 1,
		planDigest,
		resultDigest,
		baseStamp: plan.baseStamp,
		candidate: {
			id: plan.candidateId,
			revisionDigest: plan.candidateRevisionDigest,
			stampDigest: plan.candidateStamp,
		},
		context: plan.context,
		evidence: {
			integrity: "verified",
			workflow: "declared-compatible",
			correctness: "external-claim",
			runtime: "unverified",
			promotion: "not-authorized",
		},
		eligibility: {
			status: regressions.length ? "blocked" : "eligible",
			regressions,
		},
		cases,
		metrics: evaluationSummary(results.outcomes),
	};
}
function migrationEvaluationReportOperation(input) {
	fields(input, ["id"], ["storeRoot"], "evaluation report");
	const store = packageStoreRoot(input.storeRoot),
		index = evaluationIndex(store, "results", input.id);
	const results = evaluationObject(store, "results", index.resultDigest);
	if (results.id !== input.id)
		throw new Error("evaluation result index: record id binding mismatch");
	const plan = evaluationResults(store, results, results.planDigest);
	return evaluationReport(
		plan,
		results,
		results.planDigest,
		index.resultDigest,
	);
}
function retainEvaluation(input, kind, sourceFile, validate) {
	const root = rootPath(input.root, "evaluation root"),
		store = packageStoreRoot(input.storeRoot);
	const inside = (parent, child) => {
		const relative = path.relative(parent, child);
		return (
			!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`)
		);
	};
	const storeWriter = safePath(store, ".writer-lock"),
		projectWriter = file(root, writer);
	if (
		inside(file(root, directory), store) ||
		inside(projectWriter, store) ||
		inside(store, projectWriter)
	)
		throw new Error("evaluation namespace/store overlap is forbidden");
	text(sourceFile, "evaluation input file");
	const sourcePath = path.resolve(sourceFile),
		sourceRoot = rootPath(path.dirname(sourcePath), "evaluation input parent");
	const source = path.join(sourceRoot, path.basename(sourcePath));
	if (inside(store, source) || inside(projectWriter, source))
		throw new Error("evaluation source/store/writer overlap is forbidden");
	const original = readStoreFile(sourceRoot, path.basename(source)),
		value = parseEvaluationRecord(original);
	evaluationId(value?.id);
	const key = kind === "plans" ? "planDigest" : "resultDigest";
	const relative = `evaluations/${kind}/ids/${value.id}.json`,
		target = safePath(store, relative);
	const authority = existsSync(target) ? readStoreFile(store, relative) : null;
	validate(store, value);
	const digest = hashEvaluationRecord(evaluationDomains[kind], value);
	const unchanged = () => {
		if (!readStoreFile(sourceRoot, path.basename(source)).equals(original))
			throw new Error(
				"stale-input: evaluation input changed after validated read",
			);
		if (
			authority === null
				? existsSync(target)
				: !readStoreFile(store, relative).equals(authority)
		)
			throw new Error(
				"evaluation immutable index authority changed before commit",
			);
	};
	const existing = () => {
		if (!existsSync(target)) return false;
		const index = evaluationIndex(store, kind, value.id),
			old = evaluationObject(store, kind, index[key]);
		validate(store, old);
		if (old.id !== value.id)
			throw new Error("evaluation immutable index: record id binding mismatch");
		if (index[key] !== digest)
			throw new Error(
				"evaluation immutable id conflict: cannot repoint existing evidence",
			);
		return true;
	};
	unchanged();
	if (existing())
		return {
			id: value.id,
			...(kind === "results" ? { planDigest: value.planDigest } : {}),
			[key]: digest,
			status: "reused",
		};
	try {
		mkdirSync(storeWriter);
	} catch (error) {
		if (errorCode(error) === "EEXIST")
			throw new Error("store-busy: writer lock exists");
		throw error;
	}
	let committed = false;
	try {
		const ownership = canonicalJSON({
			pid: process.pid,
			operation: randomUUID(),
		});
		writeFlushed(path.join(storeWriter, "owner.json"), ownership);
		unchanged();
		validate(store, value);
		const objectRelative = `evaluations/${kind}/sha256/${digest}.json`,
			objectTarget = safePath(store, objectRelative),
			bytes = canonicalEvaluationJSON(value);
		if (existsSync(objectTarget)) {
			evaluationObject(store, kind, digest);
		} else {
			const stage = path.join(storeWriter, "object.json");
			writeFlushed(stage, bytes);
			if (!readStoreFile(storeWriter, "object.json").equals(bytes))
				throw new Error("evaluation record: staged readback mismatch");
			mkdirSync(path.dirname(objectTarget), { recursive: true });
			publish(stage, objectTarget, renameSync);
		}
		const index = { evaluationIndexVersion: 1, id: value.id, [key]: digest },
			indexBytes = canonicalJSON(index);
		const staged = path.join(storeWriter, "index.json");
		writeFlushed(staged, indexBytes);
		if (!readStoreFile(storeWriter, "index.json").equals(indexBytes))
			throw new Error("evaluation index: staged canonical readback mismatch");
		evaluationObject(store, kind, digest);
		validate(store, value);
		mkdirSync(path.dirname(target), { recursive: true });
		unchanged();
		if (!readStoreFile(storeWriter, "owner.json").equals(ownership))
			throw new Error("evaluation writer ownership changed");
		publish(staged, target, renameSync);
		committed = true;
		existing();
		return {
			id: value.id,
			...(kind === "results" ? { planDigest: value.planDigest } : {}),
			[key]: digest,
			status: "published",
		};
	} catch (error) {
		if (committed || existsSync(target))
			throw new Error(
				`evaluation publication incomplete: committed index retained; ${errorMessage(error)}`,
				{ cause: error },
			);
		throw error;
	} finally {
		rmSync(storeWriter, { recursive: true, force: true });
	}
}
function planMigrationEvaluationOperation(input) {
	fields(
		input,
		["root", "candidateId", "planFile"],
		["storeRoot"],
		"evaluation plan publication",
	);
	evaluationId(input.candidateId);
	return retainEvaluation(input, "plans", input.planFile, (store, plan) => {
		if (plan.candidateId !== input.candidateId)
			throw new Error("evaluation candidate id binding mismatch");
		evaluationPlanBacking(store, plan);
	});
}
function importMigrationEvaluationResultsOperation(input) {
	fields(
		input,
		["root", "planId", "resultFile"],
		["storeRoot"],
		"evaluation result import",
	);
	evaluationId(input.planId);
	const store = packageStoreRoot(input.storeRoot),
		retained = migrationEvaluationPlan({ storeRoot: store, id: input.planId });
	return retainEvaluation(
		{ ...input, storeRoot: store },
		"results",
		input.resultFile,
		(selected, results) =>
			evaluationResults(selected, results, retained.planDigest),
	);
}

const promotionDomain = "agent-profiles/promotion-decision/v1";
const equalJSON = (a, b) => canonicalJSON(a).equals(canonicalJSON(b));
const plain = (value) =>
	value instanceof Map
		? Object.fromEntries([...value].map(([key, item]) => [key, plain(item)]))
		: Array.isArray(value)
			? value.map(plain)
			: value;
// Decision relations against retained immutable evidence only; no live project state is read here.
function promotionEvidence(store, decision) {
	validateDecision(decision);
	if (
		evaluationIndex(store, "results", decision.resultId).resultDigest !==
		decision.resultDigest
	)
		throw new Error(
			"promotion decision resultDigest: binding mismatch with the retained result index",
		);
	const report = migrationEvaluationReport({
		storeRoot: store,
		id: decision.resultId,
	});
	if (report.planDigest !== decision.planDigest)
		throw new Error(
			"promotion decision planDigest: binding mismatch with the retained results",
		);
	if (
		report.candidate.revisionDigest !== decision.candidateRevisionDigest ||
		report.candidate.id !== decision.candidateId
	)
		throw new Error(
			"promotion decision candidate revision/id binding mismatch",
		);
	if (!equalJSON(decision.assignment, report.context.assignment))
		throw new Error(
			"promotion decision assignment: only the exact evaluated primary assignment may be promoted",
		);
	const candidate = migrationCandidate({
		storeRoot: store,
		id: decision.candidateId,
	});
	const record = readRevisionRecord({
		storeRoot: store,
		recordDigest: candidate.revisionDigest,
	});
	if (!equalJSON(decision.release, record.identity))
		throw new Error(
			"promotion decision release: must equal the candidate planned label",
		);
	if (!equalJSON(decision.regressions, report.eligibility.regressions))
		throw new Error(
			"promotion decision regressions: must equal the retained report regressions",
		);
	const regressed = report.eligibility.regressions.map((row) => row.caseId),
		override = decision.correctnessOverride;
	if (override === null && regressed.length)
		throw new Error(
			`promotion blocked: per-case correctness drop in ${regressed.join(", ")}; only an explicit recorded correctness-only override may waive it`,
		);
	if (override !== null && !regressed.length)
		throw new Error(
			"promotion correctnessOverride: no reported regression to waive",
		);
	if (
		override !== null &&
		!equalJSON([...override.cases].sort(compare), [...regressed].sort(compare))
	)
		throw new Error(
			"promotion correctnessOverride cases: must name exactly the regressed cases",
		);
	const decisionDigest = hashRecord(promotionDomain, decision);
	const wrapper = {
		revisionVersion: 2,
		kind: "release",
		identity: record.identity,
		content: record.content,
		parent: record.parent,
		candidate: candidate.revisionDigest,
		dependencies: record.dependencies,
		workflow: record.workflow,
		provenance: { kind: "promotion", decisionDigest },
	};
	return {
		report,
		candidate,
		record,
		decisionDigest,
		wrapper,
		releaseDigest: hashRecord("agent-profiles/revision/v2", wrapper),
		gate: {
			status: override === null ? "eligible" : "overridden",
			regressions: report.eligibility.regressions,
			override,
		},
	};
}
// Unqualified rules keep their original id; a profile qualifier is part of the derived identity.
const promotionRuleId = ({ role, model, host, profile }) =>
	`promotion-${hash(Buffer.from(JSON.stringify(profile === undefined ? [role, model, host] : [role, model, host, profile]))).slice(0, 16)}`;
// Shared by planning and replay freshness. The resolver selects the unique containment-maximal matching rule, so every other
// matching rule is a subset of the selected one: replace it when it already pins the exact tuple (its other qualifiers already
// match), otherwise add one rule that keeps its qualifiers and pins the tuple, which strictly contains every matching rule.
function promotionRule(selected, { role, model, host }) {
	const selectors =
		selected.selectedBy === "binding-default" ? {} : (selected.selectors ?? {});
	if (
		selected.selectedBy !== "binding-default" &&
		selectors.role === role &&
		selectors.model === model &&
		selectors.host === host
	)
		return {
			id: selected.selectedBy,
			when: { ...selectors },
			action: "replace",
		};
	const when = { ...selectors, role, model, host };
	return { id: promotionRuleId(when), when, action: "add" };
}
// Completed-promotion freshness: live selection, actors, peers, bytes and local inputs must equal the evaluated candidate capture,
// modulo ONLY the intended primary candidate→release digest and the deliberate rule-specificity change on that binding.
function candidateFreshness(root, store, current, evidence, assignment) {
	const evaluated = reconstructStamp({
			storeRoot: store,
			digest: evidence.candidate.stampDigest,
		}),
		resolution = current.resolution;
	const candidateDigest = evidence.candidate.revisionDigest,
		releaseDigest = evidence.releaseDigest,
		binding = evidence.record.provenance.binding;
	const primary = evaluated.selectionBindings.find(
		(row) => row.root.binding === binding,
	)?.root;
	if (!primary)
		throw new Error(
			"stale-input: promotion freshness: evaluated binding missing from the candidate capture",
		);
	const target = promotionRule(primary, assignment),
		rule = { selectedBy: target.id, selectors: target.when };
	// Same scoping as the candidate capture projection: only rows pinned to the evaluated candidate digest change.
	const project = (value) => {
		if (Array.isArray(value)) return value.map(project);
		if (!value || typeof value !== "object") return value;
		const copy = Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, project(child)]),
		);
		if (copy.revisionDigest === candidateDigest) {
			copy.revisionDigest = releaseDigest;
			if (copy.binding === binding && Object.hasOwn(copy, "selectedBy"))
				Object.assign(copy, rule);
		}
		return copy;
	};
	const actors = [...current.evidence.actors].sort((a, b) =>
		compare(assignmentKey(a.assignment), assignmentKey(b.assignment)),
	);
	if (
		!equalJSON(
			current.evidence.primary,
			project(evaluated.selectionBindings),
		) ||
		!equalJSON(actors, project(evaluated.workflowActors)) ||
		!equalJSON(resolution.workflow.peers, project(evaluated.workflowPeers))
	)
		throw new Error(
			"stale-input: promotion freshness: selection, workflow actors or peers changed since evaluation",
		);
	if (
		resolution.workflow.status !== "declared-compatible" ||
		resolution.unsatisfied.length
	)
		throw new Error(
			"stale-input: promotion freshness: workflow readiness changed since evaluation",
		);
	if (
		resolution.loaded.length !== evaluated.composition.length ||
		resolution.loaded.some(
			(entry, i) =>
				entry.kind !== evaluated.composition[i].kind ||
				!Buffer.from(entry.content).equals(evaluated.composition[i].bytes),
		)
	)
		throw new Error(
			"stale-input: promotion freshness: loaded context changed from the evaluated candidate bytes",
		);
	for (const entry of [
		...evaluated.composition,
		...evaluated.available,
		...evaluated.resources,
		...evaluated.shared,
	]) {
		if (
			entry.backing?.type === "blob" &&
			entry.bytes &&
			!readStoreFile(root, entry.backing.path).equals(entry.bytes)
		)
			throw new Error(
				"stale-input: promotion freshness: evaluated local inputs changed",
			);
	}
}
// Read-only: validates evidence, immutable authority and live freshness, then computes the exact tuple binding edit.
function promotionPlan(input, label) {
	fields(input, ["root", "decisionFile"], ["storeRoot"], label);
	const root = rootDirectory(input.root),
		store = packageStoreRoot(input.storeRoot);
	const inside = (a, b) => {
		const r = path.relative(a, b);
		return !path.isAbsolute(r) && r !== ".." && !r.startsWith(`..${path.sep}`);
	};
	if (
		inside(file(root, directory), store) ||
		inside(file(root, writer), store) ||
		inside(store, file(root, writer))
	)
		throw new Error("promotion namespace/store overlap is forbidden");
	text(input.decisionFile, "promotion decisionFile");
	const source = path.resolve(input.decisionFile),
		sourceRoot = rootPath(path.dirname(source), "promotion decision parent"),
		sourceName = path.basename(source);
	if (inside(store, path.join(sourceRoot, sourceName)))
		throw new Error("promotion decision source/store overlap is forbidden");
	const decisionBytes = readStoreFile(sourceRoot, sourceName),
		decision = parseRecord(decisionBytes);
	const evidence = promotionEvidence(store, decision),
		{ wrapper, releaseDigest, decisionDigest } = evidence;
	const indexRelative = `promotions/decisions/ids/${decision.id}.json`,
		labelRelative = labelPath(wrapper.identity);
	const indexBytes = canonicalJSON({
		promotionIndexVersion: 1,
		id: decision.id,
		decisionDigest,
		releaseDigest,
	});
	const labelBytes = canonicalJSON({
		identity: wrapper.identity,
		recordDigest: releaseDigest,
	});
	// Immutable authority: neither the decision id nor the external label can ever be repointed.
	const authority = () => {
		const index = existsSync(safePath(store, indexRelative))
			? readPromotionIndex(store, decision.id)
			: null;
		if (index && !canonicalJSON(index).equals(indexBytes))
			throw new Error(
				"promotion immutable id conflict: cannot repoint an existing decision",
			);
		const label = existsSync(safePath(store, labelRelative))
			? readStoreFile(store, labelRelative)
			: null;
		if (label && !label.equals(labelBytes))
			throw new Error(
				"promotion release label: already published for another wrapper; cannot repoint",
			);
		return { indexed: index !== null, labeled: label !== null };
	};
	const published = authority();
	const configBytes = readStoreFile(root, configFile),
		lockBytes = readStoreFile(root, lockFile),
		config = parseYaml(configBytes.toString("utf8"));
	if (!(config instanceof Map) || config.get("version") !== 3)
		throw new Error(
			"promotion: explicitly prepare a config3 project first; configuration version 3 is required and is never converted automatically",
		);
	const selectors = { root, storeRoot: store, ...decision.assignment },
		binding = evidence.record.provenance.binding;
	let current = null;
	if (published.indexed && published.labeled)
		try {
			current = resolveCapture({ ...selectors, configuration: config });
		} catch {
			current = null;
		}
	const applied =
		current?.evidence.primary.find((row) => row.root.binding === binding)?.root
			.revisionDigest === releaseDigest;
	const base = {
		decisionBytes,
		decision,
		evidence,
		store,
		root,
		sourceRoot,
		sourceName,
		configBytes,
		lockBytes,
		config,
		selectors,
		authority,
		indexRelative,
		indexBytes,
		labelRelative,
		labelBytes,
		published,
	};
	// A matching target digest is not freshness: the live context must still load exactly the evaluated candidate bytes.
	if (applied) {
		candidateFreshness(root, store, current, evidence, decision.assignment);
		return { ...base, applied, nextConfig: configBytes, target: null };
	}
	current = evaluationContext(
		root,
		selectors,
		config,
		verifiedProposalBase(store, {
			stamp: evidence.report.baseStamp,
			assignment: decision.assignment,
		}),
	);
	const selected = [
		...current.resolution.required,
		...current.resolution.available,
	].find((entry) => entry.package?.binding === binding)?.package;
	if (!selected || selected.revisionDigest !== evidence.record.parent)
		throw new Error(
			"promotion target: evaluated binding is not selected from the candidate parent",
		);
	const { role, model, host } = decision.assignment,
		rule = promotionRule(selected, decision.assignment),
		exact = rule.action === "replace";
	const assignments = config.get("assignments") ?? new Map();
	const existing = !exact && assignments.has(rule.id);
	if (
		existing &&
		!equalJSON(plain(assignments.get(rule.id).get("when")), rule.when)
	)
		throw new Error(
			`promotion target: assignments.${rule.id} already exists for another selector`,
		);
	const [section, id] = binding.split(".");
	// The evaluated source is whatever rule (or default) the resolver actually selected, not necessarily the default binding.
	const before = plain(
		selected.selectedBy === "binding-default"
			? config.get(section).get(id)
			: assignments.get(selected.selectedBy).get("bindings").get(binding),
	);
	const after = {
		package: wrapper.identity.name,
		version: wrapper.identity.version,
		revision: releaseDigest,
	};
	const document = parseYamlDocument(configBytes.toString("utf8"));
	// Only the evaluated tuple's most specific rule changes; shared defaults and other consumers keep their exact pins.
	if (exact || existing)
		document.setIn(
			["assignments", rule.id, "bindings", binding],
			document.createNode(after),
		);
	else
		document.setIn(
			["assignments", rule.id],
			document.createNode({ when: rule.when, bindings: { [binding]: after } }),
		);
	const nextConfig = Buffer.from(document.toString());
	// Read-only preflight with the authoritative schema/ambiguity admission before any durable decision, label or project write.
	try {
		validateConfiguration({
			root,
			configuration: parseYaml(nextConfig.toString("utf8")),
		});
	} catch (error) {
		throw new Error(
			`promotion target: proposed binding edit is not a valid unambiguous configuration; nothing was written; ${errorMessage(error)}`,
			{ cause: error },
		);
	}
	return {
		...base,
		applied,
		nextConfig,
		target: { assignment: { role, model, host }, binding, rule, before, after },
	};
}
const promotionSummary = (plan) => ({
	decision: {
		id: plan.decision.id,
		decisionDigest: plan.evidence.decisionDigest,
	},
	release: {
		identity: plan.evidence.wrapper.identity,
		content: plan.evidence.wrapper.content,
		releaseDigest: plan.evidence.releaseDigest,
	},
});

function previewMigrationPromotionOperation(input) {
	const plan = promotionPlan(input, "promotion preview"),
		summary = promotionSummary(plan);
	return {
		status: "preview",
		decision: summary.decision,
		gate: plan.evidence.gate,
		release: {
			...summary.release,
			state: plan.published.labeled ? "published" : "new",
		},
		target: plan.target,
	};
}

function applyMigrationPromotionOperation(input) {
	const plan = promotionPlan(input, "promotion apply"),
		{ store, root, decision, evidence } = plan,
		summary = promotionSummary(plan);
	if (plan.applied)
		return {
			status: "reused",
			...summary,
			target: null,
			stampDigest: createStamp(plan.selectors).digest,
		};
	const unchangedSource = () => {
		if (
			!readStoreFile(plan.sourceRoot, plan.sourceName).equals(
				plan.decisionBytes,
			)
		)
			throw new Error(
				"stale-input: promotion decision changed after validated read",
			);
	};
	const storeWriter = safePath(store, ".writer-lock");
	try {
		mkdirSync(storeWriter);
	} catch (error) {
		if (errorCode(error) === "EEXIST")
			throw new Error("store-busy: writer lock exists");
		throw error;
	}
	let committed = false;
	try {
		const ownership = canonicalJSON({
			pid: process.pid,
			operation: randomUUID(),
		});
		writeFlushed(path.join(storeWriter, "owner.json"), ownership);
		unchangedSource();
		plan.authority();
		const stage = (name, relative, bytes) => {
			const target = safePath(store, relative);
			if (existsSync(target)) {
				if (!readStoreFile(store, relative).equals(bytes))
					throw new Error(`${relative}: immutable record mismatch`);
				return;
			}
			const staged = path.join(storeWriter, name);
			writeFlushed(staged, bytes);
			if (!readStoreFile(storeWriter, name).equals(bytes))
				throw new Error(`${relative}: staged readback mismatch`);
			mkdirSync(path.dirname(target), { recursive: true });
			publish(staged, target, renameSync);
		};
		stage(
			"decision.json",
			`promotions/decisions/sha256/${evidence.decisionDigest}.json`,
			canonicalJSON(decision),
		);
		stage(
			"release.json",
			`revisions/sha256/${evidence.releaseDigest}.json`,
			canonicalJSON(evidence.wrapper),
		);
		// Existing relation validator (candidate content + decision binding) runs before the decision commit.
		readRevisionRecord({
			storeRoot: store,
			recordDigest: evidence.releaseDigest,
		});
		unchangedSource();
		plan.authority();
		if (!readStoreFile(storeWriter, "owner.json").equals(ownership))
			throw new Error("promotion writer: ownership changed before publication");
		stage("index.json", plan.indexRelative, plan.indexBytes);
		committed = true;
		stage("label.json", plan.labelRelative, plan.labelBytes);
		lookupRevisionManifest({
			storeRoot: store,
			recordDigest: evidence.releaseDigest,
		});
	} catch (error) {
		if (committed)
			throw new Error(
				`promotion partial/incomplete: decision ${decision.id} is committed but its release label is not published; replay the same decision to complete; ${errorMessage(error)}`,
				{ cause: error },
			);
		throw error;
	} finally {
		rmSync(storeWriter, { recursive: true, force: true });
	}
	try {
		return withWriter(root, () => {
			if (
				!readStoreFile(root, configFile).equals(plan.configBytes) ||
				!readStoreFile(root, lockFile).equals(plan.lockBytes)
			)
				throw new Error(
					"stale-input: project configuration or lock changed after validated read",
				);
			// Recheck evaluated managed inputs against the retained base BEFORE activation; a post-write check alone is unsafe.
			evaluationContext(
				root,
				plan.selectors,
				plan.config,
				verifiedProposalBase(store, {
					stamp: evidence.report.baseStamp,
					assignment: decision.assignment,
				}),
			);
			applyChanges(
				root,
				[
					{
						file: configFile,
						before: plan.configBytes,
						after: plan.nextConfig,
					},
				],
				() => installDependencies({ root, storeRoot: store }),
			);
			const stamp = createStamp(plan.selectors),
				evaluated = parseRecord(
					readStoreFile(
						store,
						`stamps/sha256/${evidence.candidate.stampDigest}/snapshot.json`,
					),
				);
			const parts = (snapshot) =>
				snapshot.composition.map((part) => [part.kind, part.id, part.backing]);
			if (!equalJSON(parts(stamp.snapshot), parts(evaluated)))
				throw new Error(
					"promotion: promoted composition differs from the evaluated candidate bytes",
				);
			return {
				status: "promoted",
				...summary,
				target: plan.target,
				stampDigest: stamp.digest,
			};
		});
	} catch (error) {
		throw new Error(
			`promotion partial/incomplete: release ${evidence.releaseDigest} is published but the project binding was not completed; preserve edits and replay the same decision; ${errorMessage(error)}`,
			{ cause: error },
		);
	}
}

// Rootless verified readback: decision, evidence relations and public release admission.
function migrationPromotionOperation(input) {
	fields(input, ["id"], ["storeRoot"], "promotion read");
	const store = packageStoreRoot(input.storeRoot),
		index = readPromotionIndex(store, input.id),
		decision = readPromotionDecision(store, index.decisionDigest);
	if (decision.id !== input.id)
		throw new Error("promotion index: decision id binding mismatch");
	if (promotionEvidence(store, decision).releaseDigest !== index.releaseDigest)
		throw new Error("promotion index: release binding mismatch");
	const release = lookupRevisionManifest({
		storeRoot: store,
		recordDigest: index.releaseDigest,
	});
	return {
		id: input.id,
		decisionDigest: index.decisionDigest,
		releaseDigest: index.releaseDigest,
		decision,
		release,
	};
}

export const startMigration = inStoreSession(startMigrationOperation);
export const migrationStatus = inStoreSession(migrationStatusOperation);
export const abandonMigration = inStoreSession(abandonMigrationOperation);
export const proposeMigration = inStoreSession(proposeMigrationOperation);
export const migrationProposals = inStoreSession(migrationProposalsOperation);
export const rejectMigrationProposal = inStoreSession(
	rejectMigrationProposalOperation,
);
export const acceptMigrationProposal = inStoreSession(
	acceptMigrationProposalOperation,
);
export const migrationCandidate = inStoreSession(migrationCandidateOperation);
export const publishMigrationCandidate = inStoreSession(
	publishMigrationCandidateOperation,
);
export const migrationEvaluationPlan = inStoreSession(
	migrationEvaluationPlanOperation,
);
export const migrationEvaluationReport = inStoreSession(
	migrationEvaluationReportOperation,
);
export const planMigrationEvaluation = inStoreSession(
	planMigrationEvaluationOperation,
);
export const importMigrationEvaluationResults = inStoreSession(
	importMigrationEvaluationResultsOperation,
);
export const previewMigrationPromotion = inStoreSession(
	previewMigrationPromotionOperation,
);
export const applyMigrationPromotion = inStoreSession(
	applyMigrationPromotionOperation,
);
export const migrationPromotion = inStoreSession(migrationPromotionOperation);
