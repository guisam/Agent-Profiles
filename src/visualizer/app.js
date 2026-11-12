// The page's elements are fixed in index.html; a missing one is a bug, so fail loudly.
/** @param {string} id */
const byId = (id) => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`Missing #${id}`);
	return node;
};
const model = /** @type {HTMLSelectElement} */ (byId("model"));
const host = /** @type {HTMLSelectElement} */ (byId("host"));
const family = /** @type {HTMLSelectElement} */ (byId("family"));
const role = /** @type {HTMLSelectElement} */ (byId("role"));
const pin = /** @type {HTMLButtonElement} */ (byId("pin"));
const addKind = /** @type {HTMLSelectElement} */ (byId("add-kind"));
const addProfile = /** @type {HTMLSelectElement} */ (byId("add-profile"));
const addId = /** @type {HTMLInputElement} */ (byId("add-id"));
// Resolution JSON from the local server (src/visualize.ts); its shape is the resolver's output.
/** @type {any} */
let current;
/** @type {any} */
let pinned;
let requestNumber = 0;
/** @type {Set<string>} */
let requested = new Set();
let initialized = false;
/** @type {string[]} Role IDs from the last configuration load, for library previews. */
let roles = [];
// Explicit launch values may deliberately exercise fallback routing.
/** @type {Record<string, string>} */
const launchFallbacks = {};
/** @param {number} value */
const bytes = (value) => `${value.toLocaleString("en-US")} B`;
/** @param {{bytes: number, characters: number}} entry */
const size = (entry) =>
	`${bytes(entry.bytes)} · ${entry.characters.toLocaleString("en-US")} characters`;

// Configuration and instruction text are always text nodes, never HTML/Markdown.
/** @param {string} tag */
function element(tag, text = "", className = "") {
	const node = document.createElement(tag);
	node.textContent = text;
	node.className = className;
	return node;
}

/** @param {string} endpoint @returns {Promise<any>} */
async function get(endpoint) {
	let response;
	try {
		response = await fetch(endpoint, { cache: "no-store" });
	} catch {
		throw new Error(
			"The visualizer server is unavailable. Restart it if needed, then use Refresh files to reconnect.",
		);
	}
	const data = await response.json();
	if (!response.ok)
		throw new Error(data.error ?? `Request failed (${response.status})`);
	if (data.withheld?.length)
		throw new Error(
			`Trust policy withheld instructions: ${data.withheld.map((/** @type {any} */ entry) => `${entry.id} (${entry.package.name}@${entry.package.version}): ${entry.reason}`).join("; ")}`,
		);
	return data;
}

/**
 * @param {HTMLSelectElement} select
 * @param {string[]} choices
 * @param {string | null} empty
 * @param {string} [selected]
 */
function options(select, choices, empty, selected) {
	select.replaceChildren();
	if (empty) select.add(new Option(empty, ""));
	for (const value of choices) select.add(new Option(value, value));
	if (selected && !choices.includes(selected))
		select.add(new Option(selected, selected));
	select.value = selected ?? "";
}

/** @param {any} entry @param {string} provenance */
function inspect(entry, provenance) {
	const details = document.createElement("details");
	// Package integrity does not establish a host-visible invocation address.
	const host = entry.type === "host";
	const location = entry.package
		? `${entry.package.binding}: ${entry.package.name}@${entry.package.version} sha256:${entry.package.sha256}${entry.package.revisionDigest ? ` revision:${entry.package.revisionDigest}` : ""} (${entry.package.selectedBy})${entry.binding ? ` · ${entry.backing.path}` : ""}`
		: (entry.path ?? `${entry.host}: ${entry.hostId}`);
	const native = entry.package
		? `Supported hosts: ${entry.supportedHosts?.join(", ")}; host-visible address unavailable; invocation unverified · bytes not counted`
		: `${entry.host} skill ${entry.hostId} · ${entry.verification} · bytes not counted`;
	details.append(
		element(
			"summary",
			`${entry.id} · ${host ? "host skill" : bytes(entry.bytes)}`,
		),
		element("p", host ? native : size(entry), "size"),
		element("p", provenance, "muted"),
		element("code", location),
	);
	if (entry.description)
		details.append(element("p", entry.description, "muted"));
	if (entry.resources?.length)
		details.append(
			element(
				"p",
				`Declared resources (not injected): ${entry.resources.join(", ")}`,
				"muted",
			),
		);
	if (entry.content !== undefined)
		details.append(element("pre", entry.content));
	return details;
}

function compare() {
	byId("comparison").hidden = !pinned;
	if (!pinned) return;
	const label = (/** @type {any} */ result) =>
		`${result.host ?? "Unspecified host"} / ${result.model ?? "Default model"} / ${result.family ?? "no family"} / ${result.role} / ${result.profile}`;
	byId("comparison-label").textContent = `${label(pinned)} → ${label(current)}`;
	const rows = byId("comparison-rows");
	rows.replaceChildren();
	for (const [key, title] of [
		["profile", "Profile"],
		["role", "Role"],
		["requiredSkills", "Required skills"],
		["requestedSkills", "Requested skills"],
		["total", "Managed total"],
		["availableNotLoaded", "Available, not injected"],
	]) {
		const before =
			key === "availableNotLoaded"
				? pinned.diagnostics[key]
				: pinned.diagnostics.managed[key];
		const after =
			key === "availableNotLoaded"
				? current.diagnostics[key]
				: current.diagnostics.managed[key];
		const row = element("tr");
		row.append(
			element("th", title),
			element("td", bytes(before.bytes)),
			element("td", bytes(after.bytes)),
			element(
				"td",
				`${after.bytes > before.bytes ? "+" : ""}${bytes(after.bytes - before.bytes)}`,
			),
		);
		rows.append(row);
	}
}

/** Settings from api/config when the server allows edits; null when read-only. */
/** @type {{revision: string, profiles: string[]} | null} */
let editing = null;

/** @param {HTMLElement} card @param {string} id */
function appendRemove(card, id) {
	if (!editing || !current) return;
	const button = element("button", `Remove ${id} from ${current.role}`);
	/** @type {HTMLButtonElement} */ (button).type = "button";
	const roleId = current.role;
	button.addEventListener("click", () =>
		editConfig(
			{ action: "remove-skill", role: roleId, skill: id },
			`${id} removed from ${roleId}`,
		),
	);
	card.append(button);
}

/**
 * Send one edit, then reload configuration and the library so the page shows what was written.
 * @param {any} edit @param {string} done @param {() => void} [after]
 */
async function editConfig(edit, done, after) {
	if (!editing) return;
	byId("error").hidden = true;
	byId("status").textContent = "Saving…";
	try {
		const response = await fetch("api/edit", {
			method: "POST",
			cache: "no-store",
			headers: {
				"Content-Type": "application/json",
				"X-Agent-Profiles-Edit": "1",
			},
			body: JSON.stringify({ revision: editing.revision, edit }),
		});
		const data = await response.json();
		if (!response.ok)
			throw new Error(data.error ?? `Edit failed (${response.status})`);
		await initialize();
		after?.();
		if (catalog.length) await loadLibrary();
		byId("notice").textContent =
			`${done}. Written to ${data.file} (${data.layer} configuration); locks refreshed.`;
		byId("notice").hidden = false;
	} catch (error) {
		byId("error").textContent =
			error instanceof Error ? error.message : String(error);
		byId("error").hidden = false;
		byId("status").textContent = "The edit was not saved.";
	}
}

/** @param {any} result */
function render(result) {
	current = result;
	const { managed, availableNotLoaded } = result.diagnostics;
	byId("total").textContent = bytes(managed.total.bytes);
	byId("total-chars").textContent =
		`${managed.total.characters.toLocaleString("en-US")} characters · ${managed.total.files} instruction entries`;
	byId("available-total").textContent = bytes(availableNotLoaded.bytes);
	byId("routing").textContent =
		`${result.host ?? "Unspecified host"} / ${result.model ?? "Unspecified model"} → ${result.profile} (matched by ${result.matchedBy}${result.matchedBy.startsWith("family") ? `: ${result.family}` : result.matchedBy === "alias" ? ` of ${result.identity.canonical}` : ""}) · Role: ${result.role}`;
	const layers = byId("layers");
	layers.replaceChildren();
	for (const kind of ["profile", "role"]) {
		const layer = element("div", "", "layer");
		layer.append(
			element(
				"h3",
				kind === "profile" ? "01 / Model profile" : "02 / Assigned role",
			),
		);
		for (const entry of result.loaded.filter(
			(/** @type {any} */ item) => item.kind === kind,
		)) {
			const card = element("div", "", "entry");
			card.append(
				inspect(
					entry,
					kind === "profile"
						? `Selected by ${result.matchedBy} routing`
						: `Active role: ${result.role}`,
				),
			);
			layer.append(card);
		}
		layers.append(layer);
	}
	for (const entry of result.loaded.filter((/** @type {any} */ item) =>
		["dependency", "workflow"].includes(item.kind),
	)) {
		const card = element("div", "", "entry");
		card.append(
			inspect(
				entry,
				`${entry.kind === "workflow" ? "Workflow companion" : "Dependency"} for ${entry.owner}`,
			),
		);
		layers.append(card);
	}
	const required = byId("required");
	required.replaceChildren(element("p", size(managed.requiredSkills), "muted"));
	for (const entry of result.loaded.filter(
		(/** @type {any} */ item) => item.kind === "required-skill",
	)) {
		const card = element("div", "", "entry");
		card.append(inspect(entry, `Required by role: ${result.role}`));
		appendRemove(card, entry.id);
		required.append(card);
	}
	for (const entry of result.required.filter(
		(/** @type {any} */ item) => item.type === "host",
	)) {
		const card = element("div", "", "entry");
		card.append(
			inspect(
				entry,
				`Required by role ${result.role}; ${entry.package ? "invocation unverified" : "invoked through the host"}`,
			),
		);
		appendRemove(card, entry.id);
		required.append(card);
	}
	if (!result.required.length)
		required.append(element("p", "No required skills.", "muted"));
	const available = byId("available");
	available.replaceChildren(
		element("p", `Requested: ${size(managed.requestedSkills)}`, "muted"),
	);
	for (const entry of result.available) {
		if (entry.type === "host") {
			const card = element("div", "", "entry");
			card.append(
				inspect(
					entry,
					`Available to role ${result.role}; ${entry.package ? "invocation unverified" : "invoked through the host"}, never injected`,
				),
			);
			appendRemove(card, entry.id);
			available.append(card);
			continue;
		}
		const loaded = result.loaded.find(
			(/** @type {any} */ item) =>
				item.kind === "requested-skill" && item.id === entry.id,
		);
		const shared =
			!loaded &&
			entry.package &&
			result.requestedSkills?.includes(entry.id) &&
			result.loaded.find(
				(/** @type {any} */ part) =>
					part.package?.name === entry.package.name &&
					part.package.version === entry.package.version &&
					part.package.sha256 === entry.package.sha256 &&
					part.package.revisionDigest === entry.package.revisionDigest &&
					part.backing.path === entry.backing.path,
			);
		const injected = Boolean(loaded || shared);
		const card = element("div", "", `entry${injected ? " requested" : ""}`);
		const label = document.createElement("label");
		const checkbox = document.createElement("input");
		checkbox.type = "checkbox";
		checkbox.id = `skill-${entry.id}`;
		checkbox.checked = injected;
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) requested.add(entry.id);
			else requested.delete(entry.id);
			update(checkbox.id);
		});
		label.append(
			checkbox,
			document.createTextNode(
				`${entry.id} · ${injected ? "Requested, injected" : "Available, not injected"}`,
			),
		);
		card.append(
			label,
			inspect(
				shared
					? { ...entry, binding: entry.package.binding }
					: (loaded ?? entry),
				`${injected ? "Requested for" : "Available to"} role: ${result.role}${shared ? "; shares already injected backing" : ""}`,
			),
		);
		appendRemove(card, entry.id);
		available.append(card);
	}
	if (!result.available.length)
		available.append(
			element("p", "No on-demand skills for this role.", "muted"),
		);
	compare();
}

/** @param {unknown} error */
function failure(error) {
	current = undefined;
	pin.disabled = true;
	byId("error").textContent =
		error instanceof Error ? error.message : String(error);
	byId("error").hidden = false;
	byId("view").hidden = true;
	byId("status").textContent =
		"Unable to resolve. Fix the configuration or change the selection, then use Refresh files to retry.";
}

/** @param {string} [focusId] */
async function update(focusId) {
	const number = ++requestNumber;
	pin.disabled = true;
	byId("view").setAttribute("aria-busy", "true");
	byId("error").hidden = true;
	byId("status").textContent = "Resolving selected instructions…";
	const query = new URLSearchParams();
	for (const [key, value] of [
		["host", host.value],
		["model", model.value],
		["family", family.value],
		["role", role.value],
	])
		if (value) query.set(key, value);
	for (const skill of requested) query.append("skill", skill);
	try {
		const result = await get(`api/resolve?${query}`);
		if (number !== requestNumber) return;
		render(result);
		byId("view").hidden = false;
		byId("status").textContent =
			`Resolved ${result.role} / ${result.profile}. Temporary skill selections do not change files.`;
		// The focused checkbox may be gone after re-rendering; that is not an error.
		if (focusId) document.getElementById(focusId)?.focus();
	} catch (error) {
		if (number === requestNumber) failure(error);
	} finally {
		if (number === requestNumber) {
			pin.disabled = !current;
			byId("view").removeAttribute("aria-busy");
		}
	}
}

async function initialize(first = false) {
	const number = ++requestNumber;
	const refresh = /** @type {HTMLButtonElement} */ (byId("refresh"));
	for (const control of [host, model, family, role, refresh])
		control.disabled = true;
	try {
		const data = await get("api/config");
		if (number !== requestNumber) return;
		first = first || !initialized;
		const selection = first
			? data.initial
			: {
					host: host.value,
					model: model.value,
					family: family.value,
					role: role.value,
				};
		/** @type {string[]} */
		const notices = [];
		for (const [key, choices, fallback] of [
			["host", data.hosts ?? [], ""],
			["model", data.models, ""],
			["family", data.families, ""],
			["role", data.roles, data.defaultRole ?? data.roles[0]],
		]) {
			if (
				first &&
				["model", "family"].includes(key) &&
				selection[key] &&
				!choices.includes(selection[key])
			)
				launchFallbacks[key] = selection[key];
			if (
				selection[key] &&
				!choices.includes(selection[key]) &&
				selection[key] !== launchFallbacks[key]
			) {
				notices.push(
					`${key} ${selection[key]} is no longer available; using ${fallback || "unspecified"}.`,
				);
				selection[key] = fallback;
			}
		}
		const nextRequested = new Set(first ? data.initial.skills : requested);
		const available = data.optionalSkills?.[selection.role];
		for (const skill of nextRequested)
			if (available && !available.includes(skill)) {
				nextRequested.delete(skill);
				notices.push(
					`Optional skill ${skill} is no longer available for ${selection.role}; removed from this preview.`,
				);
			}
		const query = new URLSearchParams();
		for (const key of ["host", "model", "family", "role"])
			if (selection[key]) query.set(key, selection[key]);
		for (const skill of nextRequested) query.append("skill", skill);
		const result = await get(`api/resolve?${query}`);
		if (number !== requestNumber) return;
		initialized = true;
		options(host, data.hosts ?? [], "Unspecified host", selection.host);
		options(
			model,
			data.models,
			"Unspecified model (use fallback)",
			selection.model,
		);
		options(family, data.families, "No family fallback", selection.family);
		options(role, data.roles, null, selection.role);
		requested = nextRequested;
		roles = data.roles;
		editing = data.editing ?? null;
		byId("mode-badge").textContent = editing
			? "LOCAL · EDITS ON"
			: "LOCAL · READ ONLY";
		byId("edit-panel").hidden = !editing;
		byId("add-column").hidden = !editing;
		if (editing)
			options(
				addProfile,
				editing.profiles,
				null,
				addProfile.value || editing.profiles[0],
			);
		byId("notice").textContent = notices.join(" ");
		byId("notice").hidden = !notices.length;
		render(result);
		byId("view").hidden = false;
		byId("error").hidden = true;
		pin.disabled = false;
		byId("status").textContent =
			`Resolved ${result.role} / ${result.profile}. Use Refresh files after editing configuration or instructions. Temporary skill selections do not change files.`;
	} catch (error) {
		if (number === requestNumber) failure(error);
	} finally {
		if (number === requestNumber)
			for (const control of [host, model, family, role, refresh])
				control.disabled = false;
	}
}

// Skill library (#119): loaded on request, read-only; previews reuse api/resolve.
/** @type {any[]} */
let catalog = [];
const search = /** @type {HTMLInputElement} */ (byId("library-search"));
const filter = /** @type {HTMLSelectElement} */ (byId("library-filter"));
const left = /** @type {HTMLSelectElement} */ (byId("compare-left"));
const right = /** @type {HTMLSelectElement} */ (byId("compare-right"));
// Abbreviated digests carry an explicit marker; the full value stays in the side view.
/** @param {string | null} digest */
const shortDigest = (digest) =>
	digest ? `sha256:${digest.slice(0, 12)}…` : "unavailable";

/** @param {any} use */
const usageText = (use) =>
	`${use.role} (${use.list === "required" ? "required" : "available, not loaded"})`;

/** One catalog row per verified or unverified package version and per local skill. */
/** @param {any} data */
function catalogEntries(data) {
	return [
		...data.packages.flatMap((/** @type {any} */ item) =>
			item.versions.map((/** @type {any} */ version) => ({
				kind: "package",
				selector: `package:${item.name}@${version.version}`,
				name: item.name,
				version: version.version,
				source: version.error
					? `unverified: ${version.error}`
					: `library ${version.source}`,
				description: version.description ?? "",
				digest: version.sha256 ?? null,
				uses: (version.usage?.roles ?? []).map((/** @type {any} */ use) => ({
					...use,
					id: use.skill,
				})),
				evidence: version.evidence
					? `${version.evidence} evidence row(s)`
					: "untested",
				selectable: !version.error,
				// The configured skill ID a role can list; null until the version is bound.
				skillId:
					(version.usage?.bindings ?? [])
						.map(
							(/** @type {string} */ entry) =>
								/(?:^|\.)skills\.([^.]+)$/.exec(entry)?.[1],
						)
						.find(Boolean) ?? null,
			})),
		),
		...data.local.map((/** @type {any} */ skill) => ({
			kind: "local",
			selector: `local:${skill.path}`,
			name: skill.id,
			version: null,
			source: `project-local · ${skill.path}`,
			description: skill.description ?? "",
			digest: null,
			uses: skill.usage.roles.map((/** @type {any} */ use) => ({
				...use,
				id: skill.id,
			})),
			evidence: "untested",
			selectable: true,
			// Host-native project skills need a host reference, not a plain ID.
			skillId: skill.host ? null : skill.id,
		})),
	];
}

/** @param {any} entry */
const entryLabel = (entry) =>
	`${entry.name}@${entry.version ?? "unversioned"} (${entry.kind === "local" ? "project-local" : "library"})`;

/** Switch the resolution view to a role that lists the skill; nothing is written. */
/** @param {any} use */
function preview(use) {
	if (!roles.includes(use.role)) {
		byId("library-status").textContent =
			`Role ${use.role} is not in the current configuration; use Refresh files.`;
		return;
	}
	role.value = use.role;
	requested = new Set(use.list === "available" ? [use.id] : []);
	update();
	byId("library-status").textContent =
		`Previewing role ${use.role} with the current configuration. Pins and files are unchanged.`;
}

/** Add-to-role buttons for the role selected at the top; required or available is chosen per click. */
/** @param {any} entry */
function addCell(entry) {
	const cell = element("td");
	if (!entry.skillId) {
		cell.textContent =
			entry.kind === "package"
				? "Not bound in this project yet"
				: "Host skill: add through configure";
		return cell;
	}
	for (const list of ["required", "available"]) {
		const button = element("button", `Add to ${role.value} as ${list}`);
		/** @type {HTMLButtonElement} */ (button).type = "button";
		button.addEventListener("click", () =>
			editConfig(
				{ action: "add-skill", role: role.value, skill: entry.skillId, list },
				`${entry.skillId} added to ${role.value} as ${list}`,
			),
		);
		cell.append(button);
	}
	return cell;
}

function renderCatalog() {
	const needle = search.value.trim().toLowerCase();
	const rows = byId("library-rows");
	rows.replaceChildren();
	const shown = catalog.filter(
		(entry) =>
			(!filter.value ||
				(filter.value === "used"
					? entry.uses.length
					: entry.kind === filter.value)) &&
			(!needle ||
				`${entry.name} ${entry.description}`.toLowerCase().includes(needle)),
	);
	for (const entry of shown) {
		const row = element("tr");
		const name = element("th", entry.name);
		if (entry.description)
			name.append(element("small", ` ${entry.description}`, "muted"));
		const used = element("td", entry.uses.length ? "" : "Not used by a role");
		for (const use of entry.uses) {
			const button = element("button", `Preview ${usageText(use)}`);
			/** @type {HTMLButtonElement} */ (button).type = "button";
			button.addEventListener("click", () => preview(use));
			used.append(button);
		}
		row.append(
			name,
			element(
				"td",
				`${entry.version ?? "unknown version (local, unversioned)"} · ${entry.source}`,
			),
			element("td", shortDigest(entry.digest)),
			used,
			element("td", entry.evidence),
		);
		const pick = element("td", entry.selectable ? "" : "Unverified");
		if (entry.selectable)
			for (const [select, side] of [
				[left, "left"],
				[right, "right"],
			]) {
				const button = element("button", `Set as ${side}`);
				/** @type {HTMLButtonElement} */ (button).type = "button";
				button.addEventListener("click", () => {
					/** @type {HTMLSelectElement} */ (select).value = entry.selector;
					byId("library-status").textContent =
						`Compare ${side}: ${entryLabel(entry)}. Select Compare skills when both sides are set.`;
				});
				pick.append(button);
			}
		row.append(pick);
		if (editing) row.append(addCell(entry));
		rows.append(row);
	}
	if (!shown.length)
		rows.append(element("tr", "No skills match this search.", "muted"));
	byId("library-status").textContent =
		`Showing ${shown.length} of ${catalog.length} skill entries.`;
}

async function loadLibrary() {
	const load = /** @type {HTMLButtonElement} */ (byId("library-load"));
	load.disabled = true;
	byId("library-error").hidden = true;
	byId("library-status").textContent = "Loading skill library…";
	try {
		const data = await get("api/skills");
		catalog = catalogEntries(data);
		const choices = catalog.filter((entry) => entry.selectable);
		// Keep a still-valid selection; otherwise default to the first two entries.
		const keep = (/** @type {string} */ value, /** @type {number} */ index) =>
			choices.some((entry) => entry.selector === value)
				? value
				: (choices[index] ?? choices[0])?.selector;
		/** @type {[HTMLSelectElement, string | undefined][]} */
		const selects = [
			[left, keep(left.value, 0)],
			[right, keep(right.value, 1)],
		];
		for (const [select, value] of selects) {
			select.replaceChildren();
			for (const entry of choices)
				select.add(new Option(entryLabel(entry), entry.selector));
			select.value = value ?? "";
		}
		byId("library-view").hidden = false;
		renderCatalog();
		if (data.problems.length)
			byId("library-status").textContent +=
				` Problems: ${data.problems.join("; ")}`;
		load.textContent = "Reload skill library";
	} catch (error) {
		byId("library-error").textContent =
			error instanceof Error ? error.message : String(error);
		byId("library-error").hidden = false;
		byId("library-status").textContent = "";
	} finally {
		load.disabled = false;
	}
}

/** @param {string} id @param {any} side */
function renderSide(id, side) {
	const box = byId(id);
	box.replaceChildren(
		element("h3", `${side.name}@${side.version ?? "unversioned"}`),
	);
	const facts = [
		["Kind", side.kind === "local" ? "Project-local skill" : "Library package"],
		[
			"Version",
			side.version ?? "Unknown: local skills have no package version",
		],
		["SHA-256", side.sha256 ?? "Unavailable for local skills"],
		["Revision", side.revisionDigest ?? "None"],
		["Source", side.path ?? side.source ?? "Unknown"],
		["Description", side.metadata.description ?? "None declared"],
		[
			"Used by",
			side.usage.roles.length
				? side.usage.roles.map(usageText).join(", ")
				: "Not used by a role",
		],
		[
			"Evidence",
			side.evidence.status === "untested"
				? "Untested: no evaluation evidence is recorded (not a compatibility claim)"
				: side.evidence.rows
						.map(
							(/** @type {any} */ row) =>
								`${row.assignment.role} × ${row.assignment.model} × ${row.assignment.host}: ${row.outcome}`,
						)
						.join("; "),
		],
	];
	const list = element("dl");
	for (const [term, value] of facts)
		list.append(element("dt", term), element("dd", value));
	const files = element("ul");
	for (const file of side.files)
		files.append(
			element(
				"li",
				`${file.path} · ${bytes(file.bytes)} · ${file.binary ? "binary" : "text"} · ${shortDigest(file.sha256)}`,
			),
		);
	box.append(list, element("p", "Files", "eyebrow"), files);
}

/** @type {any} The last comparison, re-rendered when the view mode changes. */
let compared;
const view = /** @type {HTMLSelectElement} */ (byId("compare-view"));

/** @param {[number, string] | null} cell @param {string} kind */
function sideCells(cell, kind) {
	return cell
		? [
				element("td", String(cell[0]), "line-number"),
				element("td", cell[1], kind),
			]
		: [element("td", "", "line-number"), element("td", "", "empty")];
}

function renderDiff() {
	const diffs = byId("diff-files");
	diffs.replaceChildren();
	if (!compared) return;
	if (view.value !== "side") {
		if (compared.identical)
			diffs.append(element("p", "No file differences.", "muted"));
		for (const file of compared.files) {
			const details = document.createElement("details");
			details.append(
				element("summary", `${file.status} · ${file.path}`),
				file.diff === null
					? element("p", "Binary file: contents not shown.", "muted")
					: element("pre", file.diff),
			);
			diffs.append(details);
		}
		return;
	}
	// Side by side: every file and every line of both sides, unchanged files included.
	for (const file of compared.aligned) {
		const details = /** @type {HTMLDetailsElement} */ (
			document.createElement("details")
		);
		details.open = file.status !== "same";
		details.append(element("summary", `${file.status} · ${file.path}`));
		if (file.rows === null)
			details.append(element("p", "Binary file: contents not shown.", "muted"));
		else {
			const table = element("table", "", "side-by-side");
			const body = element("tbody");
			for (const row of file.rows) {
				const line = element("tr", "", row.kind);
				line.append(
					...sideCells(row.left, row.kind === "same" ? "" : "before"),
					...sideCells(row.right, row.kind === "same" ? "" : "after"),
				);
				body.append(line);
			}
			table.append(body);
			const scroll = element("div", "", "table-scroll");
			scroll.append(table);
			details.append(scroll);
		}
		diffs.append(details);
	}
}

async function compareSkills() {
	const button = /** @type {HTMLButtonElement} */ (byId("compare-run"));
	button.disabled = true;
	byId("library-error").hidden = true;
	try {
		const query = new URLSearchParams({ left: left.value, right: right.value });
		const result = await get(`api/compare?${query}`);
		renderSide("side-left", result.left);
		renderSide("side-right", result.right);
		compared = result;
		renderDiff();
		byId("skill-diff").hidden = false;
	} catch (error) {
		byId("library-error").textContent =
			error instanceof Error ? error.message : String(error);
		byId("library-error").hidden = false;
	} finally {
		button.disabled = false;
	}
}

// Add a model, family or role, then select it so its resolution is shown.
function showAddFields() {
	byId("add-profile-label").hidden = addKind.value === "role";
	byId("add-prefixes-label").hidden = addKind.value !== "family";
	byId("add-description-label").hidden = addKind.value !== "role";
}
addKind.addEventListener("change", showAddFields);
showAddFields();
byId("add-form").addEventListener("submit", (event) => event.preventDefault());
byId("add-run").addEventListener("click", () => {
	const kind = addKind.value;
	const id = addId.value.trim();
	if (!id) {
		byId("status").textContent = "Enter an ID to add.";
		return;
	}
	const prefixes = /** @type {HTMLInputElement} */ (byId("add-prefixes")).value
		.split(",")
		.map((prefix) => prefix.trim())
		.filter(Boolean);
	const description = /** @type {HTMLInputElement} */ (
		byId("add-description")
	).value.trim();
	const select = kind === "model" ? model : kind === "family" ? family : role;
	editConfig(
		kind === "role"
			? { action: "add-role", id, ...(description ? { description } : {}) }
			: {
					action: `add-${kind}`,
					id,
					profile: addProfile.value,
					...(kind === "family" && prefixes.length ? { prefixes } : {}),
				},
		`${kind} ${id} added`,
		() => {
			select.value = id;
			if (kind === "role") requested.clear();
			addId.value = "";
			update();
		},
	);
});

byId("library-load").addEventListener("click", () => loadLibrary());
byId("library-filters").addEventListener("submit", (event) =>
	event.preventDefault(),
);
search.addEventListener("input", () => renderCatalog());
filter.addEventListener("change", () => renderCatalog());
byId("compare-run").addEventListener("click", () => compareSkills());
view.addEventListener("change", () => renderDiff());
byId("selectors").addEventListener("submit", (event) => event.preventDefault());
model.addEventListener("change", () => update());
host.addEventListener("change", () => update());
family.addEventListener("change", () => update());
role.addEventListener("change", () => {
	requested.clear();
	// Add-to-role buttons name the selected role.
	if (editing && catalog.length) renderCatalog();
	update();
});
byId("refresh").addEventListener("click", () => initialize());
pin.addEventListener("click", () => {
	pinned = current;
	compare();
});
byId("clear").addEventListener("click", () => {
	pinned = undefined;
	compare();
});
initialize(true);
