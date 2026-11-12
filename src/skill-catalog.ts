// Skill library catalog and comparison (#119, first milestone): read-only views over
// the verified package library, project-local skills, and the project's role
// bindings. Nothing here writes configuration, pins, locks, or skill files.
import { createHash } from "node:crypto";
import path from "node:path";
import { type FileDiff, packageDiff, text } from "./content-diff.ts";
import { readLocal } from "./files.ts";
import {
	type EvidenceRow,
	libraryEvidence,
	libraryInfo,
	listLibrary,
} from "./library.ts";
import { versionFiles } from "./outdated.ts";
import { inStoreSession } from "./package-store.ts";
import type { PackageFile } from "./packages.ts";
import { validateConfiguration } from "./resolve.ts";
import { type DiscoveredSkill, discoverSkills } from "./skills.ts";

type Validated = ReturnType<typeof validateConfiguration>;
type RoleUse = { role: string; list: "required" | "available" };

/** Which roles list a skill ID, and whether as required or available-but-unloaded. */
function roleUsage(validated: Validated, id: string): RoleUse[] {
	return [...validated.roleSkills].flatMap(
		([role, { required, available }]): RoleUse[] =>
			required.some((skill) => skill.id === id)
				? [{ role, list: "required" }]
				: available.some((skill) => skill.id === id)
					? [{ role, list: "available" }]
					: [],
	);
}

// A pin entry ends in its binding (`skills.x` or `assignments.r.bindings.skills.x`).
const boundSkill = (entry: string) =>
	/(?:^|\.)skills\.([^.]+)$/.exec(entry)?.[1];

/** A package version's pin entries and the roles that list the skills they bind. */
function packageUsage(validated: Validated, bindings: string[]) {
	const skills = new Set(
		bindings.map(boundSkill).filter((id): id is string => !!id),
	);
	return {
		bindings,
		roles: [...skills].flatMap((skill) =>
			roleUsage(validated, skill).map((use) => ({ skill, ...use })),
		),
	};
}

// Only discovered repository skills with a file are local catalog entries; package
// declarations and host user references have no repository content to read.
const localSkills = (skills: DiscoveredSkill[]) =>
	skills.filter((skill) => !skill.package && typeof skill.path === "string");

function catalogOperation({
	root,
	storeRoot,
}: {
	root: string;
	storeRoot?: string;
}) {
	const validated = validateConfiguration({ root });
	const listed = listLibrary({ storeRoot, type: "skill" });
	const problems = [...listed.problems];
	const packages = listed.packages.map((summary) => {
		const info = libraryInfo({ storeRoot, name: summary.name, root });
		problems.push(...info.problems);
		return {
			name: summary.name,
			versions: info.versions.map((version) => {
				const bindings =
					info.project?.pins.find((pin) => pin.version === version.version)
						?.bindings ?? [];
				return {
					...version,
					usage: packageUsage(validated, bindings),
					evidence: info.evidence.filter(
						(row) => row.version === version.version,
					).length,
				};
			}),
		};
	});
	const found = discoverSkills(validated.repository, validated.config);
	return {
		packages,
		local: localSkills(found.skills).map((skill) => ({
			id: skill.id,
			path: skill.path as string,
			source: skill.source ?? null,
			host: skill.host ?? null,
			name: skill.name ?? null,
			description: skill.description ?? null,
			version: null,
			usage: { roles: roleUsage(validated, skill.id) },
		})),
		problems: [...problems, ...found.warnings],
	};
}

export type SkillSelector =
	| { kind: "package"; name: string; version: string }
	| { kind: "local"; path: string };

/** `package:<name>@<version>` or `local:<repository path to SKILL.md>`. */
export function parseSkillSelector(value: string): SkillSelector {
	if (value.startsWith("package:")) {
		const spec = value.slice("package:".length);
		const at = spec.lastIndexOf("@");
		if (at > 0 && at < spec.length - 1)
			return {
				kind: "package",
				name: spec.slice(0, at),
				version: spec.slice(at + 1),
			};
	} else if (value.startsWith("local:") && value.length > "local:".length)
		return { kind: "local", path: value.slice("local:".length) };
	throw new Error(
		`${value}: expected package:<name>@<version> or local:<path to SKILL.md>`,
	);
}

const describeFile = (file: PackageFile) => ({
	path: file.path,
	bytes: file.bytes.length,
	sha256: createHash("sha256").update(file.bytes).digest("hex"),
	binary: text(file.bytes) === null,
});

function packageSide(
	validated: Validated,
	storeRoot: string | undefined,
	root: string,
	{ name, version }: { name: string; version: string },
) {
	// libraryInfo verifies the version exists and reports a readable error otherwise.
	const info = libraryInfo({ storeRoot, name, version, root });
	const entry = info.versions[0];
	if ("error" in entry)
		throw new Error(`${name}@${version}: unverified: ${entry.error}`);
	const files = versionFiles(storeRoot, name, version, entry.revisionDigest);
	const rows: EvidenceRow[] = libraryEvidence({
		storeRoot,
		name,
		version,
		root,
	}).rows;
	return {
		files,
		side: {
			kind: "package" as const,
			name,
			version,
			sha256: entry.sha256,
			revisionDigest: entry.revisionDigest,
			source: entry.source,
			metadata: {
				description: entry.description,
				license: entry.license,
				entrypoint: entry.entrypoint,
				delivery: entry.delivery,
				hosts: entry.hosts,
				effects: entry.effects,
			},
			usage: packageUsage(validated, info.project?.pins[0]?.bindings ?? []),
			// Absent rows mean untested here, never compatible or recommended.
			evidence: { status: rows.length ? "recorded" : "untested", rows },
			problems: info.problems,
		},
	};
}

function localSide(validated: Validated, file: string) {
	// Only a discovered skill is readable: a selector cannot name arbitrary repository files.
	const found = discoverSkills(validated.repository, validated.config);
	const skill = localSkills(found.skills).find((item) => item.path === file);
	if (!skill) throw new Error(`${file}: not a discovered project-local skill`);
	const directory = path.posix.dirname(file);
	const files = [file, ...(skill.resources ?? [])].map((member) => {
		const bytes = readLocal(validated.repository, member);
		if (bytes === null) throw new Error(`${member}: missing`);
		return { path: path.posix.relative(directory, member), bytes };
	});
	return {
		files,
		side: {
			kind: "local" as const,
			name: skill.id,
			version: null,
			sha256: null,
			revisionDigest: null,
			source: skill.source ?? null,
			path: file,
			metadata: {
				name: skill.name ?? null,
				description: skill.description ?? null,
				host: skill.host ?? null,
			},
			usage: { roles: roleUsage(validated, skill.id) },
			evidence: { status: "untested", rows: [] as EvidenceRow[] },
			problems: found.warnings,
		},
	};
}

const label = (selector: SkillSelector) =>
	selector.kind === "package"
		? `${selector.name}@${selector.version}`
		: `local/${selector.path}`;

function compareOperation({
	root,
	storeRoot,
	left,
	right,
}: {
	root: string;
	storeRoot?: string;
	left: SkillSelector;
	right: SkillSelector;
}) {
	const validated = validateConfiguration({ root });
	const load = (selector: SkillSelector) =>
		selector.kind === "package"
			? packageSide(validated, storeRoot, root, selector)
			: localSide(validated, selector.path);
	const a = load(left);
	const b = load(right);
	const files: FileDiff[] = packageDiff(a.files, b.files, {
		fromLabel: label(left),
		toLabel: label(right),
	});
	return {
		left: { ...a.side, files: a.files.map(describeFile) },
		right: { ...b.side, files: b.files.map(describeFile) },
		identical: files.length === 0,
		files,
	};
}

export const skillCatalog = inStoreSession(catalogOperation);
export const compareSkills = inStoreSession(compareOperation);
