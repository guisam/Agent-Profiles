// The local skill library (#44, phase 2 of #38): browse, search, inspect and publish
// packages in the existing content-addressed store. The library is the store; the
// index is derived from its identity records on every call, so it cannot drift.
import { errorMessage } from "./files.ts";
import { readLockState } from "./package-lock.ts";
import {
	importPackage,
	inStoreSession,
	listIdentities,
	lookupPackage,
} from "./package-store.ts";
import { parseManifest, readPackage } from "./packages.ts";
import { packageReferences, validateConfiguration } from "./resolve.ts";

const MANIFEST = "package.yaml";
const DOCS = "docs/versioned-packages.md";

/** One verified version, or the reason it could not be verified. */
export type LibraryVersion =
	| {
			version: string;
			sha256: string;
			type: "skill" | "instruction";
			description: string | null;
			license: string | null;
			entrypoint: string;
			delivery: "instruction" | "native";
			hosts: string[];
			effects: string[];
			files: number;
			bytes: number;
	  }
	| { version: string; sha256: string; error: string };

export type LibraryPackage = { name: string; versions: LibraryVersion[] };

const versionKey = (version: string) => version.split(".").map(Number);
/** Newest first, comparing the exact three numeric components. */
function newestFirst(a: string, b: string) {
	const [x, y] = [versionKey(a), versionKey(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
	return 0;
}

// Every reported version is verified (lookupPackage hashes the object); a corrupt
// object is reported with its error rather than shown as a valid version.
function describe(
	storeRoot: string | undefined,
	identity: { name: string; version: string },
	sha256: string,
): LibraryVersion {
	try {
		const found = lookupPackage({ storeRoot, ...identity });
		if (!found) throw new Error("identity record disappeared during listing");
		const manifestFile = found.files.find((file) => file.path === MANIFEST);
		if (!manifestFile) throw new Error(`${MANIFEST} missing from object`);
		const manifest = parseManifest(manifestFile.bytes);
		return {
			version: identity.version,
			sha256: found.sha256,
			type: manifest.package.type,
			description: manifest.package.description ?? null,
			license: manifest.package.license ?? null,
			entrypoint: manifest.entrypoint,
			delivery: manifest.behavior.delivery,
			hosts: [...manifest.behavior.hosts],
			effects: [...manifest.behavior.effects],
			files: found.files.length,
			bytes: found.files.reduce((sum, file) => sum + file.bytes.length, 0),
		};
	} catch (error) {
		return { version: identity.version, sha256, error: errorMessage(error) };
	}
}

function library(storeRoot?: string) {
	const { store, records, problems } = listIdentities({ storeRoot });
	const byName = new Map<string, LibraryVersion[]>();
	for (const { identity, sha256 } of records) {
		const versions = byName.get(identity.name) ?? [];
		versions.push(describe(storeRoot, identity, sha256));
		byName.set(identity.name, versions);
	}
	const packages: LibraryPackage[] = [...byName.keys()]
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map((name) => ({
			name,
			versions: (byName.get(name) ?? []).sort((a, b) =>
				newestFirst(a.version, b.version),
			),
		}));
	return { store, packages, problems };
}

/** The newest version that verified, for list and search summaries. */
const latest = (item: LibraryPackage) =>
	item.versions.find((version) => !("error" in version)) as
		| Exclude<LibraryVersion, { error: string }>
		| undefined;

function summary(item: LibraryPackage) {
	const newest = latest(item);
	return {
		name: item.name,
		versions: item.versions.map((version) => version.version),
		latest: newest?.version ?? null,
		type: newest?.type ?? null,
		description: newest?.description ?? null,
		unverified: item.versions
			.filter((version) => "error" in version)
			.map((version) => version.version),
	};
}

function listLibraryOperation({
	storeRoot,
	type,
}: {
	storeRoot?: string;
	type?: "skill" | "instruction";
} = {}) {
	if (type !== undefined && type !== "skill" && type !== "instruction")
		throw new Error("type: expected skill or instruction");
	const { store, packages, problems } = library(storeRoot);
	return {
		store,
		packages: packages
			.map(summary)
			.filter((item) => type === undefined || item.type === type),
		problems,
	};
}

function searchLibraryOperation({
	storeRoot,
	text,
}: {
	storeRoot?: string;
	text: string;
}) {
	if (typeof text !== "string" || !text.trim())
		throw new Error("search: expected nonempty text");
	const needle = text.trim().toLowerCase();
	const { store, packages, problems } = library(storeRoot);
	const matches = packages.filter(
		(item) =>
			item.name.toLowerCase().includes(needle) ||
			item.versions.some(
				(version) =>
					!("error" in version) &&
					version.description?.toLowerCase().includes(needle),
			),
	);
	return { store, text: text.trim(), packages: matches.map(summary), problems };
}

/** Which versions of a package one project pins, per binding, and whether its lock covers them. */
function projectPins(
	root: string,
	storeRoot: string | undefined,
	name: string,
) {
	const validated = validateConfiguration({ root });
	const pins = new Map<string, string[]>();
	for (const [binding, value] of validated.bindings)
		for (const { reference, entry } of packageReferences(binding, value))
			if (reference.get("package") === name) {
				const version = reference.get("version");
				pins.set(version, [...(pins.get(version) ?? []), entry]);
			}
	const lock = validated.bindings.size
		? readLockState(validated.repository, validated, storeRoot)
		: { state: "not-required" as const };
	return {
		root: validated.repository,
		lockState: lock.state,
		pins: [...pins].map(([version, bindings]) => ({
			version,
			bindings: bindings.sort(),
			locked:
				"locked" in lock && lock.locked
					? (lock.locked.get(`${name}@${version}`)?.sha256 ?? null)
					: null,
		})),
	};
}

// Pins of the requested version only (all when none), each marked with whether the library holds it.
function pinsFor(
	project: ReturnType<typeof projectPins>,
	item: LibraryPackage,
	version: string | undefined,
) {
	return {
		...project,
		pins: project.pins
			.filter((pin) => version === undefined || pin.version === version)
			.map((pin) => ({
				...pin,
				inLibrary: item.versions.some(
					(candidate) => candidate.version === pin.version,
				),
			})),
	};
}

function libraryInfoOperation({
	storeRoot,
	name,
	version,
	root,
}: {
	storeRoot?: string;
	name: string;
	version?: string;
	root?: string;
}) {
	const { store, packages, problems } = library(storeRoot);
	const item = packages.find((candidate) => candidate.name === name);
	if (!item) throw new Error(`${name}: not in the library at ${store}`);
	const versions =
		version === undefined
			? item.versions
			: item.versions.filter((candidate) => candidate.version === version);
	if (!versions.length)
		throw new Error(
			`${name}@${version}: not in the library; versions: ${item.versions.map((v) => v.version).join(", ")}`,
		);
	return {
		store,
		name,
		versions,
		...(root === undefined
			? {}
			: {
					project: pinsFor(projectPins(root, storeRoot, name), item, version),
				}),
		problems,
	};
}

/**
 * Publish a package directory: the same validation and import as
 * `add <name>@<version> --source <directory>`, reading the identity from its manifest.
 */
function publishPackageOperation({
	storeRoot,
	sourceDirectory,
}: {
	storeRoot?: string;
	sourceDirectory: string;
}) {
	let inspected: ReturnType<typeof readPackage>;
	try {
		inspected = readPackage({ root: sourceDirectory });
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(
			message.includes(MANIFEST)
				? `${message} (a package needs a ${MANIFEST} manifest; see ${DOCS})`
				: message,
		);
	}
	return importPackage({
		sourceDirectory,
		storeRoot,
		expectedDigest: inspected.sha256,
	});
}

export const listLibrary = inStoreSession(listLibraryOperation);
export const searchLibrary = inStoreSession(searchLibraryOperation);
export const libraryInfo = inStoreSession(libraryInfoOperation);
export const publishPackage = inStoreSession(publishPackageOperation);

/** Text rendering for the CLI. */
export function formatLibrary(
	result:
		| ReturnType<typeof listLibraryOperation>
		| ReturnType<typeof searchLibraryOperation>,
): string {
	const lines = result.packages.length
		? result.packages.map((item) =>
				[
					`${item.name}  ${item.versions.join(", ")}${item.type ? `  (${item.type})` : ""}`,
					...(item.description ? [`  ${item.description}`] : []),
					...(item.unverified.length
						? [
								`  Not verified: ${item.unverified.join(", ")}; run library info for details`,
							]
						: []),
				].join("\n"),
			)
		: [
				"text" in result
					? `No packages match "${result.text}".`
					: "The library is empty.",
			];
	return [
		`Library: ${result.store}`,
		...lines,
		...result.problems.map((problem) => `Store problem: ${problem}`),
	].join("\n");
}

export function formatLibraryInfo(
	result: ReturnType<typeof libraryInfoOperation>,
): string {
	const pinned = new Map(
		(result.project?.pins ?? []).map((pin) => [pin.version, pin]),
	);
	const lines = [`${result.name}  (library: ${result.store})`];
	for (const version of result.versions) {
		lines.push("", `${version.version}  sha256 ${version.sha256}`);
		if ("error" in version) lines.push(`  Not verified: ${version.error}`);
		else {
			lines.push(
				`  ${version.type}, ${version.delivery} delivery; entrypoint ${version.entrypoint}`,
				...(version.description ? [`  ${version.description}`] : []),
				`  Hosts: ${version.hosts.join(", ") || "any"}; effects: ${version.effects.join(", ") || "none"}; license: ${version.license ?? "not stated"}`,
				`  ${version.files} files, ${version.bytes} bytes`,
			);
		}
		const pin = pinned.get(version.version);
		if (pin)
			lines.push(
				`  Pinned by ${result.project?.root}: ${pin.bindings.join(", ")}; ${pin.locked === version.sha256 ? "locked" : pin.locked ? `locked to a different digest ${pin.locked}` : `not locked (lock ${result.project?.lockState})`}`,
			);
	}
	if (result.project) {
		for (const pin of result.project.pins)
			if (!pin.inLibrary)
				lines.push(
					"",
					`${pin.version}  pinned by ${result.project.root} (${pin.bindings.join(", ")}) but not in this library`,
				);
		if (!result.project.pins.length)
			lines.push("", `Not pinned by ${result.project.root}.`);
	}
	for (const problem of result.problems)
		lines.push(`Store problem: ${problem}`);
	return lines.join("\n");
}
