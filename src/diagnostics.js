import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";
import {
	bootstrapBlock,
	integrations,
	renderResolveCommand,
} from "./integrations.js";

const clean = (value) =>
	stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function measureText(content) {
	return {
		bytes: Buffer.byteLength(content, "utf8"),
		characters: [...content].length,
	};
}

// Scan unloaded text for exact counts without retaining its body in the result.
export function measureFile(file) {
	const descriptor = openSync(file, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.alloc(65536);
		let bytes = 0,
			characters = 0;
		for (;;) {
			const size = readSync(descriptor, buffer, 0, buffer.length, null);
			const text = size
				? decoder.write(buffer.subarray(0, size))
				: decoder.end();
			const measured = measureText(text);
			bytes += measured.bytes;
			characters += measured.characters;
			if (!size) return { bytes, characters };
		}
	} finally {
		closeSync(descriptor);
	}
}

function total(entries) {
	return entries.reduce(
		(sum, entry) => ({
			files: sum.files + 1,
			bytes: sum.bytes + entry.bytes,
			characters: sum.characters + entry.characters,
		}),
		{ files: 0, bytes: 0, characters: 0 },
	);
}

export function contextDiagnostics(
	loaded,
	available,
	required = [],
	consumer,
	surface = null,
) {
	const loadedSkills = new Set(
		loaded
			.filter((entry) => entry.kind.endsWith("-skill"))
			.map((entry) => entry.id),
	);
	const host = (list, requirement) =>
		list
			.filter((skill) => skill.type === "host")
			.map(({ id, host, hostId, verification, usable }) => ({
				id,
				host,
				hostId,
				requirement,
				verification,
				usable,
				bytes: null,
				characters: null,
			}));
	return {
		scope: "resolved-instruction-bodies",
		encoding: "utf8",
		characterUnit: "unicode-code-points",
		excluded: [
			"host-context",
			"repository-instructions",
			"bootstrap-instructions",
			"host-native-skills",
			"inventory-rendering",
			"output-formatting",
		],
		managed: {
			profile: total(loaded.filter((entry) => entry.kind === "profile")),
			role: total(loaded.filter((entry) => entry.kind === "role")),
			requiredSkills: total(
				loaded.filter((entry) => entry.kind === "required-skill"),
			),
			requestedSkills: total(
				loaded.filter((entry) => entry.kind === "requested-skill"),
			),
			total: total(loaded),
		},
		availableNotLoaded: total(
			available.filter(
				(entry) => entry.type !== "host" && !loadedSkills.has(entry.id),
			),
		),
		// Delivered by the host's own skill mechanism; Agent Profiles never injects or measures them.
		hostSkills: [
			...host(required, "required"),
			...host(available, "available"),
		],
		// Bootstrap mode adds this managed block to each host instruction surface; native integrations need none.
		// The installed block is measured as stored (CRLF files hold a CRLF block); otherwise the block init would write with LF.
		bootstrap: !consumer
			? {
					scope: "not-measured",
					host: null,
					file: null,
					installed: false,
					bytes: null,
					characters: null,
				}
			: surface
				? {
						scope: "installed-managed-block",
						host: consumer,
						file: surface.file,
						installed: true,
						...measureText(surface.block.toString("utf8")),
					}
				: {
						scope: "expected-managed-block",
						host: consumer,
						file: null,
						installed: false,
						...measureText(bootstrapBlock(consumer).toString("utf8")),
					},
		repository: {
			path: "AGENTS.md",
			suppliedBy: "host",
			status: "host-supplied",
			injection: "host-controlled",
			bytes: null,
			characters: null,
			otherInstructions: { status: "unobserved", suppliedBy: "host" },
		},
		host: {
			systemInstructions: { status: "unobserved" },
			tools: { status: "unobserved" },
			builtInSkills: { status: "unobserved" },
			otherContext: { status: "unobserved" },
		},
		tokens: { value: null, kind: "not-calculated", method: null },
	};
}

export function resolutionOutput(result, contents = false) {
	return {
		...result,
		loaded: contents
			? result.loaded
			: result.loaded.map(({ content, ...entry }) => entry),
	};
}

function injectedSkillIDs(result) {
	const ids = new Set(
		result.loaded
			.filter((entry) => entry.kind.endsWith("-skill"))
			.map((entry) => entry.id),
	);
	for (const entry of result.available) {
		if (
			entry.type !== "instruction" ||
			!entry.package ||
			!result.requestedSkills?.includes(entry.id)
		)
			continue;
		if (
			result.loaded.some(
				(part) =>
					part.package?.name === entry.package.name &&
					part.package.version === entry.package.version &&
					part.package.sha256 === entry.package.sha256 &&
					part.package.revisionDigest === entry.package.revisionDigest &&
					part.backing.path === entry.backing.path,
			)
		)
			ids.add(entry.id);
	}
	return ids;
}

export function formatProof(result) {
	const size = (entry) => `${entry.bytes} B; ${entry.characters} characters`;
	// Package bodies have no repository path; their exact identity and digest locate them.
	const source = (entry) =>
		entry.package
			? `${entry.package.name}@${entry.package.version} sha256:${entry.package.sha256}${entry.binding ? ` ${entry.backing.path}` : ""}`
			: entry.path;
	const lines = [
		"Context proof",
		"",
		`Host        ${clean(result.host ?? "(unspecified)")}`,
		`Model       ${clean(result.model ?? "(unknown)")}`,
		`Canonical   ${clean(result.identity.canonical ?? "(none)")}`,
		`Source      ${clean(result.identity.source ?? "(unspecified)")}`,
		`Family      ${clean(result.family ?? "(unknown)")}${result.familySource ? ` (${result.familySource})` : ""}`,
		`Matched by  ${result.matchedBy}`,
		`Profile     ${clean(result.profile)}`,
		`Role        ${clean(result.role)}`,
		"",
		"Injected by Agent Profiles (instruction bodies)",
	];
	for (const [kind, label] of [
		["profile", "Profile"],
		["role", "Role"],
		["required-skill", "Required skills"],
		["requested-skill", "Requested skills"],
		...(result.workflow
			? [
					["dependency", "Dependencies"],
					["workflow", "Workflow companions"],
				]
			: []),
	]) {
		lines.push("", label);
		const entries = result.loaded.filter((entry) => entry.kind === kind);
		if (!entries.length) lines.push("  (none)");
		for (const entry of entries) {
			lines.push(`  ${clean(source(entry))}  ${size(entry)}`);
			for (const file of entry.resources ?? [])
				lines.push(`    Declared resource: ${clean(file)} (not injected)`);
		}
	}
	if (result.workflow) {
		lines.push(
			"",
			`Workflow declarations: ${result.workflow.status}; runtime: unverified`,
		);
		for (const peer of result.workflow.peers) {
			const release = (digest) => {
				const pkg = result.workflowPeerPackages.find(
					(pkg) => pkg.revisionDigest === digest,
				);
				return `${pkg.name}@${pkg.version} revision:${digest}`;
			};
			lines.push(
				`  ${clean(peer.protocol)} major ${peer.major}: ${clean(release(peer.consumer.revisionDigest))} requires ${clean(release(peer.provider.revisionDigest))}`,
			);
		}
		lines.push(
			"Declarations do not establish host loading, invocation or worker compliance.",
		);
	}
	const loadedIDs = injectedSkillIDs(result);
	lines.push(
		"",
		`Agent Profiles managed context: ${size(result.diagnostics.managed.total)}`,
		"",
		"Available, not injected",
	);
	const remaining = result.available.filter(
		(entry) => entry.type !== "host" && !loadedIDs.has(entry.id),
	);
	if (!remaining.length) lines.push("  (none)");
	for (const entry of remaining) {
		lines.push(
			`  ${clean(entry.id)} (${clean(source(entry))})  ${size(entry)}`,
		);
		for (const file of entry.resources ?? [])
			lines.push(`    Declared resource: ${clean(file)} (not injected)`);
	}
	lines.push(
		`Available context not injected: ${size(result.diagnostics.availableNotLoaded)}`,
		"",
		"Host-native skills (invoked through the host; bytes not counted)",
	);
	if (!result.diagnostics.hostSkills.length) lines.push("  (none)");
	const usability = (entry) =>
		entry.usable === null
			? "; host compatibility unknown; invocation not verified"
			: entry.usable
				? "; host-compatible; invocation not verified"
				: "; incompatible with this host";
	for (const entry of result.diagnostics.hostSkills) {
		const skill = [...result.required, ...result.available].find(
			(item) => item.id === entry.id,
		);
		lines.push(
			`  ${clean(entry.id)} (${clean(skill?.package ? source(skill) : `${entry.host}: ${entry.hostId}`)})  ${entry.requirement}; ${entry.verification}${usability(entry)}`,
		);
	}
	if (result.unsatisfied.length) lines.push("", "Unsatisfied requirements");
	for (const entry of result.unsatisfied)
		lines.push(`  ${clean(entry.id)}: ${clean(entry.reason)}`);
	const { bootstrap } = result.diagnostics;
	const block =
		bootstrap.bytes === null
			? "Bootstrap block: not measured (no --host given)"
			: bootstrap.installed
				? `Bootstrap block in ${clean(bootstrap.file)}: ${size(bootstrap)} (bootstrap mode only; not in the managed total)`
				: `Bootstrap block (not installed; as init would write it with LF): ${size(bootstrap)}`;
	lines.push(
		"",
		block,
		"",
		"Repository context: AGENTS.md and other project instructions supplied by host; injection host controlled; not measured.",
		"Host context: system instructions, tools, built-in skills, and runtime context unobserved.",
		"Tokens: not calculated (no tokenizer or estimate).",
		"Counts: UTF-8 encoded resolved text; characters are Unicode code points.",
		"Excludes bootstrap, inventory rendering, and output formatting. This is not total agent context or a savings claim.",
	);
	return lines.join("\n");
}

// Agent-facing resolution: everything the model needs, so it never parses agents.yaml itself.
/** @param {any} result @param {{root?: string, storeRoot?: string}} [context] */
export function formatContext(result, { root, storeRoot } = {}) {
	const args = [];
	if (root !== undefined) args.push("--root", root);
	if (storeRoot !== undefined) args.push("--store", storeRoot);
	if (result.host) args.push("--host", result.host);
	if (result.identity.source)
		args.push("--identity-source", result.identity.source);
	if (result.model !== null) args.push("--model", result.model);
	if (result.familySource === "supplied") args.push("--family", result.family);
	if (result.roleSource === "assigned") args.push("--role", result.role);
	args.push(
		...(
			result.requestedSkills ??
			result.loaded
				.filter((entry) => entry.kind === "requested-skill")
				.map((entry) => entry.id)
		).flatMap((id) => ["--skill", id]),
	);
	const skill = (entry) => {
		if (entry.package) {
			const identity = `${clean(entry.package.name)}@${clean(entry.package.version)} (sha256 ${clean(entry.package.sha256)})`;
			if (entry.type === "host")
				return `Native package ${identity}; supported hosts: ${entry.supportedHosts.map(clean).join(", ")}. Host-visible address unavailable; invocation unverified.`;
			return (
				`Package ${identity}. Load by binding ID:\n` +
				["Bash", "PowerShell"]
					.map(
						(shell) =>
							`  Command (${shell}): \`${renderResolveCommand([...args, "--skill", entry.id], shell)}\``,
					)
					.join("\n")
			);
		}
		return entry.type === "host"
			? `Invoke the ${clean(entry.host)} skill \`${clean(entry.hostId)}\` through your host's skill mechanism.`
			: `Read \`${clean(entry.path)}\`.${entry.resources?.length ? ` Declared resources (not injected): ${entry.resources.map((file) => `\`${clean(file)}\``).join(", ")}.` : ""}`;
	};
	const reminder = integrations.find(
		(adapter) => adapter.id === result.host,
	)?.repositoryReminder;
	const lines = [
		"# Agent Profiles context",
		"",
		`Profile: ${result.profile} (model ${result.model ?? "not stated"}; matched by ${result.matchedBy}). Role: ${result.role}.`,
		"These instructions add to the repository instructions and never override them or host permissions.",
		...(result.repository.exists && reminder ? [reminder] : []),
		"This output supersedes Agent Profiles profile, role, and skill instructions from any earlier run in this context,",
		"including copies your host re-attached after compaction.",
	];
	const titles = {
		profile: "Profile",
		role: "Role",
		"required-skill": "Required skill",
		"requested-skill": "Requested skill",
		dependency: "Dependency",
		workflow: "Workflow companion",
	};
	if (result.unsatisfied.length) {
		lines.push(
			"",
			"## Unsatisfied requirements",
			"",
			"This role requires capabilities your host cannot provide. Tell the user before doing role work, and do not substitute another skill:",
		);
		for (const entry of result.unsatisfied)
			lines.push(`- ${clean(entry.id)}: ${clean(entry.reason)}.`);
	}
	for (const entry of result.loaded) {
		lines.push(
			"",
			`## ${titles[entry.kind]}: ${entry.id}`,
			"",
			result.workflow ? entry.content : entry.content.trim(),
		);
		if (entry.resources?.length)
			lines.push(
				"",
				`Declared resources (not injected): ${entry.resources.map((file) => `\`${file}\``).join(", ")}.`,
			);
	}
	const requiredHost = result.required.filter(
		(entry) => entry.type === "host" && entry.usable !== false,
	);
	if (requiredHost.length) {
		lines.push(
			"",
			"## Required host skills",
			"",
			"Use each for all work in this role:",
		);
		for (const entry of requiredHost)
			lines.push(`- ${entry.id}: ${skill(entry)}`);
	}
	// Skill IDs may equal a profile or role ID, so compare against injected skills only.
	const loadedIDs = injectedSkillIDs(result);
	// Another host's skills are never exposed: this host could not invoke them.
	const available = result.available.filter(
		(entry) => !loadedIDs.has(entry.id) && entry.usable !== false,
	);
	if (available.length) {
		lines.push(
			"",
			"## Available skills",
			"",
			"Use a skill only when the current task falls within its description:",
		);
		for (const entry of available)
			lines.push(
				`- ${clean(entry.id)}${entry.description ? ` — ${clean(entry.description)}` : ""} ${skill(entry)}`,
			);
	}
	lines.push(
		"",
		"## Run again",
		"",
		...["Bash", "PowerShell"].map(
			(shell) => `Command (${shell}): \`${renderResolveCommand(args, shell)}\``,
		),
		"- after context compaction or in a new agent context;",
		"- after a model change, with the new exact model ID;",
		"- to change role, with `--role <id>`; a new session gives a cleaner transition.",
	);
	return lines.join("\n");
}
