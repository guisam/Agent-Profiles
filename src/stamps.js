import { createHash, randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { errorCode, errorMessage } from "./files.ts";
import { integrations } from "./integrations.js";
import {
	publish,
	readStoreFile,
	rootPath,
	safePath,
	sameStat,
	statOrNull,
	storeRoot,
	verifyObject,
	writeFlushed,
} from "./package-store.js";
import {
	canonicalJSON,
	hashRecord,
	parseManifest,
	parseRecord,
	validateMembers,
} from "./packages.js";
import {
	identifier,
	parseYaml,
	resolveCandidateCapture,
	resolveCapture,
	skillMetadata,
	validatePackageBindings,
} from "./resolve.js";
import { readRevisionRecord } from "./revisions.js";

const DOMAIN = "agent-profiles/stamp/v1";
const stampDomain = (s) =>
	s?.stampVersion === 2 ? "agent-profiles/stamp/v2" : DOMAIN;
const pinKey = (p) => `${p.name}@${p.version}:${p.sha256}:${p.revisionDigest}`;
const CONFIG = ".agent-profiles/agents.yaml";
const LOCK = ".agent-profiles/agent-profiles.lock";
const compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => canonicalJSON(a).equals(canonicalJSON(b));
const key = (p) => `${p.name}@${p.version}`;
const packageOrder = (a, b) =>
	compare(a.name, b.name) ||
	compare(a.version, b.version) ||
	compare(a.sha256, b.sha256);
const inventory = {
	managed: "selected-required-and-available",
	host: "unobserved",
	exclusiveVisibility: "unverified",
};
const coverage = {
	localResources: "declared-only",
	hostContext: "unobserved",
	runtimeModel: "unverified",
	renderedPrompt: "unverified",
};
const hosts = integrations.map((adapter) => adapter.id);

function fail(location, message) {
	throw new Error(`${location}: ${message}`);
}
function object(value, location) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(location, "expected an object");
}
function fields(value, location, keys) {
	object(value, location);
	for (const k of Object.keys(value))
		if (!keys.includes(k)) fail(`${location}.${k}`, "unknown field");
	for (const k of keys)
		if (!Object.hasOwn(value, k))
			fail(`${location}.${k}`, "required field is missing");
}
function options(value, keys) {
	object(value, "options");
	for (const k of Object.keys(value))
		if (!keys.includes(k)) fail(k, "unknown option");
}
function text(value, location) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		fail(location, "expected a nonempty string without NUL");
}
function digest(value, location = "digest") {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
		fail(location, "expected 64 lowercase hexadecimal characters");
}
function portable(value) {
	validateMembers([{ path: value, type: "file", nlink: 1 }]);
}
function list(value, location) {
	if (!Array.isArray(value)) fail(location, "expected an array");
}
function unique(values, location) {
	if (new Set(values).size !== values.length) fail(location, "duplicate entry");
}
function host(value, nullable = false) {
	if (!(nullable && value === null) && !hosts.includes(value))
		fail("host", "unknown host");
}
function identity(p, location) {
	if (
		typeof p.name !== "string" ||
		!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(p.name)
	)
		fail(location, "expected package @namespace/name");
	if (
		typeof p.version !== "string" ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(p.version) ||
		p.version.split(".").some((n) => !Number.isSafeInteger(Number(n)))
	)
		fail(location, "expected exact safe release version");
	digest(p.sha256);
}
function backing(b, location) {
	object(b, `${location}.backing`);
	fields(
		b,
		`${location}.backing`,
		b.type === "blob"
			? ["type", "sha256", "bytes", "path"]
			: ["type", "sha256", "path"],
	);
	if (!["blob", "package"].includes(b.type))
		fail(location, "unknown backing type");
	digest(b.sha256);
	portable(b.path);
	if (b.type === "blob" && (!Number.isSafeInteger(b.bytes) || b.bytes < 0))
		fail(location, "invalid blob bytes length");
}

function validateSelection(s) {
	const sel = s.selection;
	fields(sel, "selection", [
		"host",
		"identity",
		"family",
		"familySource",
		"profile",
		"role",
		"roleSource",
	]);
	host(sel.host, true);
	identifier(sel.profile, "selection.profile");
	identifier(sel.role, "selection.role");
	if (!["default", "assigned"].includes(sel.roleSource))
		fail("roleSource", "invalid role provenance");
	if (sel.family !== null) text(sel.family, "family");
	if (
		![null, "supplied", "configured-prefix"].includes(sel.familySource) ||
		(sel.family === null) !== (sel.familySource === null)
	)
		fail("familySource", "inconsistent family provenance");
	const id = sel.identity;
	fields(id, "identity", ["raw", "canonical", "source", "matchedBy"]);
	for (const k of ["raw", "canonical"])
		if (id[k] !== null) text(id[k], `identity.${k}`);
	if (
		![null, "host", "host-stated", "user"].includes(id.source) ||
		(id.raw === null && id.source !== null)
	)
		fail("identity.source", "invalid provenance");
	if (
		!["model", "alias", "family", "family-prefix", "default"].includes(
			id.matchedBy,
		) ||
		["model", "alias"].includes(id.matchedBy) !== (id.canonical !== null) ||
		(id.matchedBy === "model" && id.raw !== id.canonical) ||
		(id.matchedBy === "alias" &&
			(id.raw === null || id.raw === id.canonical)) ||
		(id.matchedBy.startsWith("family") && sel.family === null) ||
		(id.matchedBy === "family-prefix" &&
			(id.raw === null || sel.familySource !== "configured-prefix"))
	)
		fail("identity.matchedBy", "inconsistent routing provenance");
	return sel;
}

function validateObservations(s, skills, packages) {
	const sel = s.selection;
	unique(
		s.shared.map((e) => e.path),
		"shared",
	);
	for (const e of s.shared) {
		fields(e, "shared", ["path", "status", "backing", "delivery"]);
		portable(e.path);
		if (
			!["captured", "absent", "unobserved"].includes(e.status) ||
			e.delivery !== "host-controlled"
		)
			fail("shared", "invalid observation");
		if (e.status === "captured") {
			backing(e.backing, "shared");
			if (e.backing.type !== "blob" || e.backing.path !== e.path)
				fail("shared", "captured backing path mismatch");
		} else if (e.backing !== null)
			fail("shared", "unobserved/absent backing must be null");
	}
	unique(
		s.hostReferences.map((e) => e.key),
		"hostReferences",
	);
	const native = [...skills.values()].filter((e) => e.type === "host");
	if (s.hostReferences.length !== native.length)
		fail("hostReferences", "native closure mismatch");
	for (const [i, e] of s.hostReferences.entries()) {
		fields(e, "hostReferences", [
			"key",
			"id",
			"host",
			"scope",
			"hostId",
			"requirement",
			"compatibility",
			"observation",
			"backing",
			"invocation",
			"rendered",
			"supportedHosts",
		]);
		const skill = native[i];
		if (
			e.key !== skill.hostReference ||
			e.id !== skill.id ||
			e.requirement !==
				(s.required.includes(skill) ? "required" : "available") ||
			!equal(e.backing, skill.backing)
		)
			fail("hostReferences", "native association/backing/order mismatch");
		list(e.supportedHosts, "supportedHosts");
		unique(e.supportedHosts, "supportedHosts");
		e.supportedHosts.forEach((v) => {
			host(v);
		});
		if (e.scope === "package") {
			if (
				!skill.package ||
				e.hostId !== null ||
				e.host !== sel.host ||
				!equal(
					e.supportedHosts,
					packages.get(key(skill.package)).behavior.hosts,
				)
			)
				fail("hostReferences", "package native host relation mismatch");
		} else {
			host(e.host);
			const adapter = integrations.find((a) => a.id === e.host);
			if (
				skill.package !== null ||
				!["project", "user", "plugin"].includes(e.scope) ||
				typeof e.hostId !== "string" ||
				!adapter.skills?.[e.scope]?.id.test(e.hostId) ||
				!equal(e.supportedHosts, [e.host])
			)
				fail("hostReferences", "invalid native scope/identifier");
			if (
				e.scope === "project" &&
				e.backing?.path !== adapter.skills.project.path(e.hostId)
			)
				fail("hostReferences", "project native path mismatch");
		}
		const captured = ["project", "package"].includes(e.scope);
		if (
			e.observation !==
				(captured ? "captured-file" : "host-provided-unverified") ||
			(e.backing !== null) !== captured ||
			e.compatibility !==
				(sel.host === null ? null : e.supportedHosts.includes(sel.host)) ||
			e.invocation !== "unverified" ||
			e.rendered !== "unverified"
		)
			fail(
				"hostReferences",
				"compatibility/observation/invocation relation mismatch",
			);
	}
	const paths = allBackings(s)
		.filter((b) => b.type === "blob")
		.map((b) => b.path);
	validateMembers(
		[...new Set(paths)].map((p) => ({ path: p, type: "file", nlink: 1 })),
	);
}

const pinOrder = (a, b) =>
	packageOrder(a, b) || compare(a.revisionDigest ?? "", b.revisionDigest ?? "");
const actorKey = (assignment) =>
	JSON.stringify([assignment.role, assignment.model, assignment.host]);
function bindingName(value) {
	if (
		typeof value !== "string" ||
		!/^(profiles|roles|skills)\.[a-z0-9][a-z0-9-]*$/.test(value)
	)
		fail("binding", "invalid binding");
}
function pin(p, location) {
	fields(p, location, ["name", "version", "sha256", "revisionDigest"]);
	identity(p, location);
	if (p.revisionDigest !== null) digest(p.revisionDigest, location);
}
function descriptor(p, context) {
	fields(p, "package", [
		"binding",
		"name",
		"version",
		"sha256",
		"revisionDigest",
		"selectedBy",
		"selectors",
	]);
	identity(p, "package");
	bindingName(p.binding);
	if (p.revisionDigest !== null) digest(p.revisionDigest, "revisionDigest");
	identifier(p.selectedBy, "selectedBy");
	object(p.selectors, "selectors");
	for (const [name, value] of Object.entries(p.selectors)) {
		if (
			!Object.hasOwn(context, name) ||
			value === null ||
			context[name] !== value
		)
			fail("snapshot relation selector", name);
	}
	if (p.selectedBy === "binding-default" && Object.keys(p.selectors).length)
		fail("selectors", "binding-default must have no selectors");
}
function validateSnapshot(s) {
	return s?.stampVersion === 2 ? validateSnapshot2(s) : validateSnapshot1(s);
}
function validateSnapshot2(s) {
	fields(s, "snapshot", [
		"stampVersion",
		"configurationVersion",
		"resolverContract",
		"selection",
		"requested",
		"composition",
		"required",
		"available",
		"packages",
		"shared",
		"hostReferences",
		"inventory",
		"coverage",
		"capture",
		"workflowPeers",
		"revisions",
		"selectionBindings",
		"workflowActors",
	]);
	if (
		s.configurationVersion !== 3 ||
		s.resolverContract !== "agent-profiles/resolver/v3"
	)
		fail("resolverContract", "unsupported snapshot/configurationVersion");
	if (!equal(s.capture, { kind: "active", migration: null, candidate: null })) {
		fields(s.capture, "capture", ["kind", "migration", "candidate"]);
		if (
			s.capture.kind !== "candidate" ||
			typeof s.capture.migration !== "string" ||
			!/^migration-[a-f0-9-]{36}$/.test(s.capture.migration)
		)
			fail("capture", "expected active or typed candidate capture");
		digest(s.capture.candidate, "capture.candidate");
	}
	if (!equal(s.inventory, inventory) || !equal(s.coverage, coverage))
		fail("coverage", "unverified host/runtime coverage required");
	const sel = validateSelection(s),
		context = {
			role: sel.role,
			profile: sel.profile,
			model: sel.identity.canonical,
			host: sel.host,
		};
	for (const name of [
		"requested",
		"composition",
		"required",
		"available",
		"packages",
		"shared",
		"hostReferences",
		"workflowPeers",
		"revisions",
		"selectionBindings",
		"workflowActors",
	])
		list(s[name], name);
	s.requested.forEach((value) => {
		identifier(value, "requested");
	});
	unique(s.requested, "requested");
	const packages = new Map();
	for (const p of s.packages) {
		fields(p, "packages", [
			"name",
			"version",
			"sha256",
			"revisionDigest",
			"behavior",
		]);
		identity(p, "packages");
		if (p.revisionDigest !== null) digest(p.revisionDigest);
		fields(p.behavior, "behavior", ["delivery", "hosts", "effects"]);
		for (const name of ["hosts", "effects"]) {
			list(p.behavior[name], name);
			unique(p.behavior[name], name);
		}
		p.behavior.hosts.forEach((value) => {
			host(value);
		});
		if (
			!["native", "instruction"].includes(p.behavior.delivery) ||
			(p.behavior.delivery === "native") !== p.behavior.hosts.length > 0 ||
			p.behavior.effects.some(
				(value) =>
					![
						"commands",
						"substitution",
						"external-references",
						"host-configuration",
					].includes(value),
			)
		)
			fail("behavior", "invalid package behavior");
		if (packages.has(key(p)) && packages.get(key(p)).sha256 !== p.sha256)
			fail("packages", "conflicting immutable identity");
		packages.set(key(p), p);
	}
	for (let i = 1; i < s.packages.length; i++)
		if (pinOrder(s.packages[i - 1], s.packages[i]) >= 0)
			fail("packages", "expected sorted unique pins");
	const pins = new Set(s.packages.map(pinKey));
	const checkPin = (p) => {
		if (!pins.has(pinKey(p)))
			fail("snapshot relation package", "missing exact inventory pin");
	};
	const entry = (e, binding) => {
		if (e.backing !== null) backing(e.backing, binding);
		else if (e.type !== "host" || e.package !== null)
			fail(binding, "missing backing");
		if (e.package !== null) {
			descriptor(e.package, context);
			checkPin(e.package);
			if (
				e.package.binding !== binding ||
				e.backing?.type !== "package" ||
				e.backing.sha256 !== e.package.sha256
			)
				fail("snapshot relation binding", "backing mismatch");
		} else if (e.backing?.type === "package")
			fail(binding, "missing package provenance");
		list(e.resources, "resources");
		if ((e.package || e.type === "host") && e.resources.length)
			fail("resources", "package/native resources must be empty");
		for (const r of e.resources) {
			fields(r, "resource", ["binding", "backing"]);
			backing(r.backing, "resource");
			if (
				r.binding !== binding ||
				r.backing.type !== "blob" ||
				r.backing.path === e.backing?.path
			)
				fail("resources", "owner/path mismatch");
		}
		for (let i = 1; i < e.resources.length; i++)
			if (
				compare(e.resources[i - 1].backing.path, e.resources[i].backing.path) >=
				0
			)
				fail("resources", "expected sorted unique resources");
	};
	const skills = new Map();
	for (const group of ["required", "available"])
		for (const e of s[group]) {
			fields(e, group, [
				"id",
				"type",
				"delivery",
				"name",
				"nameSource",
				"description",
				"backing",
				"package",
				"resources",
				"hostReference",
			]);
			identifier(e.id, group);
			text(e.name, "name");
			if (
				!["frontmatter", "directory", "host"].includes(e.nameSource) ||
				(e.description !== null && typeof e.description !== "string")
			)
				fail(group, "invalid metadata");
			if (
				!["instruction", "host"].includes(e.type) ||
				e.delivery !== (e.type === "host" ? "invoke" : "inject") ||
				e.hostReference !== (e.type === "host" ? `skills.${e.id}` : null)
			)
				fail(group, "invalid delivery/reference");
			if (skills.has(e.id)) fail(group, "duplicate ID");
			entry(e, `skills.${e.id}`);
			skills.set(e.id, e);
		}
	for (const requested of s.requested)
		if (!skills.has(requested)) fail("requested", "unpermitted skill");
	for (const e of s.composition) {
		fields(e, "composition", [
			"kind",
			"id",
			"backing",
			"package",
			"resources",
			"owner",
		]);
		if (
			![
				"profile",
				"role",
				"required-skill",
				"requested-skill",
				"dependency",
				"workflow",
			].includes(e.kind)
		)
			fail("composition", "invalid kind");
		if (
			e.kind === "dependency" ||
			(e.kind === "workflow" &&
				typeof e.id === "string" &&
				e.id.startsWith("@"))
		)
			text(e.id, "dependency.id");
		else identifier(e.id, "composition.id");
		if (e.owner !== null) bindingName(e.owner);
		const binding =
			e.package?.binding ??
			`${e.kind === "profile" ? "profiles" : e.kind === "role" ? "roles" : "skills"}.${e.id}`;
		entry(e, binding);
	}
	const bindings = (rows, context) => {
		unique(
			rows.map((row) => row.root?.binding),
			"bindings",
		);
		for (const row of rows) {
			fields(row, "binding evidence", ["root", "closure"]);
			descriptor(row.root, context);
			checkPin(row.root);
			list(row.closure, "closure");
			for (const p of row.closure) {
				pin(p, "closure");
				checkPin(p);
			}
			unique(
				row.closure.map((p) => p.name),
				"closure",
			);
			if (
				!row.closure.length ||
				pinKey(row.closure.at(-1)) !== pinKey(row.root)
			)
				fail("snapshot relation closure", "root must be last");
		}
	};
	bindings(s.selectionBindings, context);
	unique(
		s.workflowActors.map((actor) => actorKey(actor.assignment)),
		"workflowActors",
	);
	for (const actor of s.workflowActors) {
		fields(actor, "actor", ["assignment", "profile", "bindings"]);
		fields(actor.assignment, "actor.assignment", ["role", "model", "host"]);
		identifier(actor.assignment.role, "actor.role");
		text(actor.assignment.model, "actor.model");
		host(actor.assignment.host);
		identifier(actor.profile, "actor.profile");
		list(actor.bindings, "actor.bindings");
		bindings(actor.bindings, { ...actor.assignment, profile: actor.profile });
	}
	for (const r of s.revisions) {
		fields(r, "revision catalog", [
			"recordDigest",
			"name",
			"version",
			"sha256",
		]);
		identity(r, "revision catalog");
		digest(r.recordDigest);
	}
	for (let i = 1; i < s.revisions.length; i++)
		if (
			compare(s.revisions[i - 1].recordDigest, s.revisions[i].recordDigest) >= 0
		)
			fail("revisions", "expected sorted unique catalog");
	for (const row of s.workflowPeers) {
		fields(row, "workflow peer", ["protocol", "major", "consumer", "provider"]);
		if (
			typeof row.protocol !== "string" ||
			!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(row.protocol) ||
			!Number.isSafeInteger(row.major) ||
			row.major <= 0
		)
			fail("workflow peer", "invalid protocol/major");
		for (const side of ["consumer", "provider"]) {
			fields(row[side], "workflow peer", [
				"assignment",
				"binding",
				"revisionDigest",
			]);
			fields(row[side].assignment, "workflow assignment", [
				"role",
				"model",
				"host",
			]);
			identifier(row[side].assignment.role, "peer.role");
			text(row[side].assignment.model, "peer.model");
			host(row[side].assignment.host);
			bindingName(row[side].binding);
			digest(row[side].revisionDigest);
		}
	}
	unique(
		s.workflowPeers.map((row) => canonicalJSON(row).toString("hex")),
		"workflowPeers",
	);
	validateObservations(s, skills, packages);
}

function validateSnapshot1(s) {
	fields(s, "snapshot", [
		"stampVersion",
		"configurationVersion",
		"resolverContract",
		"selection",
		"requested",
		"composition",
		"required",
		"available",
		"packages",
		"shared",
		"hostReferences",
		"inventory",
		"coverage",
	]);
	if (
		s.stampVersion !== 1 ||
		![1, 2].includes(s.configurationVersion) ||
		s.resolverContract !== `agent-profiles/resolver/v${s.configurationVersion}`
	)
		fail("resolverContract", "unsupported snapshot/configurationVersion");
	if (!equal(s.inventory, inventory))
		fail(
			"inventory",
			"expected unobserved host and unverified exclusive visibility",
		);
	if (!equal(s.coverage, coverage))
		fail(
			"coverage",
			"expected declared-only resources and unverified runtimeModel/renderedPrompt",
		);
	const sel = validateSelection(s),
		id = sel.identity;
	for (const k of [
		"requested",
		"composition",
		"required",
		"available",
		"packages",
		"shared",
		"hostReferences",
	])
		list(s[k], k);
	s.requested.forEach((v) => {
		identifier(v, "requested");
	});
	unique(s.requested, "requested");
	const packages = new Map();
	for (const p of s.packages) {
		fields(p, "packages", ["name", "version", "sha256", "behavior"]);
		identity(p, "packages");
		fields(p.behavior, "packages.behavior", ["delivery", "hosts", "effects"]);
		if (!["instruction", "native"].includes(p.behavior.delivery))
			fail("packages.behavior", "invalid delivery");
		for (const k of ["hosts", "effects"]) {
			list(p.behavior[k], `behavior.${k}`);
			unique(p.behavior[k], `behavior.${k}`);
		}
		p.behavior.hosts.forEach((v) => {
			host(v);
		});
		if (
			p.behavior.effects.some(
				(v) =>
					![
						"commands",
						"substitution",
						"external-references",
						"host-configuration",
					].includes(v),
			) ||
			(p.behavior.delivery === "native") !== p.behavior.hosts.length > 0
		)
			fail("packages.behavior", "invalid behavior");
		if (packages.has(key(p))) fail("packages", "duplicate revision");
		packages.set(key(p), p);
	}
	for (let i = 1; i < s.packages.length; i++)
		if (packageOrder(s.packages[i - 1], s.packages[i]) >= 0)
			fail("packages", "expected sorted unique revisions");
	const used = new Set();
	const entry = (e, binding, location) => {
		if (e.backing === null) {
			if (e.type !== "host" || e.package !== null)
				fail(location, "missing backing");
		} else backing(e.backing, location);
		if (e.backing?.type === "package") {
			const p = e.package;
			fields(p, `${location}.package`, [
				"binding",
				"name",
				"version",
				"sha256",
				"selectedBy",
				"selectors",
			]);
			identity(p, location);
			if (
				p.binding !== binding ||
				p.sha256 !== e.backing.sha256 ||
				packages.get(key(p))?.sha256 !== p.sha256
			)
				fail(location, "package binding/revision/backing closure mismatch");
			identifier(p.selectedBy, `${location}.selectedBy`);
			object(p.selectors, `${location}.selectors`);
			const context = {
				model: id.canonical,
				role: sel.role,
				profile: sel.profile,
				host: sel.host,
			};
			for (const [k, v] of Object.entries(p.selectors))
				if (!Object.hasOwn(context, k) || v === null || v !== context[k])
					fail(location, `selector ${k} disagrees with selection`);
			if (p.selectedBy === "binding-default" && Object.keys(p.selectors).length)
				fail(location, "binding-default selectors must be empty");
			used.add(key(p));
		} else if (e.package !== null)
			fail(location, "blob backing requires null package provenance");
		list(e.resources, `${location}.resources`);
		if ((e.package !== null || e.type === "host") && e.resources.length)
			fail(location, "package/native resources must be empty");
		for (const r of e.resources) {
			fields(r, `${location}.resources`, ["binding", "backing"]);
			backing(r.backing, "resources");
			if (
				r.binding !== binding ||
				r.backing.type !== "blob" ||
				r.backing.path === e.backing?.path
			)
				fail(location, "resources binding owner/path mismatch");
		}
		for (let i = 1; i < e.resources.length; i++)
			if (
				compare(e.resources[i - 1].backing.path, e.resources[i].backing.path) >=
				0
			)
				fail(location, "resources must be sorted and unique");
	};
	const skills = new Map();
	for (const group of ["required", "available"])
		for (const e of s[group]) {
			fields(e, group, [
				"id",
				"type",
				"delivery",
				"name",
				"nameSource",
				"description",
				"backing",
				"package",
				"resources",
				"hostReference",
			]);
			identifier(e.id, group);
			text(e.name, `${group}.name`);
			if (
				!["frontmatter", "directory", "host"].includes(e.nameSource) ||
				(e.description !== null && typeof e.description !== "string")
			)
				fail(group, "invalid skill metadata");
			if (
				!["instruction", "host"].includes(e.type) ||
				e.delivery !== (e.type === "instruction" ? "inject" : "invoke")
			)
				fail(group, "invalid skill type/delivery");
			if (e.hostReference !== (e.type === "host" ? `skills.${e.id}` : null))
				fail(group, "invalid hostReference");
			if (skills.has(e.id)) fail(group, "duplicate required/available ID");
			entry(e, `skills.${e.id}`, `${group}.${e.id}`);
			skills.set(e.id, e);
		}
	for (const v of s.requested)
		if (!skills.has(v)) fail("requested", `unpermitted skill ${v}`);
	s.composition.forEach((e, i) => {
		fields(e, "composition", ["kind", "id", "backing", "package", "resources"]);
		identifier(e.id, "composition.id");
		if (i < 2) {
			const kind = i === 0 ? "profile" : "role";
			if (e.kind !== kind || e.id !== sel[kind])
				fail("composition", `expected ${kind} in order`);
			entry(
				e,
				`${kind === "profile" ? "profiles" : "roles"}.${e.id}`,
				`composition.${kind}`,
			);
		} else {
			const skill = skills.get(e.id);
			if (
				skill?.type !== "instruction" ||
				!equal(e, {
					kind: e.kind,
					id: skill.id,
					backing: skill.backing,
					package: skill.package,
					resources: skill.resources,
				})
			)
				fail(
					"composition",
					`skill ${e.id} backing/package/resources disagreement or native injection`,
				);
		}
	});
	const wanted = [
		...s.required
			.filter((e) => e.type === "instruction")
			.map((e) => ["required-skill", e.id]),
		...s.requested
			.filter((v) =>
				s.available.some((e) => e.id === v && e.type === "instruction"),
			)
			.map((v) => ["requested-skill", v]),
	];
	if (
		s.composition.length < 2 ||
		!equal(
			s.composition.slice(2).map((e) => [e.kind, e.id]),
			wanted,
		)
	)
		fail("composition", "required/requested membership or order mismatch");
	if (used.size !== packages.size)
		fail("packages", "foreign or omitted package closure");
	validateObservations(s, skills, packages);
}

function allBackings(s) {
	return [
		...s.composition,
		...s.required,
		...s.available,
		...s.shared,
		...s.hostReferences,
	]
		.flatMap((e) => [e.backing, ...(e.resources ?? []).map((r) => r.backing)])
		.filter(Boolean);
}

function readBacking(root, b, packages) {
	if (b.type === "package") {
		const file = packages.get(b.sha256)?.files.find((f) => f.path === b.path);
		if (!file) fail("package backing", `missing path ${b.path}`);
		return file.bytes;
	}
	const bytes = readStoreFile(root, `blobs/sha256/${b.sha256}`);
	if (bytes.length !== b.bytes || sha(bytes) !== b.sha256)
		fail("blob", `bytes length/digest mismatch ${b.sha256}`);
	return bytes;
}

function physicalIdentity(root, p) {
	if (p.revisionDigest === null || p.revisionDigest === undefined) return p;
	const record = readRevisionRecord({
		storeRoot: root,
		recordDigest: p.revisionDigest,
	});
	if (
		record.identity.name !== p.name ||
		record.identity.version !== p.version ||
		record.content.sha256 !== p.sha256
	)
		fail("snapshot relation revision", "physical identity pin mismatch");
	return record.content.identity;
}

function readPackages(root, s) {
	const packages = new Map();
	for (const p of s.packages) {
		lstatSync(safePath(root, `objects/sha256/${p.sha256}/tree`));
		if (s.stampVersion === 2 && packages.has(p.sha256)) {
			const identity = packages.get(p.sha256).manifest.package;
			const expected = physicalIdentity(root, p);
			if (
				identity.name !== expected.name ||
				identity.version !== expected.version
			)
				fail("snapshot relation package", "tree identity mismatch");
			continue;
		}
		const files = verifyObject(
			root,
			p.sha256,
			s.stampVersion === 2 ? physicalIdentity(root, p) : p,
		);
		const manifest = parseManifest(
			files.find((f) => f.path === "package.yaml").bytes,
		);
		packages.set(p.sha256, { files, manifest });
	}
	return packages;
}

function manifestRelations2(s, packages, root) {
	const records = new Map(),
		pins = new Map(s.packages.map((p) => [pinKey(p), p]));
	for (const row of s.revisions) {
		const record = readRevisionRecord({
			storeRoot: root,
			recordDigest: row.recordDigest,
		});
		if (
			record.identity.name !== row.name ||
			record.identity.version !== row.version ||
			record.content.sha256 !== row.sha256
		)
			fail("snapshot relation revision", "catalog identity/content mismatch");
		records.set(row.recordDigest, record);
	}
	const candidates = [...records].filter(
		([, record]) => record.kind === "candidate",
	);
	if (s.capture.kind === "candidate") {
		if (candidates.length !== 1 || candidates[0][0] !== s.capture.candidate)
			fail(
				"snapshot relation candidate",
				"missing or foreign candidate catalog",
			);
		const [candidateDigest, record] = candidates[0],
			provenance = record.provenance;
		if (provenance.migrationId !== s.capture.migration)
			fail("snapshot relation candidate", "workspace mismatch");
		const base = loadStamp(root, provenance.evaluationBase),
			original = loadStamp(root, provenance.migrationBase);
		// The authoring base is a legacy stamp1 or a native config3 ACTIVE stamp2 capture, never another candidate.
		if (
			base.stampVersion !== 2 ||
			base.capture.kind !== "active" ||
			!(
				original.stampVersion === 1 ||
				(original.stampVersion === 2 && original.capture.kind === "active")
			) ||
			!equal(base.selection, s.selection) ||
			!equal(base.requested, s.requested)
		)
			fail("snapshot relation candidate", "evaluation base/selection mismatch");
		for (const reference of [
			provenance.evaluationBase,
			provenance.migrationBase,
		])
			reconstructStamp({ storeRoot: root, digest: reference });
		const oldSelection = {
			role: original.selection.role,
			model:
				original.selection.identity.canonical ??
				original.selection.identity.raw,
			host: original.selection.host,
		};
		const actual = {
			role: s.selection.role,
			model: s.selection.identity.canonical,
			host: s.selection.host,
		};
		if (!equal(oldSelection, actual))
			fail("snapshot relation candidate", "foreign migration base assignment");
		const parent = readRevisionRecord({
			storeRoot: root,
			recordDigest: record.parent,
		});
		const selected = base.selectionBindings.find(
			(row) => row.root.binding === provenance.binding,
		)?.root;
		// A stamp2 authoring base names its selected root; its dependency-first composition can tag a dependency with the root binding.
		const origin =
			original.stampVersion === 2
				? original.selectionBindings.find(
						(row) => row.root.binding === provenance.binding,
					)?.root
				: [
						...original.composition,
						...original.required,
						...original.available,
					].find((e) => e.package?.binding === provenance.binding)?.package;
		if (
			!selected ||
			selected.revisionDigest !== record.parent ||
			selected.sha256 !== parent.content.sha256 ||
			!origin ||
			origin.sha256 !== parent.content.sha256 ||
			origin.name !== parent.identity.name ||
			origin.version !== parent.identity.version
		)
			fail("snapshot relation candidate", "parent origin/selection mismatch");
		const project = (value) => {
			if (Array.isArray(value)) return value.map(project);
			if (!value || typeof value !== "object") return value;
			const copy = Object.fromEntries(
				Object.entries(value).map(([key, child]) => [key, project(child)]),
			);
			if (copy.revisionDigest === record.parent) {
				copy.revisionDigest = candidateDigest;
				if (
					copy.name === parent.identity.name &&
					copy.version === parent.identity.version
				) {
					copy.version = record.identity.version;
					copy.sha256 = record.content.sha256;
				}
			}
			if (copy.type === "package" && copy.sha256 === parent.content.sha256)
				copy.sha256 = record.content.sha256;
			return copy;
		};
		// Only the primary assignment's target is projected; other actors keep their original exact pins.
		const replaceBindings = (rows) =>
			rows.map((row) =>
				row.root.binding === provenance.binding ? project(row) : row,
			);
		if (!equal(s.selectionBindings, replaceBindings(base.selectionBindings)))
			fail("snapshot relation candidate", "unapproved primary binding change");
		const actors = base.workflowActors.map((actor) =>
			equal(actor.assignment, actual)
				? { ...actor, bindings: replaceBindings(actor.bindings) }
				: actor,
		);
		const peers = base.workflowPeers.map((row) =>
			Object.fromEntries(
				Object.entries(row).map(([key, side]) => [
					key,
					["consumer", "provider"].includes(key) &&
					equal(side.assignment, actual) &&
					side.binding === provenance.binding
						? project(side)
						: side,
				]),
			),
		);
		if (!equal(s.workflowActors, actors) || !equal(s.workflowPeers, peers))
			fail("snapshot relation candidate", "unapproved actor/peer change");
		const direct = (entries) =>
			entries.map((e) => {
				if (e.package?.binding !== provenance.binding) return e;
				const projected = project(e);
				if (Object.hasOwn(e, "nameSource")) {
					const found = packages.get(record.content.sha256),
						metadata = skillMetadata(
							"unused",
							e.id,
							found.files.find((f) => f.path === found.manifest.entrypoint)
								.bytes,
							found.manifest.entrypoint,
						);
					if (
						metadata.nameSource === "directory" &&
						path.posix.dirname(found.manifest.entrypoint) === "."
					)
						metadata.name = record.identity.name.split("/")[1];
					for (const field of ["name", "nameSource", "description"])
						projected[field] = metadata[field];
				}
				return projected;
			});
		if (
			!equal(s.required, direct(base.required)) ||
			!equal(s.available, direct(base.available)) ||
			!equal(s.shared, base.shared) ||
			!equal(s.hostReferences, base.hostReferences)
		)
			fail(
				"snapshot relation candidate",
				"unapproved declaration/shared changes",
			);
		if (!equal(s.composition, direct(base.composition)))
			fail(
				"snapshot relation candidate",
				"unapproved composition/raw backing changes",
			);
	} else if (candidates.length)
		fail(
			"snapshot relation candidate",
			"active capture cannot select unpublished candidate",
		);
	const revision = (p) => {
		if (p.revisionDigest === null) return null;
		const record = records.get(p.revisionDigest);
		if (
			!record ||
			record.identity.name !== p.name ||
			record.identity.version !== p.version ||
			record.content.sha256 !== p.sha256
		)
			fail("snapshot relation revision", "foreign/missing record pin");
		return record;
	};
	for (const p of s.packages) {
		if (!equal(p.behavior, packages.get(p.sha256).manifest.behavior))
			fail("snapshot relation behavior", "manifest disagreement");
		revision(p);
	}
	const used = new Set();
	function closure(root) {
		const result = [],
			seen = new Map(),
			active = new Set();
		function visit(p) {
			const pin = pinKey(p);
			if (!pins.has(pin))
				fail("snapshot relation closure", "missing package pin");
			if (active.has(p.name)) fail("snapshot relation closure", "cycle");
			if (seen.has(p.name)) {
				if (seen.get(p.name) !== pin)
					fail("snapshot relation closure", "conflicting identity/metadata");
				return;
			}
			seen.set(p.name, pin);
			active.add(p.name);
			used.add(pin);
			for (const dependency of revision(p)?.dependencies ?? [])
				visit(dependency);
			active.delete(p.name);
			result.push({
				name: p.name,
				version: p.version,
				sha256: p.sha256,
				revisionDigest: p.revisionDigest,
			});
		}
		visit(root);
		return result;
	}
	function checkBindings(rows) {
		const names = new Map();
		for (const row of rows) {
			if (!equal(row.closure, closure(row.root)))
				fail(
					"snapshot relation closure",
					"dependency-first membership disagreement",
				);
			const rootManifest = packages.get(row.root.sha256).manifest;
			const expectedType = row.root.binding.startsWith("skills.")
				? "skill"
				: "instruction";
			if (
				rootManifest.package.type !== expectedType ||
				(expectedType === "instruction" &&
					rootManifest.behavior.delivery !== "instruction")
			)
				fail("snapshot relation binding", "incompatible package type/delivery");
			for (const p of row.closure) {
				const old = names.get(p.name);
				if (old && old !== pinKey(p))
					fail(
						"snapshot relation actor closure",
						"conflicting loaded identities",
					);
				names.set(p.name, pinKey(p));
				if (
					pinKey(p) !== pinKey(row.root) &&
					packages.get(p.sha256).manifest.behavior.delivery === "native"
				)
					fail(
						"snapshot relation closure",
						"native dependency cannot be injected",
					);
			}
		}
	}
	checkBindings(s.selectionBindings);
	for (const actor of s.workflowActors) checkBindings(actor.bindings);
	for (const entry of [...s.required, ...s.available])
		if (entry.package) {
			closure(entry.package);
			const found = packages.get(entry.package.sha256),
				metadata = skillMetadata(
					"unused",
					entry.id,
					found.files.find((file) => file.path === found.manifest.entrypoint)
						.bytes,
					found.manifest.entrypoint,
				);
			if (
				metadata.nameSource === "directory" &&
				path.posix.dirname(found.manifest.entrypoint) === "."
			)
				metadata.name = entry.package.name.split("/")[1];
			if (
				found.manifest.package.type !== "skill" ||
				entry.backing.path !== found.manifest.entrypoint ||
				(entry.type === "host") !==
					(found.manifest.behavior.delivery === "native")
			)
				fail("snapshot relation skill", "type/entrypoint disagreement");
			for (const name of ["name", "nameSource", "description"])
				if (entry[name] !== metadata[name])
					fail("snapshot relation skill metadata", name);
		}
	if (
		used.size !== pins.size ||
		s.revisions.some(
			(row) =>
				![...used].some(
					(key) => pins.get(key).revisionDigest === row.recordDigest,
				),
		)
	)
		fail("snapshot relation inventory", "foreign or omitted closure");
	const owners = [
		`profiles.${s.selection.profile}`,
		`roles.${s.selection.role}`,
		...new Set([
			...s.required.map((e) => `skills.${e.id}`),
			...s.requested.map((id) => `skills.${id}`),
		]),
	];
	const byBinding = new Map(
		s.selectionBindings.map((row) => [row.root.binding, row]),
	);
	const direct = [...s.required, ...s.available];
	const wantedBindings = owners.filter((owner) =>
		owner.startsWith("skills.")
			? direct.find((e) => `skills.${e.id}` === owner)?.package
			: byBinding.has(owner),
	);
	if (
		!equal(
			s.selectionBindings.map((row) => row.root.binding),
			wantedBindings,
		)
	)
		fail(
			"snapshot relation selectionBindings",
			"primary root membership/order mismatch",
		);
	for (const e of direct.filter(
		(e) => e.package && owners.includes(e.package.binding),
	)) {
		if (!equal(byBinding.get(e.package.binding)?.root, e.package))
			fail("snapshot relation selectionBindings", "direct provenance mismatch");
	}
	const physical = [];
	for (const owner of owners) {
		const row = byBinding.get(owner);
		if (!row) continue;
		for (const p of row.closure) {
			const manifest = packages.get(p.sha256).manifest;
			if (manifest.behavior.delivery === "native") continue;
			const isRoot = pinKey(p) === pinKey(row.root);
			const kind = isRoot
				? owner.startsWith("profiles.")
					? "profile"
					: owner.startsWith("roles.")
						? "role"
						: s.required.some((e) => owner === `skills.${e.id}`)
							? "required-skill"
							: "requested-skill"
				: "dependency";
			const pkg = {
				...row.root,
				name: p.name,
				version: p.version,
				sha256: p.sha256,
				revisionDigest: p.revisionDigest,
			};
			const task = {
				kind,
				id: isRoot ? owner.split(".")[1] : p.name,
				backing: {
					type: "package",
					sha256: p.sha256,
					path: manifest.entrypoint,
				},
				package: pkg,
				resources: [],
				owner,
			};
			const prior = physical.find(
				(e) =>
					e.backing.sha256 === p.sha256 &&
					e.backing.path === manifest.entrypoint &&
					e.package.revisionDigest === p.revisionDigest,
			);
			if (prior && isRoot && prior.kind === "dependency") {
				Object.assign(prior, { kind, id: task.id, package: pkg });
				const companion = physical.find(
					(e) =>
						e.kind === "workflow" &&
						e.backing.sha256 === p.sha256 &&
						e.package.revisionDigest === p.revisionDigest,
				);
				if (companion) Object.assign(companion, { id: task.id, package: pkg });
			}
			if (!prior) {
				physical.push(task);
				const file = revision(p)?.workflow?.file;
				if (file !== undefined && file !== null)
					physical.push({
						...task,
						kind: "workflow",
						backing: { ...task.backing, path: file },
					});
			}
		}
	}
	const expected = [];
	for (const owner of owners) {
		expected.push(...physical.filter((e) => e.owner === owner));
		if (byBinding.has(owner)) continue;
		const skill = direct.find((e) => `skills.${e.id}` === owner);
		if (skill?.type === "host") continue;
		const [scope, id] = owner.split("."),
			kind =
				scope === "profiles"
					? "profile"
					: scope === "roles"
						? "role"
						: s.required.includes(skill)
							? "required-skill"
							: "requested-skill";
		const local =
			skill ??
			s.composition.find(
				(e) => e.kind === kind && e.id === id && e.package === null,
			);
		if (!local || local.package !== null || !local.backing)
			fail("snapshot relation composition", "missing local root");
		expected.push({
			kind,
			id,
			backing: local.backing,
			package: null,
			resources: local.resources,
			owner: null,
		});
	}
	if (!equal(s.composition, expected))
		fail(
			"snapshot relation composition",
			"physical order/owner/raw backing or direct provenance disagreement",
		);
	const actors = new Map(
		s.workflowActors.map((actor) => [actorKey(actor.assignment), actor]),
	);
	const current = {
		role: s.selection.role,
		model: s.selection.identity.canonical,
		host: s.selection.host,
	};
	if (current.model !== null && current.host !== null) {
		const actor = actors.get(actorKey(current));
		const required = s.selectionBindings.filter(
			(row) =>
				!row.root.binding.startsWith("skills.") ||
				s.required.some((e) => e.package?.binding === row.root.binding),
		);
		if (
			!actor ||
			actor.profile !== s.selection.profile ||
			!equal(actor.bindings, required)
		)
			fail(
				"snapshot relation actor",
				"primary required-only evidence disagreement",
			);
	} else if (actors.size || s.workflowPeers.length)
		fail(
			"snapshot relation actor",
			"unspecified actor cannot assert peer readiness",
		);
	for (let i = 1; i < s.workflowActors.length; i++)
		if (
			compare(
				actorKey(s.workflowActors[i - 1].assignment),
				actorKey(s.workflowActors[i].assignment),
			) >= 0
		)
			fail("workflowActors", "expected canonical unique actors");
	const reached = new Set(
			actors.has(actorKey(current)) ? [actorKey(current)] : [],
		),
		covered = new Set();
	const taskMembers = (row) =>
		row.closure.filter(
			(p) =>
				packages.get(p.sha256).manifest.behavior.delivery === "instruction",
		);
	for (const peer of s.workflowPeers) {
		for (const [side, direction] of [
			["consumer", "requires"],
			["provider", "provides"],
		]) {
			const spec = peer[side],
				actor = actors.get(actorKey(spec.assignment));
			const row = actor?.bindings.find(
				(row) => row.root.binding === spec.binding,
			);
			if (
				!row ||
				revision(row.root)?.workflow === undefined ||
				revision(row.root).workflow === null
			)
				fail(
					"snapshot relation workflow peer",
					"missing required root or unknown root declaration",
				);
			const members = taskMembers(row);
			if (
				side === "provider" &&
				members.some(
					(p) =>
						revision(p)?.workflow === undefined ||
						revision(p).workflow === null,
				)
			)
				fail("snapshot relation workflow peer", "unknown provider closure");
			const declaring = members.filter((p) =>
				revision(p)?.workflow?.[direction].some(
					(d) => d.protocol === peer.protocol,
				),
			);
			if (
				declaring.length !== 1 ||
				declaring[0].revisionDigest !== spec.revisionDigest ||
				!revision(declaring[0]).workflow[direction].some(
					(d) => d.protocol === peer.protocol && d.major === peer.major,
				)
			)
				fail(
					"snapshot relation workflow peer",
					"selected member/protocol/major disagreement",
				);
			if (side === "provider") {
				const all = new Map(
					actor.bindings
						.flatMap((row) => taskMembers(row))
						.map((p) => [pinKey(p), p]),
				);
				if (
					[...all.values()].filter((p) =>
						revision(p)?.workflow?.provides.some(
							(d) => d.protocol === peer.protocol,
						),
					).length !== 1
				)
					fail(
						"snapshot relation workflow peer",
						"conflicting actor providers",
					);
			} else
				covered.add(
					`${actorKey(actor.assignment)}:${spec.revisionDigest}:${peer.protocol}`,
				);
		}
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of s.workflowPeers)
			if (
				[row.consumer, row.provider].some((side) =>
					reached.has(actorKey(side.assignment)),
				)
			) {
				for (const side of [row.consumer, row.provider])
					if (!reached.has(actorKey(side.assignment))) {
						reached.add(actorKey(side.assignment));
						changed = true;
					}
			}
	}
	if (reached.size !== actors.size)
		fail("snapshot relation workflow actors", "foreign unreached actor");
	for (const actor of s.workflowActors)
		for (const row of actor.bindings)
			for (const member of taskMembers(row)) {
				for (const required of revision(member)?.workflow?.requires ?? [])
					if (
						!covered.has(
							`${actorKey(actor.assignment)}:${member.revisionDigest}:${required.protocol}`,
						)
					)
						fail(
							"snapshot relation workflow required",
							"missing required coverage",
						);
			}
	if (current.model !== null && current.host !== null)
		for (const row of s.selectionBindings)
			for (const member of taskMembers(row)) {
				for (const required of revision(member)?.workflow?.requires ?? [])
					if (
						!covered.has(
							`${actorKey(current)}:${member.revisionDigest}:${required.protocol}`,
						)
					)
						fail(
							"snapshot relation workflow required",
							"missing requested coverage",
						);
			}
}

function manifestRelations(s, packages, root) {
	if (s.stampVersion === 2) return manifestRelations2(s, packages, root);
	for (const p of s.packages)
		if (!equal(p.behavior, packages.get(p.sha256).manifest.behavior))
			fail("snapshot relation packages.behavior", "manifest disagreement");
	const bindings = new Map(),
		records = new Map();
	for (const e of [
		...s.composition.slice(0, 2),
		...s.required,
		...s.available,
	].filter((e) => e.package)) {
		const p = e.package,
			found = packages.get(p.sha256);
		if (e.backing.path !== found.manifest.entrypoint)
			fail(
				"snapshot relation composition.entrypoint",
				"manifest entrypoint disagreement",
			);
		bindings.set(p.binding, {
			source: new Map([
				["package", p.name],
				["version", p.version],
			]),
			type: p.binding.startsWith("skills.") ? "skill" : "instruction",
			rules: [],
			pins: new Map(),
		});
		records.set(key(p), { sha256: p.sha256, files: found.files });
	}
	validatePackageBindings(bindings, records);
	for (const e of [...s.required, ...s.available].filter((e) => e.package)) {
		const pin = bindings.get(e.package.binding).pins.get(e.package.version);
		if ((pin.manifest.behavior.delivery === "native") !== (e.type === "host"))
			fail("snapshot relation skill type", "manifest delivery disagreement");
		for (const k of ["name", "nameSource", "description"])
			if (e[k] !== pin.metadata[k])
				fail("snapshot relation skill metadata", `${k} disagreement`);
	}
}

function localContent(root, s, packages) {
	const entries = [
		...(s.stampVersion === 2 ? s.composition : s.composition.slice(0, 2)),
		...s.required,
		...s.available,
	];
	for (const e of entries.filter(
		(e) =>
			e.backing &&
			e.type !== "host" &&
			(e.backing.type === "blob" || s.stampVersion === 2),
	)) {
		const bytes = readBacking(root, e.backing, packages);
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		if (e.type === "instruction" && e.backing.type === "blob") {
			const metadata = skillMetadata("unused", e.id, bytes, e.backing.path);
			for (const k of ["name", "nameSource", "description"])
				if (e[k] !== metadata[k])
					fail("snapshot relation skill metadata", `${e.id}.${k} disagreement`);
		}
	}
}

/** @param {{root?: string, storeRoot?: string, host?: string, model?: string, family?: string, identitySource?: 'host'|'host-stated'|'user', role?: string, skills?: string[], sharedFiles?: string[]}} input */
function captureStamp(input = {}, candidateDigest = null) {
	options(input, [
		"root",
		"storeRoot",
		"host",
		"model",
		"family",
		"identitySource",
		"role",
		"skills",
		"sharedFiles",
	]);
	const { sharedFiles, ...selectors } = input;
	const root = rootPath(
		input.root === undefined ? process.cwd() : input.root,
		"root",
	);
	const inputs = new Map(),
		blobs = new Map();
	const capture = (relative) => {
		portable(relative);
		if (!inputs.has(relative)) {
			const bytes = readStoreFile(root, relative),
				stat = lstatSync(safePath(root, relative), { bigint: true });
			inputs.set(relative, { bytes, stat });
		}
		return inputs.get(relative).bytes;
	};
	const configuration = parseYaml(capture(CONFIG).toString("utf8"));
	const captureInput = { ...selectors, root, configuration };
	const { resolution: resolved, evidence } =
		candidateDigest === null
			? resolveCapture(captureInput)
			: resolveCandidateCapture(captureInput, candidateDigest);
	const v3 = configuration.get("version") === 3;
	if (resolved.lockState === "valid") capture(LOCK);
	const blob = (relative, instruction = false) => {
		const bytes = capture(relative);
		if (instruction)
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		const sha256 = sha(bytes);
		blobs.set(sha256, bytes);
		return { type: "blob", path: relative, sha256, bytes: bytes.length };
	};
	const base = (e) => ({
		backing: e.package
			? { ...e.backing }
			: e.path
				? blob(e.path, e.type !== "host")
				: null,
		package: e.package ?? null,
		resources: (e.resources ?? []).map((relative) => ({
			binding: `${e.kind === "profile" ? "profiles" : e.kind === "role" ? "roles" : "skills"}.${e.id}`,
			backing: blob(relative),
		})),
	});
	const skill = (e) => ({
		id: e.id,
		type: e.type,
		delivery: e.delivery,
		name: e.name,
		nameSource: e.nameSource,
		description: e.description,
		...base(e),
		hostReference: e.type === "host" ? `skills.${e.id}` : null,
	});
	const required = resolved.required.map(skill),
		available = resolved.available.map(skill);
	const composition = resolved.loaded.map((e) => ({
		kind: e.kind,
		id: e.id,
		...base(e),
		...(v3 ? { owner: e.owner ?? null } : {}),
	}));
	const destination = storeRoot(input.storeRoot);
	const selections = [...composition, ...required, ...available]
		.filter((e) => e.package)
		.map((e) => e.package);
	let packages = [...new Map(selections.map((p) => [key(p), p])).values()]
		.map((p) => {
			const files = verifyObject(
					destination,
					p.sha256,
					v3 ? physicalIdentity(destination, p) : p,
				),
				manifest = parseManifest(
					files.find((f) => f.path === "package.yaml").bytes,
				);
			return {
				name: p.name,
				version: p.version,
				sha256: p.sha256,
				behavior: manifest.behavior,
			};
		})
		.sort(packageOrder);
	const revisions = new Map();
	if (v3) {
		const pins = new Map(),
			active = new Set();
		function retain(p) {
			const pin = pinKey(p);
			if (active.has(pin))
				fail("snapshot relation closure", "cycle during capture");
			if (pins.has(pin)) return;
			active.add(pin);
			const files = verifyObject(
					destination,
					p.sha256,
					physicalIdentity(destination, p),
				),
				manifest = parseManifest(
					files.find((file) => file.path === "package.yaml").bytes,
				);
			if (p.revisionDigest !== null) {
				const record = readRevisionRecord({
					storeRoot: destination,
					recordDigest: p.revisionDigest,
				});
				if (
					record.identity.name !== p.name ||
					record.identity.version !== p.version ||
					record.content.sha256 !== p.sha256
				)
					fail(
						"snapshot relation revision",
						"capture identity/content mismatch",
					);
				revisions.set(p.revisionDigest, {
					recordDigest: p.revisionDigest,
					...record.identity,
					sha256: record.content.sha256,
				});
				for (const dependency of record.dependencies) retain(dependency);
			}
			active.delete(pin);
			pins.set(pin, {
				name: p.name,
				version: p.version,
				sha256: p.sha256,
				revisionDigest: p.revisionDigest,
				behavior: manifest.behavior,
			});
		}
		for (const p of [
			...selections,
			...evidence.primary.flatMap((row) => row.closure),
			...evidence.actors.flatMap((actor) =>
				actor.bindings.flatMap((row) => row.closure),
			),
		])
			retain(p);
		packages = [...pins.values()].sort(pinOrder);
	}
	if (sharedFiles !== undefined) {
		list(sharedFiles, "sharedFiles");
		unique(sharedFiles, "sharedFiles");
		sharedFiles.forEach(portable);
	}
	const shared = (sharedFiles ?? ["AGENTS.md"]).map((relative) => {
		let backing = null,
			status;
		try {
			backing = blob(relative);
			status = "captured";
		} catch (error) {
			if (sharedFiles !== undefined)
				fail("shared capture", errorMessage(error));
			status = errorCode(error) === "ENOENT" ? "absent" : "unobserved";
		}
		return { path: relative, status, backing, delivery: "host-controlled" };
	});
	const hostReferences = ["required", "available"].flatMap((group) =>
		resolved[group]
			.filter((e) => e.type === "host")
			.map((e) => {
				const skill = (group === "required" ? required : available).find(
					(s) => s.id === e.id,
				);
				const supportedHosts = e.supportedHosts ?? [e.host];
				return {
					key: skill.hostReference,
					id: e.id,
					host: e.host,
					scope: e.scope,
					hostId: e.hostId,
					requirement: group,
					compatibility:
						resolved.host === null
							? null
							: supportedHosts.includes(resolved.host),
					observation: skill.backing
						? "captured-file"
						: "host-provided-unverified",
					backing: skill.backing,
					invocation: "unverified",
					rendered: "unverified",
					supportedHosts,
				};
			}),
	);
	const snapshot = {
		stampVersion: v3 ? 2 : 1,
		configurationVersion: configuration.get("version"),
		resolverContract: `agent-profiles/resolver/v${configuration.get("version")}`,
		selection: Object.fromEntries(
			[
				"host",
				"identity",
				"family",
				"familySource",
				"profile",
				"role",
				"roleSource",
			].map((k) => [k, resolved[k]]),
		),
		requested: [...new Set(input.skills ?? [])],
		composition,
		required,
		available,
		packages,
		shared,
		hostReferences,
		inventory: { ...inventory },
		coverage: { ...coverage },
	};
	if (v3)
		Object.assign(snapshot, {
			capture:
				candidateDigest === null
					? { kind: "active", migration: null, candidate: null }
					: {
							kind: "candidate",
							migration: readRevisionRecord({
								storeRoot: destination,
								recordDigest: candidateDigest,
							}).provenance.migrationId,
							candidate: candidateDigest,
						},
			workflowPeers: resolved.workflow.peers,
			revisions: [...revisions.values()].sort((a, b) =>
				compare(a.recordDigest, b.recordDigest),
			),
			selectionBindings: evidence.primary,
			workflowActors: [...evidence.actors].sort((a, b) =>
				compare(actorKey(a.assignment), actorKey(b.assignment)),
			),
		});
	validateSnapshot(snapshot);
	const retained = readPackages(destination, snapshot);
	manifestRelations(snapshot, retained, destination);
	const stampDigest = hashRecord(stampDomain(snapshot), snapshot),
		bytes = canonicalJSON(snapshot);
	const store = storeRoot(input.storeRoot, true),
		writer = safePath(store, ".writer-lock");
	try {
		mkdirSync(writer);
	} catch (error) {
		if (errorCode(error) === "EEXIST") fail("store-busy", "writer lock exists");
		throw error;
	}
	let staging;
	try {
		writeFlushed(
			path.join(writer, "owner.json"),
			canonicalJSON({ pid: process.pid, operation: randomUUID() }),
		);
		for (const p of [".staging", "blobs/sha256", "stamps/sha256"])
			mkdirSync(safePath(store, p), { recursive: true });
		staging = mkdtempSync(
			path.join(safePath(store, ".staging"), "package-stamp-"),
		);
		for (const [hash, content] of blobs) {
			const final = safePath(store, `blobs/sha256/${hash}`);
			if (statOrNull(final)) {
				if (!readStoreFile(store, `blobs/sha256/${hash}`).equals(content))
					fail("blob", `digest mismatch ${hash}`);
			} else {
				const temporary = path.join(staging, hash);
				writeFlushed(temporary, content);
				publish(temporary, final, renameSync);
			}
		}
		const checked = readPackages(store, snapshot);
		manifestRelations(snapshot, checked, store);
		for (const b of allBackings(snapshot)) readBacking(store, b, checked);
		localContent(store, snapshot, checked);
		const unchanged = () => {
			for (const [relative, before] of inputs) {
				if (
					!readStoreFile(root, relative).equals(before.bytes) ||
					!sameStat(
						before.stat,
						lstatSync(safePath(root, relative), { bigint: true }),
					)
				)
					fail(relative, "stale-input: changed during capture");
			}
		};
		const final = safePath(store, `stamps/sha256/${stampDigest}`);
		if (statOrNull(final)) {
			unchanged();
			const existing = loadStamp(store, stampDigest);
			if (!equal(existing, snapshot))
				fail("snapshot", "existing digest mismatch");
		} else {
			const temporary = path.join(staging, "snapshot");
			mkdirSync(temporary);
			writeFlushed(path.join(temporary, "snapshot.json"), bytes);
			unchanged();
			publish(temporary, final, renameSync);
		}
		loadStamp(store, stampDigest);
		return { digest: stampDigest, snapshot };
	} finally {
		try {
			if (staging) rmSync(staging, { recursive: true, force: true });
		} finally {
			rmSync(writer, { recursive: true, force: true });
		}
	}
}

export function createStamp(input = {}) {
	return captureStamp(input);
}

// Internal typed capture only; active public options and legacy bytes remain unchanged.
export function createCandidateStamp(input, recordDigest) {
	digest(recordDigest, "candidate");
	return captureStamp(input, recordDigest);
}

function loadStamp(root, hash) {
	const relative = `stamps/sha256/${hash}`;
	const directory = safePath(root, relative);
	const bytes = readStoreFile(root, `${relative}/snapshot.json`);
	if (readdirSync(directory).join(",") !== "snapshot.json")
		fail("snapshot", "unexpected directory membership");
	const snapshot = parseRecord(bytes);
	if (!canonicalJSON(snapshot).equals(bytes))
		fail("snapshot", "noncanonical encoding");
	if (hashRecord(stampDomain(snapshot), snapshot) !== hash)
		fail("snapshot", "digest/domain mismatch");
	validateSnapshot(snapshot);
	return snapshot;
}

function inspect(input) {
	digest(input.digest);
	const report = {
		snapshotIntegrity: "unverified",
		managedContent: "unverified",
		managedReconstruction: "unverified",
		hostDependencies: "unverified",
		hostInvocation: "unverified",
		runtimeIdentity: "unverified",
		renderedPrompt: "unverified",
		managedReproducible: false,
		declaredHostDependenciesSatisfied: false,
		completeRuntimeReproducible: false,
		findings: [],
	};
	let root, snapshot, packages;
	try {
		root = storeRoot(input.storeRoot);
		snapshot = loadStamp(root, input.digest);
		report.snapshotIntegrity = "verified";
	} catch (error) {
		report.snapshotIntegrity =
			errorCode(error) === "ENOENT" ? "missing" : "mismatched";
		report.findings.push(`snapshot: ${errorMessage(error)}`);
		return { report };
	}
	try {
		packages = readPackages(root, snapshot);
		manifestRelations(snapshot, packages, root);
		for (const b of allBackings(snapshot)) readBacking(root, b, packages);
		localContent(root, snapshot, packages);
		report.managedContent = "verified";
		report.managedReconstruction = "verified";
		report.managedReproducible = true;
	} catch (error) {
		if (errorMessage(error).startsWith("snapshot relation"))
			report.snapshotIntegrity = "mismatched";
		else
			report.managedContent =
				errorCode(error) === "ENOENT" ? "missing" : "mismatched";
		report.findings.push(errorMessage(error));
		return { report };
	}
	const peerNative =
		snapshot.stampVersion === 2 &&
		snapshot.workflowActors.some((actor) =>
			actor.bindings.some(
				(row) =>
					packages.get(row.root.sha256).manifest.behavior.delivery === "native",
			),
		);
	report.declaredHostDependenciesSatisfied =
		!peerNative &&
		!snapshot.hostReferences.some((e) => e.requirement === "required");
	if (snapshot.hostReferences.length || peerNative)
		report.findings.push(
			"Host dependencies and native invocation remain unverified",
		);
	return { report, root, snapshot, packages };
}

/** @param {{digest: string, storeRoot?: string}} input */
export function verifyStamp(input) {
	options(input, ["digest", "storeRoot"]);
	return inspect(input).report;
}

/** @param {{before: string, after: string, storeRoot?: string}} input */
export function diffStamps(input) {
	options(input, ["before", "after", "storeRoot"]);
	digest(input.before, "before");
	digest(input.after, "after");
	const before = inspect({ digest: input.before, storeRoot: input.storeRoot });
	const after = inspect({ digest: input.after, storeRoot: input.storeRoot });
	const complete =
		before.report.managedReproducible === true &&
		after.report.managedReproducible === true;
	const changes = [];
	function walk(a, b, location) {
		if (a === b) return;
		if (
			a !== null &&
			b !== null &&
			typeof a === "object" &&
			typeof b === "object" &&
			Array.isArray(a) === Array.isArray(b)
		) {
			const keys = [];
			if (Array.isArray(a)) {
				for (let i = 0; i < Math.max(a.length, b.length); i++)
					keys.push(String(i));
			} else keys.push(...new Set([...Object.keys(a), ...Object.keys(b)]));
			if (!Array.isArray(a)) keys.sort(compare);
			for (const k of keys) {
				const child = `${location}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`;
				if (!Object.hasOwn(a, k))
					changes.push({
						path: child,
						kind: "added",
						before: null,
						after: b[k],
					});
				else if (!Object.hasOwn(b, k))
					changes.push({
						path: child,
						kind: "removed",
						before: a[k],
						after: null,
					});
				else walk(a[k], b[k], child);
			}
		} else
			changes.push({ path: location, kind: "changed", before: a, after: b });
	}
	if (complete) walk(before.snapshot, after.snapshot, "");
	return {
		complete,
		beforeVerification: before.report,
		afterVerification: after.report,
		changes,
	};
}

/** @param {{digest: string, storeRoot?: string, nativeReady?: boolean}} input */
export function reconstructStamp(input) {
	options(input, ["digest", "storeRoot", "nativeReady"]);
	if (input.nativeReady !== undefined && typeof input.nativeReady !== "boolean")
		fail("nativeReady", "expected boolean");
	const { report, root, snapshot: s, packages } = inspect(input);
	if (!report.managedReproducible)
		fail("reconstruction", report.findings.join("; "));
	if (input.nativeReady)
		fail("unsupported-native", "native-ready reconstruction is not supported");
	const bytes = (e) =>
		e.backing ? readBacking(root, e.backing, packages) : null;
	return {
		composition: s.composition.map((e) => ({ ...e, bytes: bytes(e) })),
		required: s.required,
		available: s.available.map((e) =>
			e.type === "instruction" ? { ...e, bytes: bytes(e) } : e,
		),
		resources: [
			...(s.stampVersion === 2
				? s.composition.filter((e) => e.kind === "profile" || e.kind === "role")
				: s.composition.slice(0, 2)),
			...s.required,
			...s.available,
		].flatMap((e) =>
			e.resources.map((r) => ({
				...r,
				bytes: readBacking(root, r.backing, packages),
			})),
		),
		packages: s.packages.map((p) => ({
			...p,
			files: packages.get(p.sha256).files,
		})),
		shared: s.shared.map((e) => ({ ...e, bytes: bytes(e) })),
		hostReferences: s.hostReferences.map((e) => ({ ...e, bytes: bytes(e) })),
		...(s.stampVersion === 2
			? {
					capture: s.capture,
					workflowPeers: s.workflowPeers,
					selectionBindings: s.selectionBindings,
					workflowActors: s.workflowActors,
					revisions: s.revisions.map((row) => ({
						...row,
						bytes: canonicalJSON(
							readRevisionRecord({
								storeRoot: root,
								recordDigest: row.recordDigest,
							}),
						),
					})),
				}
			: {}),
	};
}
