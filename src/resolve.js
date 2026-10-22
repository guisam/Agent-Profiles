import {
	closeSync,
	existsSync,
	lstatSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { safePath } from "./files.js";
import { contextDiagnostics, measureFile, measureText } from "./diagnostics.js";
import { integrations, managedSurface } from "./integrations.js";
import { readLockState } from "./package-lock.js";
import {
	lookupPackage,
	safePath as guardedPath,
	verifyObject,
} from "./package-store.js";
import { parseManifest, validateMembers } from "./packages.js";
import {
	readRevisionRecord,
	releasedPackage,
	revisionClosure,
} from "./revisions.js";

function fail(entry, message) {
	throw new Error(`${entry}: ${message}`);
}

export function mapping(value, entry, fields, optional = []) {
	if (!(value instanceof Map)) fail(entry, "expected a mapping");
	for (const key of value.keys()) {
		if (typeof key !== "string" || !key.trim())
			fail(entry, "keys must be nonempty strings");
		if (fields && !fields.includes(key) && !optional.includes(key))
			fail(`${entry}.${key}`, "unknown field");
	}
	for (const key of fields ?? []) {
		if (!value.has(key)) fail(`${entry}.${key}`, "required field is missing");
	}
	return value;
}

export function identifier(value, entry) {
	if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
		fail(
			entry,
			"expected an ID containing lowercase letters, digits, and hyphens",
		);
	}
	return value;
}

export function localFile(
	base,
	file,
	entry,
	scope = ".agent-profiles",
	allowMissing = false,
	preview = new Map(),
) {
	if (
		typeof file !== "string" ||
		!file.endsWith(".md") ||
		/[:\\]/.test(file) ||
		path.posix.isAbsolute(file) ||
		file.split("/").includes("..")
	) {
		fail(
			entry,
			`expected a relative Markdown path inside ${scope} (no .., URLs, or backslashes)`,
		);
	}
	if (preview.has(path.resolve(base, file))) return safePath(base, file);
	try {
		const resolved = realpathSync(path.resolve(base, file));
		const relative = path.relative(base, resolved);
		if (
			path.isAbsolute(relative) ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`)
		) {
			fail(entry, `${file} resolves outside ${scope}`);
		}
		if (!statSync(resolved).isFile()) fail(entry, `${file} is not a file`);
		return resolved;
	} catch (error) {
		if (allowMissing && error.code === "ENOENT") return safePath(base, file);
		if (error.code)
			fail(
				entry,
				`cannot access ${file} (${error.code}); restore the file or correct this reference in .agent-profiles/agents.yaml, then run agent-profiles doctor`,
			);
		throw error;
	}
}

function profileFile(base, id, entry, preview) {
	identifier(id, entry);
	const file = `profiles/${id}.md`;
	localFile(base, file, entry, ".agent-profiles", false, preview);
	return file;
}

export function parseYamlDocument(text) {
	const document = parseDocument(text);
	if (document.errors.length || document.warnings.length) {
		throw new Error(
			[...document.errors, ...document.warnings]
				.map((error) => error.message)
				.join("\n"),
		);
	}
	return document;
}

export function parseYaml(text) {
	return parseYamlDocument(text).toJS({ mapAsMap: true, maxAliasCount: 100 });
}

export function skillMetadata(
	file,
	entry,
	content,
	display = file,
	requireDescription = true,
) {
	let descriptor;
	try {
		if (content === undefined) descriptor = openSync(file, "r");
		const chunks = [];
		// ponytail: frontmatter is capped at 64 KiB; raise the limit if a local format needs more.
		for (let size = 0; size < 65536; ) {
			const buffer = Buffer.alloc(1024);
			const count =
				content === undefined
					? readSync(descriptor, buffer, 0, buffer.length, null)
					: content.copy(
							buffer,
							0,
							size,
							Math.min(size + buffer.length, content.length),
						);
			chunks.push(buffer.subarray(0, count));
			size += count;
			const text = Buffer.concat(chunks)
				.toString("utf8")
				.replace(/^\uFEFF/, "");
			const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
			if (match && (!count || match[0].endsWith("\n"))) {
				const metadata = mapping(parseYaml(match[1]), "frontmatter");
				const text = (key) => {
					if (!metadata.has(key) && (key === "name" || !requireDescription))
						return null;
					if (
						typeof metadata.get(key) !== "string" ||
						!metadata.get(key).trim()
					)
						fail(`frontmatter.${key}`, "expected a nonempty string");
					return metadata.get(key).trim();
				};
				const name = text("name");
				return name === null
					? {
							name: path.basename(path.dirname(display)),
							nameSource: "directory",
							description: text("description"),
						}
					: {
							name,
							nameSource: "frontmatter",
							description: text("description"),
						};
			}
			if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) break;
			if (!count) break;
		}
		throw new Error("expected YAML frontmatter delimited by --- within 64 KiB");
	} catch (error) {
		fail(entry, `${display}: ${error.message}`);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function strings(value, entry) {
	if (
		!Array.isArray(value) ||
		value.some((item) => typeof item !== "string" || !item.trim())
	)
		fail(entry, "expected a list of nonempty strings");
	if (new Set(value).size !== value.length) fail(entry, "duplicate entries");
	return value;
}

function skillFiles(ids, entry, resolveSkill) {
	if (!Array.isArray(ids)) fail(entry, "expected a list of skill IDs");
	const seen = new Set();
	return ids.map((id, index) => {
		const location = `${entry}[${index}]`;
		identifier(id, location);
		if (seen.has(id)) fail(location, `duplicate skill ${id}`);
		seen.add(id);
		return resolveSkill(id, location);
	});
}

// Resource checks inspect named members only; binary bodies belong to stamp capture.
export function localDeclaration(
	root,
	source,
	binding,
	instruction,
	fields = ["file"],
	optional = [],
) {
	mapping(source, binding, fields, [...optional, "resources"]);
	if (!source.has("resources")) return {};
	const resources = source.get("resources"),
		entry = `${binding}.resources`;
	if (!Array.isArray(resources)) fail(entry, "expected a list of strings");
	if (resources.some((file) => typeof file !== "string"))
		fail(entry, "expected resource path strings");
	try {
		validateMembers(
			resources.map((file) => ({ path: file, type: "file", nlink: 1 })),
		);
		if (resources.includes(instruction))
			fail(entry, "resource duplicates owning instruction entrypoint");
		if (resources.length)
			validateMembers(
				[instruction, ...resources].map((file) => ({
					path: file,
					type: "file",
					nlink: 1,
				})),
			);
		for (const file of resources) {
			try {
				const stat = lstatSync(guardedPath(root, file), { bigint: true });
				if (!stat.isFile() || stat.nlink !== 1n)
					throw new Error("expected a regular unlinked file");
			} catch (error) {
				throw new Error(`${file}: ${error.message}`);
			}
		}
	} catch (error) {
		fail(entry, error.message);
	}
	return resources.length
		? {
				resources: [...resources].sort((a, b) =>
					Buffer.compare(Buffer.from(a), Buffer.from(b)),
				),
			}
		: {};
}

export function validateConfiguration({
	root = process.cwd(),
	configuration = undefined,
	newRoleFile = undefined,
	preview = new Map(),
} = {}) {
	let repository, base, config;
	try {
		repository = realpathSync(root);
		base = realpathSync(path.join(repository, ".agent-profiles"));
		config =
			configuration === undefined
				? parseYaml(readFileSync(path.join(base, "agents.yaml"), "utf8"))
				: configuration;
	} catch (error) {
		fail(
			".agent-profiles/agents.yaml",
			`${error.message}; run agent-profiles init for a new installation, or repair the existing configuration and run agent-profiles doctor`,
		);
	}
	if (newRoleFile !== undefined) {
		if (typeof newRoleFile?.content !== "string")
			fail("newRoleFile", "expected path and text content");
		localFile(
			base,
			newRoleFile.path,
			"newRoleFile.path",
			".agent-profiles",
			true,
		);
	}

	mapping(config, "agents.yaml");
	if (!config.has("version")) fail("version", "required field is missing");
	if (![1, 2, 3].includes(config.get("version")))
		fail("version", "only versions 1, 2 and 3 are supported");
	if (config.get("version") === 1) {
		if (config.has("profiles"))
			fail(
				"profiles",
				"unknown field in version 1; requires version 2; upgrade/migrate agents.yaml to v2",
			);
		for (const section of ["roles", "skills"])
			for (const [id, source] of config.get(section) instanceof Map
				? config.get(section)
				: []) {
				if (source instanceof Map && source.has("resources"))
					fail(
						`${section}.${id}.resources`,
						"unknown field in version 1; requires version 2; upgrade/migrate agents.yaml to v2",
					);
			}
	}
	if (config.get("version") === 2 && config.has("workflow_links"))
		fail(
			"workflow_links",
			"requires version 3; see docs/migrations/config-v2-to-v3.md",
		);
	mapping(
		config,
		"agents.yaml",
		[
			"version",
			"default_profile",
			"default_role",
			"models",
			"families",
			"roles",
		],
		config.get("version") === 3
			? ["skills", "profiles", "assignments", "workflow_links"]
			: config.get("version") === 2
				? ["skills", "profiles", "assignments"]
				: ["skills"],
	);
	const profiles = mapping(
		config.has("profiles") ? config.get("profiles") : new Map(),
		"profiles",
	);
	const bindings = new Map();
	const local = new Map();
	const exists = (file) =>
		existsSync(path.join(repository, file)) ||
		preview.has(path.join(repository, file));
	function bindPackage(binding, source, type, conventional) {
		if (exists(conventional))
			fail(binding, `ambiguous package binding: ${conventional} also exists`);
		bindings.set(binding, { source, type, rules: [], pins: new Map() });
	}
	for (const [id, source] of profiles) {
		identifier(id, `profiles.${id}`);
		const binding = `profiles.${id}`;
		if (source instanceof Map && source.has("file")) {
			local.set(
				binding,
				localDeclaration(
					repository,
					source,
					binding,
					`.agent-profiles/${source.get("file")}`,
				),
			);
			localFile(
				base,
				source.get("file"),
				`${binding}.file`,
				".agent-profiles",
				false,
				preview,
			);
		} else {
			mapping(
				source,
				binding,
				["package", "version"],
				config.get("version") === 3 ? ["revision"] : [],
			);
			bindPackage(
				binding,
				source,
				"instruction",
				`.agent-profiles/profiles/${id}.md`,
			);
		}
	}
	const referencedProfiles = new Set();
	function validateProfile(id, entry) {
		identifier(id, entry);
		referencedProfiles.add(id);
		if (!profiles.has(id)) profileFile(base, id, entry, preview);
	}
	const defaultProfile = config.get("default_profile");
	validateProfile(defaultProfile, "default_profile");
	const defaultRole = identifier(config.get("default_role"), "default_role");
	const models = mapping(config.get("models"), "models");
	const aliases = new Map();
	for (const [identity, value] of models) {
		const entry = `models.${identity}`;
		mapping(value, entry, ["profile"], ["aliases"]);
		validateProfile(value.get("profile"), `${entry}.profile`);
		for (const alias of value.has("aliases")
			? strings(value.get("aliases"), `${entry}.aliases`)
			: []) {
			if (alias === identity) continue; // Redundant but harmless.
			if (models.has(alias))
				fail(
					`${entry}.aliases`,
					`alias ${alias} shadows the configured model ${alias}`,
				);
			if (aliases.has(alias))
				fail(
					`${entry}.aliases`,
					`alias ${alias} is also an alias of models.${aliases.get(alias)}`,
				);
			aliases.set(alias, identity);
		}
	}
	const families = mapping(config.get("families"), "families");
	const prefixes = new Map();
	for (const [name, value] of families) {
		const entry = `families.${name}`;
		mapping(value, entry, ["profile"], ["match"]);
		validateProfile(value.get("profile"), `${entry}.profile`);
		if (!value.has("match")) continue;
		const match = mapping(value.get("match"), `${entry}.match`, ["prefixes"]);
		for (const prefix of strings(
			match.get("prefixes"),
			`${entry}.match.prefixes`,
		)) {
			// Distinct prefixes of one identity differ in length, so only an identical prefix can tie.
			if (prefixes.has(prefix))
				fail(
					`${entry}.match.prefixes`,
					`prefix ${prefix} is also used by families.${prefixes.get(prefix)}; equally specific rules are ambiguous`,
				);
			prefixes.set(prefix, name);
		}
	}

	const roles = mapping(config.get("roles"), "roles");
	if (!roles.has(defaultRole))
		fail("default_role", `role ${defaultRole} is not declared in roles`);
	const sources = mapping(
		config.has("skills") ? config.get("skills") : new Map(),
		"skills",
	);
	const hosts = integrations.filter((adapter) => adapter.skills);
	const hostOf = (source) =>
		hosts.find((adapter) => adapter.id === source.get("host"));
	for (const [id, source] of sources) {
		identifier(id, `skills.${id}`);
		if (
			config.get("version") >= 2 &&
			source instanceof Map &&
			source.has("package")
		) {
			mapping(
				source,
				`skills.${id}`,
				["package", "version"],
				config.get("version") === 3 ? ["revision"] : [],
			);
			bindPackage(
				`skills.${id}`,
				source,
				"skill",
				`.agent-profiles/skills/${id}/SKILL.md`,
			);
			continue;
		}
		if (!(source instanceof Map && source.has("host"))) {
			if (config.get("version") >= 2)
				local.set(
					`skills.${id}`,
					localDeclaration(
						repository,
						source,
						`skills.${id}`,
						source instanceof Map ? source.get("file") : undefined,
					),
				);
			else mapping(source, `skills.${id}`, ["file"]);
			continue;
		}
		mapping(source, `skills.${id}`, ["host", "scope"], ["id"]);
		const adapter = hostOf(source);
		if (!adapter)
			fail(
				`skills.${id}.host`,
				`expected a host with native skills: ${hosts.map((item) => item.id).join(", ")}`,
			);
		const scope = adapter.skills[source.get("scope")];
		if (!Object.hasOwn(adapter.skills, source.get("scope")))
			fail(
				`skills.${id}.scope`,
				`expected one of ${Object.keys(adapter.skills).join(", ")}`,
			);
		const hostId = source.has("id") ? source.get("id") : id;
		if (typeof hostId !== "string" || !scope.id.test(hostId))
			fail(
				`skills.${id}.id`,
				`expected a ${adapter.name} ${source.get("scope")} skill identifier`,
			);
	}
	for (const [id, value] of roles) {
		const entry = `roles.${id}`;
		identifier(id, entry);
		const packaged =
			config.get("version") >= 2 &&
			value instanceof Map &&
			value.has("package");
		if (!packaged && config.get("version") >= 2)
			local.set(
				entry,
				localDeclaration(
					repository,
					value,
					entry,
					`.agent-profiles/${value instanceof Map ? value.get("file") : ""}`,
					["file", "skills"],
					["description"],
				),
			);
		else
			mapping(
				value,
				entry,
				packaged ? ["package", "version", "skills"] : ["file", "skills"],
				[
					"description",
					...(packaged && config.get("version") === 3 ? ["revision"] : []),
				],
			);
		if (packaged)
			bindPackage(
				entry,
				value,
				"instruction",
				`.agent-profiles/roles/${id}.md`,
			);
	}

	const assignments = mapping(
		config.has("assignments") ? config.get("assignments") : new Map(),
		"assignments",
	);
	for (const [id, value] of assignments) {
		const entry = `assignments.${id}`;
		identifier(id, entry);
		const overrides = config.get("version") === 3 ? "bindings" : "versions";
		mapping(value, entry, ["when", overrides]);
		const when = mapping(
			value.get("when"),
			`${entry}.when`,
			[],
			["model", "role", "profile", "host"],
		);
		const allowed = {
			model: models,
			role: roles,
			profile: referencedProfiles,
			host: new Set(integrations.map((item) => item.id)),
		};
		for (const [key, value] of when) {
			if (!allowed[key].has(value))
				fail(
					`${entry}.when.${key}`,
					"expected a declared canonical model, role, referenced profile, or known host",
				);
		}
		const versions = mapping(value.get(overrides), `${entry}.${overrides}`);
		if (!versions.size)
			fail(`${entry}.versions`, "expected at least one package binding");
		for (const [binding, version] of versions) {
			if (!bindings.has(binding))
				fail(
					`${entry}.versions.${binding}`,
					"expected a declared package binding",
				);
			if (config.get("version") === 3)
				mapping(
					version,
					`${entry}.bindings.${binding}`,
					["package", "version"],
					["revision"],
				);
			bindings
				.get(binding)
				.rules.push({
					id,
					when,
					version:
						config.get("version") === 3 ? version.get("version") : version,
					...(config.get("version") === 3 ? { source: version } : {}),
				});
		}
	}
	for (const [binding, { source, rules }] of bindings) {
		for (const [index, rule] of rules.entries()) {
			const duplicate = rules
				.slice(0, index)
				.find(
					(other) =>
						other.when.size === rule.when.size &&
						contains(other.when, rule.when),
				);
			if (duplicate)
				fail(
					binding,
					`ambiguous duplicate selectors in assignments ${duplicate.id}, ${rule.id}`,
				);
		}
		const pairs = [
			[null, defaultProfile],
			...[...models].map(([id, value]) => [id, value.get("profile")]),
			...[...families.values()].map((value) => [null, value.get("profile")]),
		];
		for (const [model, profile] of pairs) {
			for (const role of roles.keys()) {
				for (const host of [null, ...integrations.map((item) => item.id)])
					selectRule(binding, rules, { model, profile, role, host });
			}
		}
		for (const { reference, entry } of packageReferences(binding, {
			source,
			rules,
		})) {
			const name = reference.get("package"),
				version = reference.get("version");
			if (
				typeof name !== "string" ||
				!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(name)
			)
				fail(entry, "package: expected @namespace/name");
			if (
				typeof version !== "string" ||
				!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) ||
				version.split(".").some((n) => !Number.isSafeInteger(Number(n)))
			)
				fail(entry, "version: expected exact safe release version");
			if (
				reference.has("revision") &&
				(typeof reference.get("revision") !== "string" ||
					!/^[0-9a-f]{64}$/.test(reference.get("revision")))
			)
				fail(`${entry}.revision`, "expected revision digest");
		}
	}
	const catalog = new Map();
	function resolveSkill(id, entry) {
		if (catalog.has(id)) return catalog.get(id);
		const conventional = `.agent-profiles/skills/${id}/SKILL.md`;
		const source = sources.get(id);
		if (bindings.has(`skills.${id}`)) {
			const reference = { id, binding: `skills.${id}` };
			catalog.set(id, reference);
			return reference;
		}
		if (source?.has("host")) {
			if (exists(conventional))
				fail(
					entry,
					`ambiguous skill ${id}: ${conventional} exists and skills.${id} names a host skill`,
				);
			const adapter = hostOf(source);
			const hostId = source.get("id") ?? id;
			const scope = source.get("scope");
			// User and plugin skills live outside the repository: host-provided, never verified here.
			let skill = {
				id,
				type: "host",
				host: adapter.id,
				hostId,
				scope,
				delivery: "invoke",
				name: hostId,
				nameSource: "host",
				description: null,
				path: null,
				verification: "host-provided",
			};
			if (scope === "project") {
				// A declared project skill must exist, so a misspelled ID fails like any missing file.
				const file = adapter.skills.project.path(hostId);
				const resolved = localFile(
					repository,
					file,
					entry,
					"repository",
					false,
					preview,
				);
				skill = { ...skill, path: file, verification: "verified-local" };
				// The host owns this file's format; unreadable metadata is reported, not fatal to every role.
				try {
					skill = {
						...skill,
						...skillMetadata(
							resolved,
							entry,
							preview.get(resolved),
							file,
							false,
						),
					};
				} catch (error) {
					skill.metadataError = error.message.slice(
						error.message.indexOf(`${file}: `) + file.length + 2,
					);
				}
			}
			catalog.set(id, skill);
			return skill;
		}
		const file = source ? source.get("file") : conventional;
		const resolved = localFile(
			repository,
			file,
			entry,
			"repository",
			false,
			preview,
		);
		if (
			source &&
			exists(conventional) &&
			localFile(
				repository,
				conventional,
				entry,
				"repository",
				false,
				preview,
			) !== resolved
		) {
			fail(
				entry,
				`ambiguous skill ${id}: both ${conventional} and ${file} exist`,
			);
		}
		const skill = {
			id,
			type: "instruction",
			delivery: "inject",
			...skillMetadata(resolved, entry, preview.get(resolved), file),
			path: file,
			...local.get(`skills.${id}`),
		};
		catalog.set(id, skill);
		return skill;
	}
	const roleSkills = new Map();
	for (const [id, value] of roles) {
		const entry = `roles.${id}`;
		identifier(id, entry);
		if (
			value.has("description") &&
			typeof value.get("description") !== "string"
		)
			fail(`${entry}.description`, "expected a string");
		if (!bindings.has(entry))
			localFile(
				base,
				value.get("file"),
				`${entry}.file`,
				".agent-profiles",
				newRoleFile?.path === value.get("file"),
				preview,
			);
		const skills = mapping(value.get("skills"), `${entry}.skills`, [
			"required",
			"available",
		]);
		const required = skillFiles(
			skills.get("required"),
			`${entry}.skills.required`,
			resolveSkill,
		);
		const available = skillFiles(
			skills.get("available"),
			`${entry}.skills.available`,
			resolveSkill,
		);
		for (const skill of available) {
			if (required.some((item) => item.id === skill.id)) {
				fail(`${entry}.skills.available`, `${skill.id} is also required`);
			}
		}
		roleSkills.set(id, { required, available });
	}
	for (const id of sources.keys()) resolveSkill(id, `skills.${id}.file`);

	const workflowLinks = mapping(
		config.has("workflow_links") ? config.get("workflow_links") : new Map(),
		"workflow_links",
	);
	for (const [id, link] of workflowLinks) {
		identifier(id, `workflow_links.${id}`);
		mapping(link, `workflow_links.${id}`, [
			"protocol",
			"consumer",
			"providers",
		]);
		if (
			typeof link.get("protocol") !== "string" ||
			!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(link.get("protocol"))
		)
			fail(`workflow_links.${id}.protocol`, "expected namespaced protocol");
		if (!Array.isArray(link.get("providers")) || !link.get("providers").length)
			fail(`workflow_links.${id}.providers`, "expected nonempty array");
		const peers = [link.get("consumer"), ...link.get("providers")],
			seen = new Set();
		for (const [index, peer] of peers.entries()) {
			const entry = `workflow_links.${id}.${index === 0 ? "consumer" : "providers"}`;
			mapping(peer, entry, ["assignment", "binding"]);
			const actor = mapping(peer.get("assignment"), `${entry}.assignment`, [
				"role",
				"model",
				"host",
			]);
			if (
				!roles.has(actor.get("role")) ||
				!models.has(actor.get("model")) ||
				!integrations.some((item) => item.id === actor.get("host"))
			)
				fail(entry, "expected declared canonical role/model/known host");
			if (!bindings.has(peer.get("binding")))
				fail(entry, "expected declared package binding");
			const pin = JSON.stringify([...actor].sort()) + peer.get("binding");
			if (index > 0 && seen.has(pin)) fail(entry, "duplicate provider");
			if (index > 0) seen.add(pin);
		}
	}
	return {
		repository,
		config,
		bindings,
		local,
		profiles,
		defaultProfile,
		defaultRole,
		models,
		aliases,
		families,
		prefixes,
		roles,
		roleSkills,
		workflowLinks,
	};
}

export function packageReferences(binding, { source, rules }) {
	return [
		{ reference: source, rule: null, entry: binding },
		...rules.map((rule) => ({
			reference:
				rule.source ??
				new Map([
					["package", source.get("package")],
					["version", rule.version],
				]),
			rule: rule.id,
			entry: `assignments.${rule.id}.${rule.source ? "bindings" : "versions"}.${binding}`,
		})),
	];
}
export const referenceKey = (reference) =>
	JSON.stringify([
		reference.get("package"),
		reference.get("version"),
		reference.get("revision") ?? null,
	]);

const contains = (a, b) => [...b].every(([key, value]) => a.get(key) === value);
function selectRule(binding, rules, context) {
	const matching = rules.filter((rule) =>
		[...rule.when].every(([key, value]) => context[key] === value),
	);
	const maxima = matching.filter(
		(rule) =>
			!matching.some(
				(other) =>
					other.when.size > rule.when.size && contains(other.when, rule.when),
			),
	);
	if (maxima.length > 1)
		fail(
			binding,
			`ambiguous assignments ${maxima
				.map((rule) => rule.id)
				.sort()
				.join(", ")}`,
		);
	return maxima[0];
}

export function validatePackageBindings(bindings, packages) {
	for (const [binding, { source, type, rules, pins }] of bindings) {
		for (const { reference, entry } of packageReferences(binding, {
			source,
			rules,
		})) {
			const version = reference.get("version");
			try {
				const name = reference.get("package");
				const found = packages.get(`${name}@${version}`);
				if (!found) fail(entry, `missing-package ${name}@${version}`);
				const manifest = parseManifest(
					found.files.find((file) => file.path === "package.yaml").bytes,
				);
				if (
					manifest.package.type !== type ||
					(type === "instruction" &&
						manifest.behavior.delivery !== "instruction")
				) {
					fail(
						entry,
						`${name}@${version}: expected ${type} package with compatible delivery`,
					);
				}
				const bytes = found.files.find(
					(file) => file.path === manifest.entrypoint,
				)?.bytes;
				if (!bytes)
					fail(
						entry,
						`${name}@${version}: missing entrypoint ${manifest.entrypoint}`,
					);
				new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
					bytes,
				);
				const metadata =
					type === "skill"
						? skillMetadata("unused", entry, bytes, manifest.entrypoint)
						: null;
				if (
					metadata?.nameSource === "directory" &&
					path.posix.dirname(manifest.entrypoint) === "."
				)
					metadata.name = name.split("/")[1];
				const pin = { manifest, bytes, metadata, sha256: found.sha256 };
				pins.set(referenceKey(reference), pin);
				// Legacy snapshot validation reads version aliases; v3 selection uses full reference keys.
				pins.set(version, pin);
			} catch (error) {
				fail(entry, `${reference.get("package")}@${version}: ${error.message}`);
			}
		}
	}
}

/**
 * Validate all configuration, then load only the selected additional layers.
 * Identity matching is exact and case-sensitive: model key, alias, supplied family,
 * longest configured family prefix, then default_profile.
 * `host` names the integration consuming the result; host-native skills of another host
 * are unusable there, and required ones are reported as unsatisfied.
 * `lockMode: 'required'` (public selection) refuses package pins without a valid current lock; internal
 * configure/preset `validation` checks the complete configuration against verified store bytes and only reports lock state.
 * @param {{root?: string, host?: string, model?: string, family?: string, identitySource?: 'host' | 'host-stated' | 'user', role?: string,
 *   skills?: string[], configuration?: Map<string, any>, storeRoot?: string, lockMode?: 'required' | 'validation',
 *   newRoleFile?: {path: string, content: string}, preview?: Map<string, Buffer>, metadataOnly?: boolean}} options
 */
function resolveCore(
	{
		root = process.cwd(),
		host,
		model,
		family,
		identitySource,
		role,
		skills = [],
		configuration,
		storeRoot,
		lockMode = "required",
		newRoleFile,
		preview = new Map(),
		metadataOnly = false,
	} = {},
	candidate = null,
	checkWorkflow = true,
) {
	if (!["required", "validation"].includes(lockMode))
		fail("lockMode", "expected required, validation, or an omitted value");
	if (
		host !== undefined &&
		!integrations.some((adapter) => adapter.id === host)
	)
		fail(
			"host",
			`expected one of ${integrations.map((adapter) => adapter.id).join(", ")} or an omitted value`,
		);
	for (const [name, value] of Object.entries({ model, family, role })) {
		if (value !== undefined && (typeof value !== "string" || !value.trim())) {
			fail(name, "expected a nonempty string or an omitted value");
		}
		if (value?.includes("\0"))
			fail(name, "NUL cannot be represented in a command argument");
	}
	if (
		identitySource !== undefined &&
		!["host", "host-stated", "user"].includes(identitySource)
	)
		fail(
			"identitySource",
			"expected host, host-stated, user, or an omitted value",
		);
	if (!Array.isArray(skills))
		fail("skills", "expected a list of requested skill IDs");
	skills.forEach((id, index) => identifier(id, `skills[${index}]`));

	const validated = validateConfiguration({
		root,
		configuration,
		newRoleFile,
		preview,
	});
	const {
		repository,
		bindings,
		local,
		profiles,
		defaultProfile,
		defaultRole,
		models,
		aliases,
		families,
		prefixes,
		roles,
	} = validated;
	// Lock state is settled before any store access; zero package pins need no lock and never read one.
	/** @type {{state: string, error?: string, locked?: Map<string, {sha256: string}>}} */
	const lock = bindings.size
		? readLockState(repository, validated, storeRoot)
		: { state: "not-required" };
	if (lockMode === "required" && lock.error) throw new Error(lock.error);
	const packages = new Map();
	for (const [binding, value] of bindings) {
		for (const { reference, entry } of packageReferences(binding, value)) {
			const name = reference.get("package"),
				version = reference.get("version");
			const key = `${name}@${version}`;
			try {
				if (!packages.has(key))
					packages.set(
						key,
						lookupPackage({ storeRoot, name, version }) ??
							releasedPackage({
								storeRoot,
								name,
								version,
								revisionDigest: reference.get("revision") ?? null,
							}),
					);
			} catch (error) {
				fail(entry, `${name}@${version}: ${error.message}`);
			}
			const found = packages.get(key),
				locked = lock.locked?.get(key);
			if (found && locked && found.sha256 !== locked.sha256) {
				if (lockMode === "required")
					fail(
						entry,
						`mismatched-package ${key}: verified store digest ${found.sha256} differs from locked ${locked.sha256}`,
					);
				lock.state = "invalid";
			}
		}
	}
	validatePackageBindings(bindings, packages);
	const v3 = validated.config.get("version") === 3;
	if (v3)
		for (const [binding, value] of bindings)
			for (const { reference } of packageReferences(binding, value)) {
				const closure = revisionClosure({
					storeRoot,
					name: reference.get("package"),
					version: reference.get("version"),
					revisionDigest: reference.get("revision") ?? null,
				});
				for (const member of closure) {
					const locked = lock.locked?.get(
						`${member.identity.name}@${member.identity.version}`,
					);
					if (locked && locked.sha256 !== member.sha256)
						fail(binding, "mismatched-package: dependency differs from lock");
				}
				Object.assign(value.pins.get(referenceKey(reference)), {
					closure,
					revisionDigest: reference.get("revision") ?? null,
					revision: closure.at(-1).revision,
				});
			}
	const canonical = models.has(model) ? model : (aliases.get(model) ?? null);
	const prefix =
		model === undefined
			? undefined
			: [...prefixes.keys()]
					.filter((item) => model.startsWith(item))
					.sort((a, b) => b.length - a.length)[0];
	const matchedBy = models.has(model)
		? "model"
		: canonical
			? "alias"
			: families.has(family)
				? "family"
				: prefix !== undefined
					? "family-prefix"
					: "default";
	const resolvedFamily =
		matchedBy === "family-prefix" ? prefixes.get(prefix) : (family ?? null);
	const familySource =
		matchedBy === "family-prefix"
			? "configured-prefix"
			: family === undefined
				? null
				: "supplied";
	const profile = canonical
		? models.get(canonical).get("profile")
		: matchedBy.startsWith("family")
			? families.get(resolvedFamily).get("profile")
			: defaultProfile;
	const selectedRole = role ?? defaultRole;
	if (!roles.has(selectedRole))
		fail(
			"role",
			`${selectedRole} is not declared in roles; choose ${[...roles.keys()].join(", ")} or run agent-profiles configure to create it`,
		);
	function selectPackages(context) {
		const selected = new Map();
		for (const [binding, { source, rules, pins }] of bindings) {
			const rule = selectRule(binding, rules, context);
			const reference = rule
				? (rule.source ??
					new Map([
						["package", source.get("package")],
						["version", rule.version],
					]))
				: source;
			const version = reference.get("version");
			const pin = pins.get(referenceKey(reference));
			selected.set(binding, {
				...pin,
				output: {
					path: null,
					backing: {
						type: "package",
						sha256: pin.sha256,
						path: pin.manifest.entrypoint,
					},
					package: {
						binding,
						name: reference.get("package"),
						version,
						sha256: pin.sha256,
						...(v3 ? { revisionDigest: pin.revisionDigest } : {}),
						selectedBy: rule ? rule.id : "binding-default",
						selectors: rule ? Object.fromEntries(rule.when) : {},
					},
				},
			});
		}
		if (
			candidate &&
			context.role === candidate.assignment.role &&
			context.model === candidate.assignment.model &&
			context.host === candidate.assignment.host
		) {
			const binding = candidate.record.provenance.binding,
				prior = selected.get(binding);
			if (
				!prior ||
				prior.revisionDigest !== candidate.record.parent ||
				prior.manifest.behavior.delivery !== "instruction" ||
				prior.manifest.package.type !== "skill"
			)
				fail("candidate", "parent selection mismatch");
			const manifest = parseManifest(
				candidate.files.find((file) => file.path === "package.yaml").bytes,
			);
			const bytes = candidate.files.find(
				(file) => file.path === manifest.entrypoint,
			).bytes;
			const metadata = skillMetadata(
				"unused",
				binding,
				bytes,
				manifest.entrypoint,
			);
			if (
				metadata.nameSource === "directory" &&
				path.posix.dirname(manifest.entrypoint) === "."
			)
				metadata.name = candidate.record.identity.name.split("/")[1];
			selected.set(binding, {
				...prior,
				manifest,
				bytes,
				metadata,
				sha256: candidate.record.content.sha256,
				revision: candidate.record,
				revisionDigest: candidate.digest,
				closure: candidate.closure,
				output: {
					path: null,
					backing: {
						type: "package",
						sha256: candidate.record.content.sha256,
						path: manifest.entrypoint,
					},
					package: {
						...prior.output.package,
						...candidate.record.identity,
						sha256: candidate.record.content.sha256,
						revisionDigest: candidate.digest,
					},
				},
			});
		}
		return selected;
	}
	const selectedPackages = selectPackages({
		model: canonical,
		profile,
		role: selectedRole,
		host: host ?? null,
	});
	const resolveSkill = (skill) => {
		if (!skill.binding) return skill;
		const packaged = selectedPackages.get(skill.binding);
		const native = packaged.manifest.behavior.delivery === "native";
		return {
			id: skill.id,
			type: native ? "host" : "instruction",
			delivery: native ? "invoke" : "inject",
			...packaged.metadata,
			...packaged.output,
			...(native
				? {
						host: host ?? null,
						hostId: null,
						scope: "package",
						supportedHosts: packaged.manifest.behavior.hosts,
						verification: "verified-package",
					}
				: {}),
		};
	};
	const roleSkills = new Map(
		[...validated.roleSkills].map(([id, lists]) => [
			id,
			{
				required: lists.required.map(resolveSkill),
				available: lists.available.map(resolveSkill),
			},
		]),
	);
	const { required, available } = roleSkills.get(selectedRole);
	const permitted = new Map(
		[...required, ...available].map((skill) => [skill.id, skill]),
	);
	for (const id of skills) {
		if (!permitted.has(id))
			fail(
				`role ${selectedRole}`,
				`skill ${id} is not required or available to this role`,
			);
	}
	const selectedSkills = [
		...new Set([...required.map((skill) => skill.id), ...skills]),
	].map((id) => permitted.get(id));
	const files = [
		{
			path: `.agent-profiles/${profiles.get(profile)?.get("file") ?? `profiles/${profile}.md`}`,
			kind: "profile",
			id: profile,
			...local.get(`profiles.${profile}`),
			...selectedPackages.get(`profiles.${profile}`)?.output,
		},
		{
			path: `.agent-profiles/${roles.get(selectedRole).get("file")}`,
			kind: "role",
			id: selectedRole,
			...local.get(`roles.${selectedRole}`),
			...selectedPackages.get(`roles.${selectedRole}`)?.output,
		},
		...selectedSkills
			.filter((skill) => skill.type === "instruction")
			.map((skill) => ({
				path: skill.path,
				id: skill.id,
				kind: required.some((item) => item.id === skill.id)
					? "required-skill"
					: "requested-skill",
				...local.get(`skills.${skill.id}`),
				...selectedPackages.get(`skills.${skill.id}`)?.output,
			})),
	];
	let workflowState;
	let workflowPeerPackages;
	const captureActors = [];
	const captureBindings = (body) =>
		[...body.roots.values()].map((selected) => ({
			root: { ...selected.output.package },
			closure: selected.closure.map((member) => ({
				...member.identity,
				sha256: member.sha256,
				revisionDigest: member.revisionDigest,
			})),
		}));
	function actorParts(selection, actorProfile, actorRole, requested = []) {
		const lists = validated.roleSkills.get(actorRole);
		const owners = [
			`profiles.${actorProfile}`,
			`roles.${actorRole}`,
			...[
				...new Set([...lists.required.map((item) => item.id), ...requested]),
			].map((id) => `skills.${id}`),
		];
		const parts = [],
			loadedBindings = new Map(),
			roots = new Map(),
			seen = new Map();
		for (const binding of owners) {
			const selected = selection.get(binding);
			if (!selected) continue;
			roots.set(binding, selected);
			const members = [];
			for (const member of selected.closure) {
				const name = member.identity.name,
					pin = `${member.identity.version}:${member.sha256}:${member.revisionDigest}`;
				if (seen.has(name) && seen.get(name) !== pin)
					fail("workflow dependency", `conflicting loaded package ${name}`);
				seen.set(name, pin);
				const manifest = parseManifest(
					member.files.find((file) => file.path === "package.yaml").bytes,
				);
				const root =
					member.identity.name === selected.output.package.name &&
					member.identity.version === selected.output.package.version;
				if (manifest.behavior.delivery === "native") {
					if (!root)
						fail(
							"workflow dependency",
							`${name}@${member.identity.version}: native prerequisite cannot be injected; invocation unverified`,
						);
					continue;
				}
				const kind = root
					? binding.startsWith("profiles.")
						? "profile"
						: binding.startsWith("roles.")
							? "role"
							: lists.required.some((item) => binding === `skills.${item.id}`)
								? "required-skill"
								: "requested-skill"
					: "dependency";
				const pkg = {
					...selected.output.package,
					...member.identity,
					sha256: member.sha256,
					revisionDigest: member.revisionDigest,
				};
				const task = {
					path: null,
					kind,
					id: root ? binding.split(".")[1] : name,
					binding,
					owner: binding,
					backing: {
						type: "package",
						sha256: member.sha256,
						path: manifest.entrypoint,
					},
					package: pkg,
					revision: member.revision,
					content: new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(
						member.files.find((file) => file.path === manifest.entrypoint)
							.bytes,
					),
				};
				members.push(task);
				const existing = parts.find(
					(part) =>
						part.backing.sha256 === task.backing.sha256 &&
						part.backing.path === task.backing.path &&
						part.package.revisionDigest === member.revisionDigest,
				);
				if (existing && root && existing.kind === "dependency") {
					// Attribute direct use without moving or copying the dependency's physical bytes/original owner.
					Object.assign(existing, { kind, id: task.id, binding, package: pkg });
					const companion = parts.find(
						(part) =>
							part.kind === "workflow" &&
							part.backing.sha256 === member.sha256 &&
							part.package.revisionDigest === member.revisionDigest,
					);
					if (companion)
						Object.assign(companion, { id: task.id, binding, package: pkg });
				}
				if (!existing) {
					parts.push(task);
					const companion = member.revision?.workflow?.file;
					if (companion !== undefined && companion !== null)
						parts.push({
							...task,
							kind: "workflow",
							backing: { ...task.backing, path: companion },
							content: new TextDecoder("utf-8", {
								fatal: true,
								ignoreBOM: true,
							}).decode(
								member.files.find((file) => file.path === companion).bytes,
							),
						});
				}
			}
			loadedBindings.set(binding, members);
		}
		return { parts, loadedBindings, roots };
	}
	let composed;
	if (v3 && !metadataOnly) {
		composed = actorParts(selectedPackages, profile, selectedRole, skills);
		workflowState = { status: "unverified", runtime: "unverified", peers: [] };
		workflowPeerPackages = [];
		if (checkWorkflow && host !== undefined && canonical !== null) {
			const actors = new Map();
			const actorKey = (actor) =>
				JSON.stringify([actor.role, actor.model, actor.host]);
			const current = { role: selectedRole, model: canonical, host };
			actors.set(
				actorKey(current),
				skills.length
					? actorParts(selectedPackages, profile, selectedRole)
					: composed,
			);
			function getActor(peer) {
				const actor = Object.fromEntries(peer.get("assignment")),
					key = actorKey(actor);
				if (!actors.has(key)) {
					const peerProfile = models.get(actor.model).get("profile");
					actors.set(
						key,
						actorParts(
							selectPackages({ ...actor, profile: peerProfile }),
							peerProfile,
							actor.role,
						),
					);
				}
				return { actor, body: actors.get(key), binding: peer.get("binding") };
			}
			const rows = [],
				covered = new Set(),
				pending = new Set(validated.workflowLinks.values());
			while (pending.size) {
				const link = [...pending].find((item) =>
					[item.get("consumer"), ...item.get("providers")].some((peer) =>
						actors.has(actorKey(Object.fromEntries(peer.get("assignment")))),
					),
				);
				if (!link) break;
				pending.delete(link);
				const consumerSpec = link.get("consumer"),
					providers = link.get("providers");
				const protocol = link.get("protocol"),
					consumer = getActor(consumerSpec);
				const consumerParts = consumer.body.loadedBindings.get(
					consumer.binding,
				);
				if (!consumerParts)
					fail("workflow consumer", "binding is not loaded/required");
				const consumerRoot = consumer.body.roots.get(consumer.binding).revision;
				if (!consumerRoot || consumerRoot.workflow === null)
					fail("workflow consumer", "unknown root metadata/declaration");
				const requiring = consumerParts.filter((part) =>
					part.revision?.workflow?.requires.some(
						(item) => item.protocol === protocol,
					),
				);
				if (requiring.length !== 1)
					fail(
						"workflow consumer",
						"missing or unknown required protocol declaration",
					);
				const requirement = requiring[0].revision.workflow.requires.find(
					(item) => item.protocol === protocol,
				);
				covered.add(
					`${actorKey(consumer.actor)}:${requiring[0].package.revisionDigest}:${protocol}`,
				);
				for (const providerSpec of providers) {
					const provider = getActor(providerSpec),
						bound = provider.body.loadedBindings.get(provider.binding);
					if (!bound)
						fail("workflow provider", "binding is not loaded/required");
					const providerRoot = provider.body.roots.get(
						provider.binding,
					).revision;
					if (!providerRoot || providerRoot.workflow === null)
						fail("workflow provider", "unknown root metadata/declaration");
					if (
						bound.some(
							(part) =>
								part.revision === null || part.revision.workflow === null,
						)
					)
						fail("workflow provider", "unknown metadata/declaration");
					const candidates = provider.body.parts.filter(
						(part) =>
							part.kind !== "workflow" &&
							part.revision?.workflow?.provides.some(
								(item) => item.protocol === protocol,
							),
					);
					if (candidates.length > 1)
						fail(
							"workflow provider",
							"conflicting multiple loaded protocol providers",
						);
					if (
						candidates.length !== 1 ||
						!bound.some(
							(part) =>
								part.package.revisionDigest ===
								candidates[0].package.revisionDigest,
						)
					)
						fail(
							"workflow provider",
							"binding does not provide loaded protocol",
						);
					const provided = candidates[0].revision.workflow.provides.find(
						(item) => item.protocol === protocol,
					);
					if (provided.major !== requirement.major)
						fail("workflow protocol", "incompatible major");
					const consumerDigest = requiring[0].package.revisionDigest,
						providerDigest = candidates[0].package.revisionDigest;
					const row = {
						protocol,
						major: requirement.major,
						consumer: {
							assignment: consumer.actor,
							binding: consumer.binding,
							revisionDigest: consumerDigest,
						},
						provider: {
							assignment: provider.actor,
							binding: provider.binding,
							revisionDigest: providerDigest,
						},
					};
					if (
						rows.some((prior) => JSON.stringify(prior) === JSON.stringify(row))
					)
						fail("workflow link", "duplicate peer relation");
					rows.push(row);
					for (const part of [requiring[0], candidates[0]])
						if (
							!workflowPeerPackages.some(
								(pkg) => pkg.revisionDigest === part.package.revisionDigest,
							)
						)
							workflowPeerPackages.push(part.package);
				}
			}
			for (const [key, body] of [...actors, [actorKey(current), composed]])
				for (const part of body.parts.filter(
					(part) => part.kind !== "workflow",
				)) {
					for (const required of part.revision?.workflow?.requires ?? []) {
						if (
							!covered.has(
								`${key}:${part.package.revisionDigest}:${required.protocol}`,
							)
						)
							fail("workflow required", "missing explicit workflow link");
					}
				}
			for (const [key, body] of actors) {
				const [role, model, host] = JSON.parse(key);
				captureActors.push({
					assignment: { role, model, host },
					profile: models.get(model).get("profile"),
					bindings: captureBindings(body),
				});
			}
			const known =
				[...composed.roots.values()].every(
					(root) =>
						root.revision?.workflow !== undefined &&
						root.revision.workflow !== null,
				) &&
				composed.parts
					.filter((part) => part.kind !== "workflow")
					.every(
						(part) =>
							part.revision?.workflow !== undefined &&
							part.revision.workflow !== null,
					);
			workflowState = {
				status: known ? "declared-compatible" : "unverified",
				runtime: "unverified",
				peers: rows,
			};
		}
	}
	const loaded = metadataOnly
		? []
		: files.flatMap((entry) => {
				if (v3 && entry.package) return [];
				const file = entry.path;
				try {
					let content;
					if (entry.package)
						content = selectedPackages
							.get(entry.package.binding)
							.bytes.toString("utf8");
					else if (
						newRoleFile &&
						file === `.agent-profiles/${newRoleFile.path}`
					)
						content = newRoleFile.content;
					else {
						const resolved = localFile(
							repository,
							file,
							file,
							"repository",
							false,
							preview,
						);
						content = (
							preview.get(resolved) ?? readFileSync(resolved)
						).toString("utf8");
					}
					return { ...entry, content, ...measureText(content) };
				} catch (error) {
					fail(file, `cannot load instructions: ${error.message}`);
				}
			});
	if (composed) {
		// Keep local profile/role order; each package owner contributes dependency-first task/companion pairs.
		const ordered = [];
		const owners = [
			`profiles.${profile}`,
			`roles.${selectedRole}`,
			...selectedSkills.map((skill) => `skills.${skill.id}`),
		];
		for (const owner of owners) {
			for (const part of composed.parts.filter((part) => part.owner === owner))
				ordered.push({ ...part, ...measureText(part.content) });
			const localEntry = loaded.find(
				(entry) =>
					`${entry.kind === "profile" ? "profiles" : entry.kind === "role" ? "roles" : "skills"}.${entry.id}` ===
					owner,
			);
			if (localEntry) ordered.push(localEntry);
		}
		loaded.splice(0, loaded.length, ...ordered);
	}
	const measuredSkills = new Map(
		loaded
			.filter((entry) => entry.kind.endsWith("-skill"))
			.map((entry) => [
				entry.id,
				{ bytes: entry.bytes, characters: entry.characters },
			]),
	);
	if (v3)
		for (const skill of selectedSkills) {
			if (skill.type !== "instruction" || !skill.package) continue;
			const physical = loaded.find(
				(entry) =>
					entry.package?.name === skill.package.name &&
					entry.package.version === skill.package.version &&
					entry.package.sha256 === skill.package.sha256 &&
					entry.package.revisionDigest === skill.package.revisionDigest &&
					entry.backing.path === skill.backing.path,
			);
			if (physical)
				measuredSkills.set(skill.id, {
					bytes: physical.bytes,
					characters: physical.characters,
				});
		}
	// Legacy `usable` means host compatibility only; the adapter determines actual invocation.
	const usable = (skill) => ({
		bytes: null,
		characters: null,
		usable:
			host === undefined
				? null
				: skill.supportedHosts
					? skill.supportedHosts.includes(host)
					: skill.host === host,
	});
	const unsatisfied =
		host === undefined
			? []
			: required
					.filter((skill) => skill.type === "host" && !usable(skill).usable)
					.map((skill) => ({
						id: skill.id,
						host: skill.host,
						hostId: skill.hostId,
						reason: skill.package
							? `${skill.package.name}@${skill.package.version} does not support ${host}; native invocation is not verified`
							: `${integrations.find((item) => item.id === skill.host).name} skill ${skill.hostId} cannot be invoked by ${integrations.find((item) => item.id === host).name}`,
					}));
	const measuredAvailable = available.map((skill) => {
		try {
			if (skill.type === "host") return { ...skill, ...usable(skill) };
			if (metadataOnly) return { ...skill, bytes: null, characters: null };
			let measured = measuredSkills.get(skill.id);
			if (!measured && skill.package)
				measured = measureText(
					selectedPackages.get(skill.package.binding).bytes.toString("utf8"),
				);
			if (!measured) {
				const file = localFile(
					repository,
					skill.path,
					skill.path,
					"repository",
					false,
					preview,
				);
				measured = preview.has(file)
					? measureText(preview.get(file).toString("utf8"))
					: measureFile(file);
			}
			return { ...skill, ...measured };
		} catch (error) {
			fail(
				skill.path,
				`cannot measure available instructions: ${error.message}`,
			);
		}
	});

	const requiredOut = required.map((skill) => ({
		...skill,
		...(skill.type === "host" ? usable(skill) : measuredSkills.get(skill.id)),
	}));
	// Selected instruction aliases share physical bodies; native invocation entries remain in the inventory.
	const diagnosticAvailable =
		v3 && !metadataOnly
			? measuredAvailable.filter(
					(skill) =>
						skill.type === "host" ||
						!selectedSkills.some(
							(selected) =>
								selected.id === skill.id &&
								selected.type === "instruction" &&
								measuredSkills.has(selected.id),
						),
				)
			: measuredAvailable;
	const resolution = {
		host: host ?? null,
		model: model ?? null,
		family: resolvedFamily,
		familySource,
		matchedBy,
		identity: {
			raw: model ?? null,
			canonical,
			source: model === undefined ? null : (identitySource ?? null),
			matchedBy,
		},
		profile,
		role: selectedRole,
		roleSource: role === undefined ? "default" : "assigned",
		repository: {
			path: "AGENTS.md",
			suppliedBy: "host",
			exists: existsSync(path.join(repository, "AGENTS.md")),
		},
		loaded,
		...(v3
			? {
					workflow: workflowState ?? {
						status: "unverified",
						runtime: "unverified",
						peers: [],
					},
					workflowPeerPackages: workflowPeerPackages ?? [],
					requestedSkills: [...new Set(skills)],
				}
			: {}),
		required: requiredOut,
		available: measuredAvailable,
		unsatisfied,
		lockMode,
		lockState: lock.state,
		installRequired: !["valid", "not-required"].includes(lock.state),
		diagnostics: contextDiagnostics(
			loaded,
			diagnosticAvailable,
			requiredOut,
			host,
			metadataOnly || host === undefined
				? null
				: managedSurface(repository, host),
		),
	};
	return {
		resolution,
		evidence: {
			primary: composed ? captureBindings(composed) : [],
			actors: captureActors,
		},
	};
}

export function resolveInstructions(input = {}) {
	return resolveCore(input).resolution;
}

// Internal capture uses the same selected roots and required-only actors as normal resolution.
export function resolveCapture(input = {}) {
	return resolveCore(input);
}

// Internal sharing inventory retains validated selection and composition without claiming workflow readiness.
export function resolveSharingSelection(input = {}) {
	const { resolution, evidence } = resolveCore(input, null, false);
	return {
		resolution: {
			loaded: resolution.loaded,
			required: resolution.required,
			available: resolution.available,
		},
		evidence: { primary: evidence.primary },
	};
}

// Internal candidate capture validates normal selection first; no public option bypasses the lock.
export function resolveCandidateCapture(input, recordDigest) {
	const normal = resolveCore(input).resolution,
		record = readRevisionRecord({ storeRoot: input.storeRoot, recordDigest });
	if (record.kind !== "candidate")
		fail("candidate", "expected retained unpublished candidate");
	const files = verifyObject(
			input.storeRoot,
			record.content.sha256,
			record.content.identity,
		),
		members = new Map();
	for (const dependency of record.dependencies)
		for (const member of revisionClosure({
			storeRoot: input.storeRoot,
			name: dependency.name,
			version: dependency.version,
			revisionDigest: dependency.revisionDigest,
		})) {
			const prior = members.get(member.identity.name);
			if (
				prior &&
				(prior.sha256 !== member.sha256 ||
					prior.revisionDigest !== member.revisionDigest)
			)
				fail("candidate dependency", "conflicting closure");
			members.set(member.identity.name, member);
		}
	const candidate = {
		digest: recordDigest,
		record,
		files,
		assignment: {
			role: normal.role,
			model: normal.identity.canonical,
			host: normal.host,
		},
		closure: [
			...members.values(),
			{
				identity: record.identity,
				sha256: record.content.sha256,
				files,
				revisionDigest: recordDigest,
				revision: record,
			},
		],
	};
	return resolveCore(input, candidate);
}
