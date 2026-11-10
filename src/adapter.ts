// #85: an ignored local reference composes one external adapter over the committed
// configuration. The adapter adds; it never overrides project policy or trust.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { errorCode, errorMessage } from "./files.ts";
import { localFile, mapping, parseYaml, type YamlMap } from "./resolve.ts";

export const LOCAL_REFERENCE = ".agent-profiles/agents.local.yaml";
const REMEDY = `fix the reference, or delete ${LOCAL_REFERENCE} to use the committed configuration`;
// Project policy: routing, defaults and profiles stay with the project.
const PROJECT_ONLY = [
	"default_profile",
	"default_role",
	"models",
	"families",
	"profiles",
	"workflow_links",
];

export type Adapter = {
	/** The reference exactly as written in the local file. */
	reference: string;
	/** Canonical adapter directory; its `.agent-profiles/` mirrors a project's. */
	root: string;
	base: string;
};

/** Where each composed declaration came from; absent entries are the project's. */
export type Sources = Record<string, "adapter">;

const fail = (entry: string, message: string): never => {
	throw new Error(`${entry}: ${message}`);
};
const inside = (parent: string, child: string) => {
	const relative = path.relative(parent, child);
	return (
		!relative ||
		(!path.isAbsolute(relative) &&
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`))
	);
};

/** The configured adapter, null without a local reference; an invalid one throws. */
export function readAdapter(repository: string): Adapter | null {
	let text: string;
	try {
		text = readFileSync(path.join(repository, LOCAL_REFERENCE), "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return null;
		return fail(LOCAL_REFERENCE, `${errorMessage(error)}; ${REMEDY}`);
	}
	let value: unknown;
	try {
		value = mapping(parseYaml(text), LOCAL_REFERENCE, ["adapter"]);
	} catch (error) {
		return fail(LOCAL_REFERENCE, `${errorMessage(error)}; ${REMEDY}`);
	}
	const reference = (value as YamlMap).get("adapter");
	const entry = `${LOCAL_REFERENCE}.adapter`;
	if (typeof reference !== "string" || !reference.trim())
		fail(entry, `expected a directory path; ${REMEDY}`);
	let root = "";
	try {
		root = realpathSync(path.resolve(repository, reference));
	} catch (error) {
		fail(
			entry,
			`${reference} is not accessible (${errorCode(error)}); ${REMEDY}`,
		);
	}
	if (!statSync(root).isDirectory())
		fail(entry, `${reference} is not a directory; ${REMEDY}`);
	if (inside(repository, root) || inside(root, repository))
		fail(
			entry,
			`${reference} must be a separate directory, neither inside nor containing the project`,
		);
	const base = path.join(root, ".agent-profiles");
	if (!existsSync(path.join(base, "agents.yaml")))
		fail(entry, `${reference} has no .agent-profiles/agents.yaml; ${REMEDY}`);
	for (const file of ["agents.local.yaml", "trust.yaml"])
		if (existsSync(path.join(base, file)))
			fail(
				entry,
				`${reference} contains .agent-profiles/${file}; an adapter cannot chain to another adapter or change trust policy`,
			);
	return { reference, root, base: realpathSync(base) };
}

/**
 * Compose the adapter over the parsed project configuration, in place.
 * Precedence is ownership: every binding and assignment belongs to exactly one
 * layer, so cross-layer selector ties cannot arise. The adapter may add skills
 * (package bindings only), roles and assignments over its own bindings, and append
 * skills to a project role. It may not redeclare or override a project entry.
 * Adapter role files are served from the adapter through `preview` at their
 * project path, and may not shadow a project file.
 */
export function composeConfiguration(
	project: YamlMap,
	adapter: Adapter,
	projectBase: string,
	preview: Map<string, Buffer>,
	/** #97: an edited overlay to compose instead of the adapter's agents.yaml. */
	edited?: YamlMap,
): Sources {
	const label = `${adapter.reference}/.agent-profiles/agents.yaml`;
	const refuse = (entry: string, message: string): never =>
		fail(`${label}: ${entry}`, message);
	let overlay: YamlMap;
	try {
		overlay =
			edited ??
			parseYaml(readFileSync(path.join(adapter.base, "agents.yaml"), "utf8"));
	} catch (error) {
		return fail(label, `${errorMessage(error)}; ${REMEDY}`);
	}
	if (!(overlay instanceof Map)) refuse("agents.yaml", "expected a mapping");
	for (const key of PROJECT_ONLY)
		if (overlay.has(key))
			refuse(
				key,
				"project policy; an adapter may add skills, roles and assignments only",
			);
	mapping(overlay, label, ["version"], ["roles", "skills", "assignments"]);
	const version = overlay.get("version");
	const projectVersion = project.get("version");
	if (version !== 2 && version !== 3) refuse("version", "expected 2 or 3");
	// v1 to v2 is a scalar-only change (docs/migrations/config-v1-to-v2.md).
	if (projectVersion !== version && !(projectVersion === 1 && version === 2))
		refuse(
			"version",
			`version ${version} cannot compose with project version ${projectVersion}`,
		);
	project.set("version", version);

	const sources: Sources = {};
	const owned = new Set<string>();
	const section = (key: string) => {
		if (!project.has(key)) project.set(key, new Map());
		return mapping(project.get(key), key);
	};
	const added = (key: string) =>
		overlay.has(key)
			? mapping(overlay.get(key), `${label}: ${key}`)
			: new Map();

	const skills = added("skills");
	if (skills.size) {
		const target = section("skills");
		for (const [id, value] of skills) {
			if (target.has(id))
				refuse(
					`skills.${id}`,
					"declared by the project; an adapter may not redeclare or override it",
				);
			if (!(value instanceof Map) || !value.has("package"))
				refuse(
					`skills.${id}`,
					"an adapter skill must bind a package ({package, version})",
				);
			target.set(id, value);
			owned.add(`skills.${id}`);
			sources[`skills.${id}`] = "adapter";
		}
	}

	const roles = mapping(project.get("roles"), "roles");
	for (const [id, value] of added("roles")) {
		const entry = `roles.${id}`;
		if (roles.has(id)) {
			// A project role keeps its instructions; the adapter may only add skills.
			mapping(value, `${label}: ${entry}`, ["skills"]);
			const extra = mapping(
				value.get("skills"),
				`${label}: ${entry}.skills`,
				[],
				["required", "available"],
			);
			const role = roles.get(id);
			if (!(role instanceof Map))
				refuse(entry, "project role is not a mapping");
			if (!role.has("skills")) role.set("skills", new Map());
			const lists = mapping(role.get("skills"), `${entry}.skills`);
			for (const [list, items] of extra) {
				if (!Array.isArray(items))
					refuse(`${entry}.skills.${list}`, "expected a list");
				lists.set(list, [...(lists.get(list) ?? []), ...items]);
				for (const item of items)
					sources[`${entry}.skills.${list}.${item}`] = "adapter";
			}
			continue;
		}
		if (!(value instanceof Map)) refuse(entry, "expected a mapping");
		if (value.has("resources"))
			refuse(`${entry}.resources`, "not supported for adapter roles");
		roles.set(id, value);
		sources[entry] = "adapter";
		if (value.has("package")) {
			owned.add(entry);
			continue;
		}
		const file = value.get("file");
		const resolved = localFile(adapter.base, file, `${label}: ${entry}.file`);
		const target = path.resolve(projectBase, file as string);
		if (existsSync(target))
			refuse(
				`${entry}.file`,
				`.agent-profiles/${file} exists in the project; an adapter may not shadow project files`,
			);
		preview.set(target, readFileSync(resolved));
	}

	const rules = added("assignments");
	if (rules.size) {
		const target = section("assignments");
		const key = version === 3 ? "bindings" : "versions";
		for (const [id, value] of rules) {
			const entry = `assignments.${id}`;
			if (target.has(id))
				refuse(
					entry,
					"declared by the project; an adapter may not redeclare or override it",
				);
			const selected = value instanceof Map ? value.get(key) : undefined;
			for (const binding of selected instanceof Map ? selected.keys() : [])
				if (!owned.has(binding))
					refuse(
						`${entry}.${key}.${binding}`,
						"an adapter assignment may select only bindings the adapter declares; project bindings keep the project's assignments",
					);
			target.set(id, value);
			sources[entry] = "adapter";
		}
	}
	return sources;
}

/** Refuse a command that does not yet understand adapters, rather than act on one layer. */
export function refuseWithAdapter(repository: string, command: string) {
	const adapter = readAdapter(repository);
	if (adapter)
		fail(
			command,
			`not supported while ${LOCAL_REFERENCE} references an adapter (${adapter.reference}); move ${LOCAL_REFERENCE} aside to run it on the committed configuration`,
		);
}
