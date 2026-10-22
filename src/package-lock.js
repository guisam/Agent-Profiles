import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorCode, errorMessage, safePath } from "./files.ts";
import {
	candidateReservation,
	importPackage,
	inStoreSession,
	lookupPackage,
} from "./package-store.js";
import {
	canonicalJSON,
	hashRecord,
	parseRecord,
	readPackage,
	validateMembers,
} from "./packages.ts";
import {
	identifier,
	packageReferences,
	parseYaml,
	validateConfiguration,
	validatePackageBindings,
} from "./resolve.ts";
import { releasedPackage, revisionClosure } from "./revisions.js";

const configurationFile = ".agent-profiles/agents.yaml";
const lockFile = ".agent-profiles/agent-profiles.lock";
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const identityKey = ({ name, version }) => `${name}@${version}`;
const pinKey = (pin) => JSON.stringify([pin.binding, pin.rule]);
const pinOrder = (a, b) =>
	compare(a.binding, b.binding) ||
	(a.rule === b.rule
		? 0
		: a.rule === null
			? -1
			: b.rule === null
				? 1
				: compare(a.rule, b.rule));
const packageOrder = (a, b) =>
	compare(a.name, b.name) || compare(a.version, b.version);

function fail(location, message) {
	throw new Error(`${location}: ${message}`);
}

function fields(value, location, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(location, "expected an object");
	for (const key of Object.keys(value))
		if (!keys.includes(key)) fail(`${location}.${key}`, "unknown field");
	for (const key of keys)
		if (!Object.hasOwn(value, key))
			fail(`${location}.${key}`, "required field is missing");
}

function identity(value, location) {
	if (
		typeof value.name !== "string" ||
		!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(value.name)
	)
		fail(`${location}.name`, "expected package @namespace/name");
	if (
		typeof value.version !== "string" ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
			value.version,
		) ||
		value.version.split(".").some((n) => !Number.isSafeInteger(Number(n)))
	)
		fail(`${location}.version`, "expected exact safe release version");
}

function digest(value, location) {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		fail(location, "expected sha256 digest");
}

function portable(value, location) {
	try {
		validateMembers([{ path: value, type: "directory" }]);
	} catch (error) {
		fail(location, errorMessage(error));
	}
}

function localPath(value, location) {
	if (typeof value !== "string" || !value.trim())
		fail(location, "expected nonempty local directory path");
	if (
		/^[\\/]{2}|^[a-z][a-z0-9+.-]*:/i.test(value) &&
		!/^[a-z]:[\\/]/i.test(value)
	)
		fail(location, "remote-acquisition-unsupported: nonlocal path");
	if (value.split(/[\\/]/).includes("..")) fail(location, "unsafe traversal");
	return value;
}

const inside = (base, target) => {
	const relative = path.relative(base, target);
	return (
		!path.isAbsolute(relative) &&
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`)
	);
};
const sameStat = (a, b) =>
	["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
		(key) => a[key] === b[key],
	);

function canonicalStore(selected) {
	const suffix = [];
	let existing = selected;
	for (;;) {
		try {
			const stat = lstatSync(existing);
			if (stat.isSymbolicLink() || !stat.isDirectory())
				fail("store", "expected an unlinked directory");
			return path.join(realpathSync(existing), ...suffix);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
			if (path.dirname(existing) === existing)
				fail(
					"store",
					`no existing ancestor directory for ${selected}; check that the filesystem root is available`,
				);
			suffix.unshift(path.basename(existing));
			existing = path.dirname(existing);
		}
	}
}

function input(root, relative) {
	const target = safePath(root, relative);
	let stat;
	try {
		stat = lstatSync(target, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		throw error;
	}
	if (!stat.isFile() || stat.nlink !== 1n)
		fail(relative, "expected a regular unlinked file");
	const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (!sameStat(stat, fstatSync(fd, { bigint: true })))
			fail(relative, "changed during read");
		const bytes = readFileSync(fd);
		if (
			!sameStat(stat, fstatSync(fd, { bigint: true })) ||
			!sameStat(stat, lstatSync(target, { bigint: true }))
		)
			fail(relative, "changed during read");
		return { bytes, stat };
	} finally {
		closeSync(fd);
	}
}

function plain(value) {
	if (value instanceof Map)
		return Object.fromEntries(
			[...value].map(([key, item]) => [key, plain(item)]),
		);
	return Array.isArray(value) ? value.map(plain) : value;
}

function readLock(bytes) {
	const lock = parseRecord(bytes);
	fields(lock, "lock", [
		"lockVersion",
		"configurationVersion",
		"resolverContract",
		"configSha256",
		"pins",
		"packages",
	]);
	if (![1, 2].includes(lock.lockVersion))
		fail("lockVersion", "unsupported lock version");
	const v3 = lock.lockVersion === 2;
	if (lock.configurationVersion !== (v3 ? 3 : 2))
		fail("configurationVersion", `expected ${v3 ? 3 : 2}`);
	if (lock.resolverContract !== `agent-profiles/resolver/v${v3 ? 3 : 2}`)
		fail("resolverContract", "unsupported resolver contract");
	digest(lock.configSha256, "configSha256");
	for (const key of ["pins", "packages"])
		if (!Array.isArray(lock[key])) fail(key, "expected an array");
	const pins = new Set(),
		packages = new Set();
	for (const pin of lock.pins) {
		fields(pin, "pin", [
			"binding",
			"rule",
			"package",
			"version",
			"sha256",
			...(v3 ? ["revisionDigest"] : []),
		]);
		if (v3 && pin.revisionDigest !== null)
			digest(pin.revisionDigest, "pin.revisionDigest");
		if (
			typeof pin.binding !== "string" ||
			!/^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/.test(pin.binding)
		)
			fail("pin.binding", "invalid binding");
		if (pin.rule !== null) identifier(pin.rule, "pin.rule");
		identity({ name: pin.package, version: pin.version }, "pin.package");
		digest(pin.sha256, "pin.sha256");
		const key = pinKey(pin);
		if (pins.has(key)) fail("lock-coverage", "duplicate pin");
		pins.add(key);
	}
	for (const pkg of lock.packages) {
		fields(pkg, "package", [
			"name",
			"version",
			"sha256",
			"source",
			...(v3 ? ["revisionDigests"] : []),
		]);
		if (v3) {
			if (!Array.isArray(pkg.revisionDigests))
				fail("package.revisionDigests", "expected array");
			for (const [i, revision] of pkg.revisionDigests.entries()) {
				digest(revision, "package.revisionDigests");
				if (i && compare(pkg.revisionDigests[i - 1], revision) >= 0)
					fail("package.revisionDigests", "expected unique sorted digests");
			}
		}
		identity(pkg, "package");
		digest(pkg.sha256, "package.sha256");
		const key = identityKey(pkg);
		if (packages.has(key)) fail("lock-coverage", "duplicate package");
		packages.add(key);
		const source = pkg.source;
		if (!source || typeof source !== "object" || Array.isArray(source))
			fail("source", "expected an object");
		if (source.type === "provided") fields(source, "source", ["type"]);
		else if (source.type === "local-directory") {
			fields(source, "source", ["type", "locator"]);
			portable(source.locator, "source.locator");
		} else if (source.type === "git") {
			fields(source, "source", [
				"type",
				"repository",
				"commit",
				"subdirectory",
			]);
			if (typeof source.repository !== "string" || !source.repository.trim())
				fail("source.repository", "expected a nonempty string");
			if (
				typeof source.commit !== "string" ||
				!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)
			)
				fail("source.commit", "expected a full Git commit");
			portable(source.subdirectory, "source.subdirectory");
		} else fail("source.type", "unsupported source");
	}
	for (const [key, order] of new Map([
		["pins", pinOrder],
		["packages", packageOrder],
	])) {
		for (let i = 1; i < lock[key].length; i++)
			if (order(lock[key][i - 1], lock[key][i]) >= 0)
				fail(key, "lock-coverage: entries must be unique and sorted");
	}
	return lock;
}

function configDigest(configuration) {
	const config = plain(configuration);
	for (const key of ["profiles", "skills", "assignments"])
		if (!Object.hasOwn(config, key)) config[key] = {};
	if (config.version === 3 && !Object.hasOwn(config, "workflow_links"))
		config.workflow_links = {};
	return hashRecord(
		`agent-profiles/config/v${config.version === 3 ? 3 : 2}`,
		config,
	);
}

function declared(bindings, v3 = false, storeRoot = undefined) {
	const pins = [];
	const wanted = new Map();
	function add(name, version, revisionDigest = null) {
		const key = identityKey({ name, version });
		if (!wanted.has(key))
			wanted.set(key, {
				name,
				version,
				...(v3 ? { revisionDigests: [] } : {}),
			});
		const item = wanted.get(key);
		if (
			v3 &&
			revisionDigest !== null &&
			!item.revisionDigests.includes(revisionDigest)
		)
			item.revisionDigests.push(revisionDigest);
	}
	for (const [binding, value] of bindings) {
		for (const { reference, rule } of packageReferences(binding, value)) {
			const name = reference.get("package"),
				version = reference.get("version"),
				revisionDigest = reference.get("revision") ?? null;
			pins.push({
				binding,
				rule,
				package: name,
				version,
				...(v3 ? { revisionDigest } : {}),
			});
			add(name, version, revisionDigest);
			if (revisionDigest !== null)
				for (const member of revisionClosure({
					storeRoot,
					name,
					version,
					revisionDigest,
				}))
					add(
						member.identity.name,
						member.identity.version,
						member.revisionDigest,
					);
		}
	}
	if (v3)
		for (const item of wanted.values()) item.revisionDigests.sort(compare);
	pins.sort(pinOrder);
	return { pins, wanted };
}

// Exact coverage of a current lock; returns its packages by identity.
function coverage(lock, { pins, wanted }) {
	if (lock.pins.length !== pins.length || lock.packages.length !== wanted.size)
		fail("lock-coverage", "missing or extra pins/packages");
	for (let i = 0; i < pins.length; i++) {
		const actual = lock.pins[i],
			expected = pins[i];
		if (
			pinKey(actual) !== pinKey(expected) ||
			actual.package !== expected.package ||
			actual.version !== expected.version ||
			actual.revisionDigest !== expected.revisionDigest
		)
			fail("lock-coverage", "pin mismatch");
	}
	const locked = new Map();
	for (const pkg of lock.packages) {
		if (!wanted.has(identityKey(pkg))) fail("lock-coverage", "foreign package");
		if (
			lock.lockVersion === 2 &&
			JSON.stringify(pkg.revisionDigests) !==
				JSON.stringify(wanted.get(identityKey(pkg)).revisionDigests)
		)
			fail("lock-coverage", "revision closure mismatch");
		locked.set(identityKey(pkg), pkg);
	}
	for (const pin of lock.pins)
		if (
			locked.get(identityKey({ name: pin.package, version: pin.version }))
				?.sha256 !== pin.sha256
		)
			fail("lock-coverage", "inconsistent digest");
	return locked;
}

/**
 * Read-only lock state: never writes or repairs; v3 also verifies the declared revision closure in the explicit store.
 * @param {string} root canonical project root @param {{config: Map<string, any>, bindings: Map<string, any>}} validated
 * @param {string} [storeRoot]
 * @returns {{state: 'valid' | 'missing' | 'stale' | 'invalid', error?: string, locked?: Map<string, {sha256: string}>}}
 */
function readLockStateOperation(root, validated, storeRoot = undefined) {
	const configSha256 = configDigest(validated.config);
	try {
		const found = input(root, lockFile);
		if (!found)
			return {
				state: "missing",
				error: `${lockFile}: missing; run dependency install`,
			};
		const lock = readLock(found.bytes);
		const v3 = validated.config.get("version") === 3;
		if (lock.lockVersion !== (v3 ? 2 : 1))
			fail(
				"lockVersion",
				`requires lock${v3 ? 2 : 1}; run dependency install for version ${v3 ? 3 : 2}`,
			);
		if (lock.configSha256 !== configSha256)
			return {
				state: "stale",
				error: `${lockFile}: stale-lock: configuration changed; run dependency install`,
			};
		return {
			state: "valid",
			locked: coverage(lock, declared(validated.bindings, v3, storeRoot)),
		};
	} catch (error) {
		return { state: "invalid", error: `${lockFile}: ${errorMessage(error)}` };
	}
}

/** @param {{root: string, storeRoot?: string, sources?: {name: string, version: string, directory: string}[], frozen?: boolean, offline?: boolean}} options */
function installDependenciesOperation({
	root,
	storeRoot,
	sources = [],
	frozen = false,
	offline = false,
}) {
	if (typeof frozen !== "boolean" || typeof offline !== "boolean")
		fail("install", "frozen and offline must be booleans");
	root = path.resolve(localPath(root, "root"));
	if (lstatSync(root).isSymbolicLink())
		fail("root", "link/junction is forbidden");
	root = realpathSync(root);
	const beforeConfig = input(root, configurationFile),
		beforeLock = input(root, lockFile);
	if (!beforeConfig) fail(configurationFile, "missing configuration");
	const configuration = parseYaml(beforeConfig.bytes.toString("utf8"));
	if (configuration instanceof Map && configuration.get("version") === 1)
		fail(
			"version 1",
			"migrate to version 2 using docs/migrations/config-v1-to-v2.md before installing dependencies",
		);
	const validated = validateConfiguration({ root, configuration });
	const v3 = configuration.get("version") === 3;
	const configSha256 = configDigest(configuration);
	const { pins, wanted } = declared(validated.bindings, v3, storeRoot);
	const lock = beforeLock && readLock(beforeLock.bytes);
	const current =
		lock?.configSha256 === configSha256 && lock.lockVersion === (v3 ? 2 : 1);
	if (frozen && !lock) fail("lock", "missing lock");
	if (frozen && !current)
		fail("stale-lock", "configuration changed; run dependency install");
	const locked = current ? coverage(lock, { pins, wanted }) : new Map();
	if (!Array.isArray(sources)) fail("sources", "expected an array");
	const supplied = new Map();
	for (const source of sources) {
		fields(source, "sources", ["name", "version", "directory"]);
		identity(source, "sources");
		const key = identityKey(source);
		if (supplied.has(key)) fail("sources", "duplicate identity");
		if (!wanted.has(key)) fail("sources", "foreign undeclared identity");
		localPath(source.directory, "sources.directory");
		supplied.set(key, path.resolve(root, source.directory));
	}
	const selectedStore = canonicalStore(
		path.resolve(
			localPath(
				storeRoot === undefined
					? (process.env.AGENT_PROFILES_STORE ??
							path.join(os.homedir(), ".agent-profiles/store"))
					: storeRoot,
				"store",
			),
		),
	);
	// A verified promoted release (decision index + label) fulfils its planned identity without any legacy mapping.
	const released = new Map(
		[...wanted].map(([key, item]) => [
			key,
			(item.revisionDigests ?? [])
				.map((revisionDigest) =>
					releasedPackage({
						storeRoot: selectedStore,
						name: item.name,
						version: item.version,
						revisionDigest,
					}),
				)
				.find(Boolean) ?? null,
		]),
	);
	for (const [key, item] of wanted)
		if (!released.get(key) && candidateReservation(selectedStore, item))
			fail(
				"candidate",
				`${item.name}@${item.version}: reserved planned release is unpublished`,
			);
	const records = new Map(),
		acquisitions = new Map(),
		packages = [];
	for (const [key, item] of [...wanted].sort((a, b) =>
		packageOrder(a[1], b[1]),
	)) {
		const prior = locked.get(key);
		const locator =
			prior?.source.type === "local-directory"
				? safePath(root, prior.source.locator)
				: undefined;
		if (locator !== undefined) {
			try {
				if (!lstatSync(locator).isDirectory())
					fail("source.locator", "expected a directory");
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
		}
		let cached;
		try {
			cached =
				lookupPackage({ storeRoot: selectedStore, ...item }) ??
				released.get(key);
		} catch (error) {
			fail(key, `mismatched-package: ${errorMessage(error)}`);
		}
		const directory = supplied.get(key) ?? (!cached ? locator : undefined);
		let record = cached,
			provenance = prior?.source ?? { type: "provided" };
		if (directory !== undefined) {
			const relative = path.relative(root, directory).split(path.sep).join("/");
			const approvedRoot = inside(root, directory)
				? root
				: path.dirname(directory);
			safePath(approvedRoot, path.relative(approvedRoot, directory));
			let canonical;
			try {
				canonical = realpathSync(directory);
			} catch (error) {
				if (errorCode(error) === "ENOENT")
					fail("missing-package", `${key}: source directory is missing`);
				throw error;
			}
			if (inside(selectedStore, canonical) || inside(canonical, selectedStore))
				fail(key, "source/store overlap is forbidden");
			record = readPackage({ root: directory, approvedRoot });
			if (
				record.manifest.package.name !== item.name ||
				record.manifest.package.version !== item.version
			)
				fail(key, "mismatched-package: source identity mismatch");
			if (cached && cached.sha256 !== record.sha256)
				fail(key, "identity-conflict: mismatched-package");
			if (inside(root, canonical)) {
				portable(relative, "source.locator");
				provenance = { type: "local-directory", locator: relative };
			} else provenance = { type: "provided" };
			if (!cached) acquisitions.set(key, { directory, sha256: record.sha256 });
		}
		if (!record)
			fail("missing-package", `${key}: supply an explicit local source`);
		if (prior && record.sha256 !== prior.sha256)
			fail(key, "mismatched-package: locked digest differs");
		records.set(key, record);
		packages.push({ ...item, sha256: record.sha256, source: provenance });
	}
	validatePackageBindings(validated.bindings, records);
	const output = canonicalJSON({
		lockVersion: v3 ? 2 : 1,
		configurationVersion: v3 ? 3 : 2,
		resolverContract: `agent-profiles/resolver/v${v3 ? 3 : 2}`,
		configSha256,
		pins: pins.map((pin) => ({
			...pin,
			sha256: records.get(
				identityKey({ name: pin.package, version: pin.version }),
			).sha256,
		})),
		packages,
	});
	const unchanged = () => {
		for (const [relative, before] of new Map([
			[configurationFile, beforeConfig],
			[lockFile, beforeLock],
		])) {
			const now = input(root, relative);
			if (
				before === null
					? now !== null
					: !now ||
						!before.bytes.equals(now.bytes) ||
						!sameStat(before.stat, now.stat)
			)
				fail(relative, "stale-input: changed during install; retry");
		}
	};
	const writer = safePath(root, ".agent-profiles/.dependency-writer");
	try {
		mkdirSync(writer);
	} catch (error) {
		if (errorCode(error) === "EEXIST")
			fail(
				"install-busy",
				"project writer exists; inspect interrupted operation before retrying",
			);
		throw error;
	}
	try {
		unchanged();
		for (const { directory, sha256 } of acquisitions.values())
			importPackage({
				sourceDirectory: directory,
				storeRoot: selectedStore,
				expectedDigest: sha256,
			});
		if (!frozen) {
			const staging = mkdtempSync(path.join(writer, "lock-"));
			const temporary = path.join(staging, "agent-profiles.lock");
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, output);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			unchanged();
			renameSync(temporary, safePath(root, lockFile));
		} else unchanged();
	} finally {
		rmSync(writer, { recursive: true, force: true });
	}
}

export const readLockState = inStoreSession(readLockStateOperation);
export const installDependencies = inStoreSession(installDependenciesOperation);
