import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { errorCode, errorMessage } from "./files.ts";
import {
	candidateReservation,
	encodeComponent,
	inStoreSession,
	lookupPackage,
	publish,
	readStoreFile,
	rootPath,
	safePath,
	sessionMemo,
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
} from "./packages.ts";

const domain = "agent-profiles/revision/v1";
const digestPattern = /^[0-9a-f]{64}$/;
const namePattern = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
const fail = (field, message) => {
	throw new Error(`revision ${field}: ${message}`);
};
const key = (identity) => `${identity.name}@${identity.version}`;

function fields(value, names, field) {
	if (
		!value ||
		Array.isArray(value) ||
		typeof value !== "object" ||
		Object.keys(value).sort().join(",") !== [...names].sort().join(",")
	)
		fail(field, `expected exact fields ${names.join(", ")}`);
}
function identity(value, field) {
	fields(value, ["name", "version"], field);
	if (typeof value.name !== "string" || !namePattern.test(value.name))
		fail(field, "expected @namespace/name");
	if (
		typeof value.version !== "string" ||
		!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
			value.version,
		) ||
		value.version.split(".").some((n) => !Number.isSafeInteger(Number(n)))
	)
		fail(field, "expected exact safe release version");
	if (
		value.name
			.slice(1)
			.split("/")
			.some((part) => Buffer.byteLength(encodeComponent(part)) > 255)
	)
		fail(field, "identity path exceeds backend limit");
}
function digest(value, field) {
	if (typeof value !== "string" || !digestPattern.test(value))
		fail(field, "expected lowercase SHA-256 digest");
}
function validate(manifest) {
	fields(
		manifest,
		[
			"revisionVersion",
			"identity",
			"kind",
			"content",
			"parent",
			"candidate",
			"dependencies",
			"workflow",
			"provenance",
		],
		"record",
	);
	const candidate =
			manifest.revisionVersion === 2 && manifest.kind === "candidate",
		release = manifest.revisionVersion === 2 && manifest.kind === "release";
	if (
		!candidate &&
		!release &&
		(manifest.revisionVersion !== 1 || manifest.kind !== "release")
	)
		fail(
			"record",
			"expected revisionVersion 1 legacy release or typed version 2 candidate/release",
		);
	identity(manifest.identity, "identity");
	fields(manifest.content, ["identity", "sha256"], "content");
	identity(manifest.content.identity, "content.identity");
	digest(manifest.content.sha256, "content.sha256");
	if (candidate) validateCandidate(manifest);
	else if (release) validateRelease(manifest);
	else {
		if (key(manifest.identity) !== key(manifest.content.identity))
			fail("content", "identity mismatch");
		if (manifest.parent !== null || manifest.candidate !== null)
			fail("parent/candidate", "legacy adoption requires null");
		fields(manifest.provenance, ["kind", "workflowChange"], "provenance");
		fields(
			manifest.provenance.workflowChange,
			["kind", "reason"],
			"provenance.workflowChange",
		);
		if (
			manifest.provenance.kind !== "legacy-adoption" ||
			manifest.provenance.workflowChange.kind !== "initial" ||
			typeof manifest.provenance.workflowChange.reason !== "string" ||
			!manifest.provenance.workflowChange.reason.trim() ||
			manifest.provenance.workflowChange.reason.includes("\0")
		)
			fail("provenance", "expected initial legacy-adoption reason");
	}
	if (!Array.isArray(manifest.dependencies))
		fail("dependencies", "expected array");
	const seen = new Set();
	for (const dependency of manifest.dependencies) {
		fields(
			dependency,
			["name", "version", "sha256", "revisionDigest"],
			"dependency",
		);
		identity(
			{ name: dependency.name, version: dependency.version },
			"dependency.identity",
		);
		digest(dependency.sha256, "dependency.sha256");
		if (dependency.revisionDigest !== null)
			digest(dependency.revisionDigest, "dependency.revisionDigest");
		if (seen.has(dependency.name) || dependency.name === manifest.identity.name)
			fail("dependencies", "duplicate/conflicting or self dependency");
		seen.add(dependency.name);
	}
	const workflow = manifest.workflow;
	if (workflow === null) return;
	fields(workflow, ["file", "provides", "requires"], "workflow");
	for (const direction of ["provides", "requires"]) {
		if (!Array.isArray(workflow[direction]))
			fail(`workflow.${direction}`, "expected array");
		const protocols = new Set();
		for (const entry of workflow[direction]) {
			fields(entry, ["protocol", "major"], `workflow.${direction}`);
			if (
				typeof entry.protocol !== "string" ||
				!namePattern.test(entry.protocol)
			)
				fail("workflow.protocol", "expected namespaced protocol");
			if (!Number.isSafeInteger(entry.major) || entry.major <= 0)
				fail("workflow.major", "expected positive safe integer");
			if (protocols.has(entry.protocol))
				fail("workflow.protocol", "duplicate/conflicting declaration");
			protocols.add(entry.protocol);
		}
	}
	if (workflow.file === null) {
		if (workflow.provides.length || workflow.requires.length)
			fail("workflow.file", "interfaces require a Markdown companion");
	} else {
		validateMembers([{ path: workflow.file, type: "file", nlink: 1 }]);
		if (!/\.md$/i.test(workflow.file))
			fail("workflow.file", "expected Markdown companion");
	}
}

function validateCandidate(manifest) {
	digest(manifest.parent, "parent");
	if (
		typeof manifest.candidate !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,127}$/.test(manifest.candidate)
	)
		fail("candidate", "invalid id");
	if (
		manifest.identity.name !== manifest.content.identity.name ||
		manifest.identity.version === manifest.content.identity.version
	)
		fail(
			"candidate",
			"expected a distinct planned version of the same package",
		);
	const p = manifest.provenance;
	fields(
		p,
		[
			"migrationId",
			"binding",
			"migrationBase",
			"evaluationBase",
			"configSha256",
			"expectedTreeSha256",
			"proposals",
			"workflowChange",
		],
		"provenance",
	);
	if (
		typeof p.migrationId !== "string" ||
		!/^migration-[a-f0-9-]{36}$/.test(p.migrationId) ||
		typeof p.binding !== "string" ||
		!/^skills\.[a-z0-9][a-z0-9-]*$/.test(p.binding)
	)
		fail("provenance", "invalid workspace/binding");
	for (const field of [
		"migrationBase",
		"evaluationBase",
		"configSha256",
		"expectedTreeSha256",
	])
		digest(p[field], field);
	if (p.expectedTreeSha256 !== manifest.content.sha256)
		fail("content", "expected tree mismatch");
	fields(p.workflowChange, ["kind", "reason"], "workflowChange");
	if (
		p.workflowChange.kind !== "task-only" ||
		typeof p.workflowChange.reason !== "string" ||
		!p.workflowChange.reason.trim() ||
		p.workflowChange.reason.includes("\0")
	)
		fail("workflowChange", "expected task-only reason");
	if (!Array.isArray(p.proposals) || !p.proposals.length)
		fail("proposals", "expected accepted literal history");
	const ids = new Set();
	for (const entry of p.proposals) {
		fields(entry, ["id", "proposal", "status", "reason"], "proposal record");
		if (
			typeof entry.id !== "string" ||
			!/^proposal-[a-f0-9-]{36}$/.test(entry.id) ||
			ids.has(entry.id) ||
			entry.status !== "accepted" ||
			entry.reason !== null
		)
			fail("proposals", "invalid accepted record");
		ids.add(entry.id);
		const proposal = entry.proposal;
		if (!proposal || typeof proposal !== "object" || Array.isArray(proposal))
			fail("proposal", "expected object");
		fields(
			proposal,
			[
				"proposalVersion",
				"classification",
				"target",
				"change",
				"evidence",
				...(Object.hasOwn(proposal, "draftCase") ? ["draftCase"] : []),
			],
			"proposal",
		);
		fields(proposal.target, ["path"], "proposal target");
		fields(proposal.change, ["before", "after"], "proposal change");
		if (proposal.proposalVersion !== 1 || proposal.classification !== "package")
			fail("proposal", "expected package proposal");
		validateMembers([{ path: proposal.target.path, type: "file", nlink: 1 }]);
		for (const value of Object.values(proposal.change))
			if (typeof value !== "string" || value.includes("\0"))
				fail("proposal change", "expected literal text without NUL");
		if (!Array.isArray(proposal.evidence) || !proposal.evidence.length)
			fail("evidence", "expected nonempty array");
		for (const evidence of proposal.evidence) {
			fields(evidence, ["sessionId", "excerpt", "baseStamp"], "evidence");
			for (const value of Object.values(evidence))
				if (typeof value !== "string" || !value.trim() || value.includes("\0"))
					fail("evidence", "expected text");
			if (evidence.baseStamp !== p.migrationBase)
				fail("evidence", "foreign migration base");
		}
		if (Object.hasOwn(proposal, "draftCase")) {
			fields(proposal.draftCase, ["input", "expected"], "draftCase");
			for (const value of Object.values(proposal.draftCase))
				if (typeof value !== "string" || !value.trim() || value.includes("\0"))
					fail("draftCase", "expected inert text");
		}
	}
}

// A promoted release labels the exact evaluated candidate content; only approval metadata differs.
function validateRelease(manifest) {
	digest(manifest.parent, "parent");
	digest(manifest.candidate, "candidate");
	if (
		manifest.identity.name !== manifest.content.identity.name ||
		manifest.identity.version === manifest.content.identity.version
	)
		fail("release", "expected a distinct planned version of the same package");
	fields(manifest.provenance, ["kind", "decisionDigest"], "provenance");
	if (manifest.provenance.kind !== "promotion")
		fail("provenance", "expected promotion");
	digest(manifest.provenance.decisionDigest, "provenance.decisionDigest");
}

const decisionDomain = "agent-profiles/promotion-decision/v1";
const idPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;
const decisionFields = [
	"decisionVersion",
	"id",
	"resultId",
	"candidateId",
	"candidateRevisionDigest",
	"planDigest",
	"resultDigest",
	"assignment",
	"release",
	"regressions",
	"correctnessOverride",
];
const text = (value, field) => {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		fail(field, "expected nonempty text without NUL");
};
// Strict promotion decision shape; evidence relations are checked by the promotion service.
export function validateDecision(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("decision", "expected object");
	for (const name of Object.keys(value))
		if (!decisionFields.includes(name))
			fail("decision", `unknown field ${name}`);
	for (const name of decisionFields)
		if (!Object.hasOwn(value, name)) fail("decision", `missing ${name}`);
	if (value.decisionVersion !== 1)
		fail("decision", "unsupported decisionVersion");
	for (const name of ["id", "resultId", "candidateId"])
		if (typeof value[name] !== "string" || !idPattern.test(value[name]))
			fail(`decision.${name}`, "expected portable identifier");
	for (const name of ["candidateRevisionDigest", "planDigest", "resultDigest"])
		digest(value[name], `decision.${name}`);
	fields(value.assignment, ["role", "model", "host"], "decision.assignment");
	for (const name of ["role", "model", "host"])
		text(value.assignment[name], `decision.assignment.${name}`);
	identity(value.release, "decision.release");
	if (!Array.isArray(value.regressions))
		fail("decision.regressions", "expected array");
	for (const row of value.regressions) {
		fields(
			row,
			["caseId", "basePassed", "candidatePassed", "trials", "reason"],
			"decision.regressions",
		);
		if (
			typeof row.caseId !== "string" ||
			!idPattern.test(row.caseId) ||
			row.reason !== "per-case-correctness-drop" ||
			["basePassed", "candidatePassed", "trials"].some(
				(name) => !Number.isSafeInteger(row[name]) || row[name] < 0,
			)
		)
			fail("decision.regressions", "expected exact integer per-case rows");
	}
	const override = value.correctnessOverride;
	if (override === null) return;
	fields(override, ["gate", "reason", "cases"], "decision.correctnessOverride");
	if (override.gate !== "per-case-correctness-drop")
		fail(
			"decision.correctnessOverride.gate",
			"only the per-case correctness gate may be waived",
		);
	text(override.reason, "decision.correctnessOverride.reason");
	if (
		!Array.isArray(override.cases) ||
		!override.cases.length ||
		override.cases.some(
			(id) => typeof id !== "string" || !idPattern.test(id),
		) ||
		new Set(override.cases).size !== override.cases.length
	)
		fail(
			"decision.correctnessOverride.cases",
			"expected nonempty unique case ids",
		);
}
export function readPromotionDecision(root, decisionDigest) {
	digest(decisionDigest, "decisionDigest");
	const bytes = readStoreFile(
			root,
			`promotions/decisions/sha256/${decisionDigest}.json`,
		),
		decision = parseRecord(bytes);
	validateDecision(decision);
	if (
		!canonicalJSON(decision).equals(bytes) ||
		hashRecord(decisionDomain, decision) !== decisionDigest
	)
		fail("decision", "integrity digest mismatch");
	return decision;
}
export function readPromotionIndex(root, id) {
	if (typeof id !== "string" || !idPattern.test(id))
		fail("promotion index", "expected portable identifier");
	const bytes = readStoreFile(root, `promotions/decisions/ids/${id}.json`),
		index = parseRecord(bytes);
	fields(
		index,
		["promotionIndexVersion", "id", "decisionDigest", "releaseDigest"],
		"promotion index",
	);
	if (
		index.promotionIndexVersion !== 1 ||
		index.id !== id ||
		!canonicalJSON(index).equals(bytes)
	)
		fail("promotion index", "corrupt canonical identity/version");
	digest(index.decisionDigest, "promotion index decisionDigest");
	digest(index.releaseDigest, "promotion index releaseDigest");
	return index;
}

export function labelPath(identity) {
	return `revisions/labels/${identity.name.slice(1).split("/").map(encodeComponent).join("/")}/${identity.version}.json`;
}
const recordPath = (digest) => `revisions/sha256/${digest}.json`;
function readLabel(root, identity) {
	const relative = labelPath(identity);
	if (!statOrNull(safePath(root, relative))) return null;
	const bytes = readStoreFile(root, relative),
		label = parseRecord(bytes);
	fields(label, ["identity", "recordDigest"], "label");
	if (!canonicalJSON(label.identity).equals(canonicalJSON(identity)))
		fail("label", "identity mismatch");
	digest(label.recordDigest, "label.recordDigest");
	if (!canonicalJSON(label).equals(bytes)) fail("label", "noncanonical record");
	return label;
}

function backing(root, manifest) {
	if (manifest.revisionVersion === 2) {
		// A promoted release has no legacy identity; its object is verified against the typed physical identity.
		const files = verifyObject(
			root,
			manifest.content.sha256,
			manifest.content.identity,
		);
		verifyCompanion({ files }, manifest);
		return { sha256: manifest.content.sha256, files };
	}
	const pkg = lookupPackage({ storeRoot: root, ...manifest.identity });
	if (!pkg)
		fail(
			"legacy",
			`existing release identity missing: ${key(manifest.identity)}`,
		);
	if (pkg.sha256 !== manifest.content.sha256)
		fail("legacy content", "digest mismatch");
	verifyCompanion(pkg, manifest);
	return pkg;
}
function verifyCompanion(pkg, manifest) {
	const workflow = manifest.workflow;
	if (workflow !== null && workflow.file !== null) {
		const packageManifest = parseManifest(
			pkg.files.find((member) => member.path === "package.yaml").bytes,
		);
		if (
			workflow.file.toLowerCase() ===
				packageManifest.entrypoint.toLowerCase() ||
			workflow.file.toLowerCase() === "package.yaml"
		)
			fail(
				"workflow.file",
				"companion must be distinct from entrypoint and metadata",
			);
		const member = pkg.files.find((member) => member.path === workflow.file);
		if (!member) fail("workflow.file", "missing companion member");
		let text;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				member.bytes,
			);
		} catch (error) {
			throw new Error(
				`revision workflow companion: invalid UTF-8: ${errorMessage(error)}`,
				{ cause: error },
			);
		}
		if (text.includes("\0")) fail("workflow.file", "companion contains NUL");
		if (packageManifest.behavior.delivery !== "instruction")
			fail("workflow.file", "companion requires managed instruction delivery");
	}
}

function verify(root, manifest, recordDigest, state) {
	validate(manifest);
	const identityKey = key(manifest.identity),
		previous = state.pins.get(manifest.identity.name);
	const pin = `${identityKey}:${manifest.content.sha256}:${recordDigest ?? "legacy"}`;
	if (previous && previous !== pin)
		fail("dependencies", "conflicting closure identities or metadata");
	if (state.active.has(identityKey))
		fail("dependencies", "cyclic revision closure");
	if (state.done.has(pin)) return;
	state.pins.set(manifest.identity.name, pin);
	state.active.add(identityKey);
	backing(root, manifest);
	for (const dependency of manifest.dependencies) {
		const pkg = lookupPackage({
			storeRoot: root,
			name: dependency.name,
			version: dependency.version,
		});
		if (!pkg || pkg.sha256 !== dependency.sha256)
			fail("dependency", "legacy identity/content mismatch or missing backing");
		if (dependency.revisionDigest !== null) {
			const retained = readRetained(root, dependency.revisionDigest);
			if (
				key(retained.identity) !== key(dependency) ||
				retained.content.sha256 !== dependency.sha256
			)
				fail("dependency", "revision identity/content mismatch");
			verify(root, retained, dependency.revisionDigest, state);
		} else {
			const legacyPin = `${key(dependency)}:${dependency.sha256}:legacy`,
				prior = state.pins.get(dependency.name);
			if (prior && prior !== legacyPin)
				fail("dependencies", "conflicting closure identity or metadata");
			state.pins.set(dependency.name, legacyPin);
		}
	}
	state.active.delete(identityKey);
	state.done.add(pin);
}
// Historical reading validates immutable backing without consulting current registration labels.
export function readRevisionRecord({ storeRoot: selected, recordDigest }) {
	const root = storeRoot(selected);
	digest(recordDigest, "recordDigest");
	// Records are content-addressed; within one store session a verified record is reused.
	return structuredClone(
		sessionMemo(`record\0${root}\0${recordDigest}`, () =>
			readRecordAt(root, recordDigest),
		),
	);
}

function readRecordAt(root, recordDigest) {
	const bytes = readStoreFile(root, recordPath(recordDigest)),
		manifest = parseRecord(bytes);
	validate(manifest);
	if (
		!canonicalJSON(manifest).equals(bytes) ||
		hashRecord(
			manifest.revisionVersion === 2 ? "agent-profiles/revision/v2" : domain,
			manifest,
		) !== recordDigest
	)
		fail("record", "integrity digest mismatch");
	const files = verifyObject(
		root,
		manifest.content.sha256,
		manifest.content.identity,
	);
	verifyCompanion({ files }, manifest);
	if (manifest.kind === "candidate") candidateBacking(root, manifest, files);
	else if (manifest.revisionVersion === 2) releaseBacking(root, manifest);
	return manifest;
}

// Integrity relations only: exact evaluated candidate content and a decision bound to it. Publication authority is checked by readRetained.
function releaseBacking(root, manifest) {
	const candidate = readRevisionRecord({
		storeRoot: root,
		recordDigest: manifest.candidate,
	});
	if (candidate.kind !== "candidate")
		fail("release", "expected an evaluated candidate record");
	for (const field of [
		"identity",
		"content",
		"parent",
		"dependencies",
		"workflow",
	]) {
		if (!canonicalJSON(candidate[field]).equals(canonicalJSON(manifest[field])))
			fail(
				"release",
				`wrapper ${field} differs from the evaluated candidate content`,
			);
	}
	const decision = readPromotionDecision(
		root,
		manifest.provenance.decisionDigest,
	);
	if (
		decision.candidateRevisionDigest !== manifest.candidate ||
		!canonicalJSON(decision.release).equals(canonicalJSON(manifest.identity))
	)
		fail("release", "decision does not bind this candidate and label");
}

function candidateBacking(root, manifest, files) {
	const parentBytes = readStoreFile(root, recordPath(manifest.parent)),
		parent = parseRecord(parentBytes);
	if (parent.revisionVersion !== 1)
		fail("parent", "candidate requires adopted release parent");
	const retained = readRevisionRecord({
		storeRoot: root,
		recordDigest: manifest.parent,
	});
	if (
		key(retained.identity) !== key(manifest.content.identity) ||
		!canonicalJSON(retained.dependencies).equals(
			canonicalJSON(manifest.dependencies),
		) ||
		!canonicalJSON(retained.workflow).equals(canonicalJSON(manifest.workflow))
	)
		fail("candidate", "parent identity/dependency/workflow mismatch");
	const original = verifyObject(
			root,
			retained.content.sha256,
			retained.content.identity,
		),
		entrypoint = parseManifest(
			files.find((f) => f.path === "package.yaml").bytes,
		).entrypoint;
	if (
		files.length !== original.length ||
		!files.some((file) => file.path === entrypoint)
	)
		fail("candidate", "unapproved tree membership or missing task");
	let task = original.find((f) => f.path === entrypoint)?.bytes;
	for (const entry of manifest.provenance.proposals) {
		if (
			entry.proposal.target.path !==
				`packages/${retained.content.sha256}/${entrypoint}` ||
			!task?.equals(Buffer.from(entry.proposal.change.before))
		)
			fail("candidate", "accepted proposal history mismatch");
		task = Buffer.from(entry.proposal.change.after);
	}
	for (const file of files) {
		const expected =
			file.path === entrypoint
				? task
				: original.find((f) => f.path === file.path)?.bytes;
		if (!expected || !file.bytes.equals(expected))
			fail("candidate", "unapproved task-only bytes");
	}
	const seen = new Map([[manifest.identity.name, key(manifest.identity)]]),
		active = new Set([manifest.identity.name]);
	function dependencyBacking(dependency) {
		const pin = `${dependency.version}:${dependency.sha256}:${dependency.revisionDigest}`;
		if (active.has(dependency.name))
			fail("dependency", "cyclic candidate closure");
		if (seen.has(dependency.name)) {
			if (seen.get(dependency.name) !== pin)
				fail("dependency", "conflicting closure");
			return;
		}
		verifyObject(root, dependency.sha256, dependency);
		seen.set(dependency.name, pin);
		active.add(dependency.name);
		if (dependency.revisionDigest !== null) {
			const record = readRevisionRecord({
				storeRoot: root,
				recordDigest: dependency.revisionDigest,
			});
			if (
				record.kind !== "release" ||
				key(record.identity) !== key(dependency) ||
				record.content.sha256 !== dependency.sha256
			)
				fail("dependency", "foreign identity/content metadata");
			for (const child of record.dependencies) dependencyBacking(child);
		}
		active.delete(dependency.name);
	}
	for (const dependency of manifest.dependencies) dependencyBacking(dependency);
}
function readRetained(root, recordDigest) {
	const manifest = readRevisionRecord({ storeRoot: root, recordDigest });
	if (manifest.kind === "candidate")
		fail("candidate", "unpublished candidate is not selectable");
	const label = readLabel(root, manifest.identity);
	if (!label || label.recordDigest !== recordDigest)
		fail("label", "missing or mismatched immutable identity");
	if (manifest.revisionVersion === 2) {
		// Public admission needs the committed decision index as well as the label; an orphan wrapper is integrity evidence only.
		const decision = readPromotionDecision(
				root,
				manifest.provenance.decisionDigest,
			),
			index = readPromotionIndex(root, decision.id);
		if (
			index.decisionDigest !== manifest.provenance.decisionDigest ||
			index.releaseDigest !== recordDigest
		)
			fail("release", "decision index does not authorize this wrapper");
	}
	return manifest;
}
// Classification only (no verification); callers then use the fully verified public lookup.
function typedRelease(root, recordDigest) {
	if (typeof recordDigest !== "string" || !digestPattern.test(recordDigest))
		return false;
	try {
		const manifest = parseRecord(readStoreFile(root, recordPath(recordDigest)));
		return manifest?.revisionVersion === 2 && manifest.kind === "release";
	} catch {
		return false;
	}
}
// A promoted release reference resolves through its verified wrapper, never a legacy identity mapping.
export function releasedPackage({
	storeRoot: selected,
	name,
	version,
	revisionDigest,
}) {
	if (revisionDigest === null || revisionDigest === undefined) return null;
	const root = storeRoot(selected);
	if (!typedRelease(root, revisionDigest)) return null;
	const manifest = lookupRevisionManifest({
		storeRoot: root,
		recordDigest: revisionDigest,
	});
	if (manifest.identity.name !== name || manifest.identity.version !== version)
		fail("identity", "revision reference mismatch");
	return {
		identity: manifest.identity,
		sha256: manifest.content.sha256,
		files: verifyObject(
			root,
			manifest.content.sha256,
			manifest.content.identity,
		),
	};
}
const verification = () => ({
	pins: new Map(),
	active: new Set(),
	done: new Set(),
});

// Internal publication retains metadata only; normal release labels are never created here.
export function retainCandidateRevision({ storeRoot: selected, manifest }) {
	validate(manifest);
	if (manifest.kind !== "candidate") fail("record", "expected candidate");
	const root = storeRoot(selected),
		recordDigest = hashRecord("agent-profiles/revision/v2", manifest),
		bytes = canonicalJSON(manifest);
	const files = verifyObject(
		root,
		manifest.content.sha256,
		manifest.content.identity,
	);
	verifyCompanion({ files }, manifest);
	candidateBacking(root, manifest, files);
	const target = safePath(root, recordPath(recordDigest)),
		writer = safePath(root, ".writer-lock");
	if (statOrNull(target)) {
		if (!readStoreFile(root, recordPath(recordDigest)).equals(bytes))
			fail("record", "immutable digest mismatch");
		readRevisionRecord({ storeRoot: root, recordDigest });
		return recordDigest;
	}
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
		mkdirSync(safePath(root, ".staging"), { recursive: true });
		staging = mkdtempSync(
			path.join(safePath(root, ".staging"), "candidate-revision-"),
		);
		writeFlushed(path.join(staging, "record.json"), bytes);
		if (!readStoreFile(staging, "record.json").equals(bytes))
			fail("record", "staged readback mismatch");
		mkdirSync(path.dirname(target), { recursive: true });
		if (!statOrNull(target))
			publish(path.join(staging, "record.json"), target, renameSync);
		readRevisionRecord({ storeRoot: root, recordDigest });
		return recordDigest;
	} finally {
		try {
			if (staging) rmSync(staging, { recursive: true, force: true });
		} finally {
			rmSync(writer, { recursive: true, force: true });
		}
	}
}

export function lookupRevisionManifest({ storeRoot: selected, recordDigest }) {
	const root = storeRoot(selected),
		manifest = readRetained(root, recordDigest);
	verify(root, manifest, recordDigest, verification());
	return manifest;
}

// Dependency-first verified backing, without selecting an actor or asserting readiness.
function revisionClosureOperation({
	storeRoot: selected,
	name,
	version,
	revisionDigest = null,
}) {
	const result = [],
		seen = new Map();
	function visit(name, version, revisionDigest) {
		const released = typedRelease(storeRoot(selected), revisionDigest);
		if (
			!released &&
			candidateReservation(storeRoot(selected), { name, version })
		)
			fail("candidate", "planned release is unpublished and not selectable");
		const revision =
			revisionDigest === null
				? null
				: lookupRevisionManifest({
						storeRoot: selected,
						recordDigest: revisionDigest,
					});
		if (
			revision &&
			(revision.identity.name !== name || revision.identity.version !== version)
		)
			fail("identity", "revision reference mismatch");
		const pkg = released
			? releasedPackage({ storeRoot: selected, name, version, revisionDigest })
			: lookupPackage({ storeRoot: selected, name, version });
		if (!pkg) fail("dependency", `missing-package ${name}@${version}`);
		if (revision && revision.content.sha256 !== pkg.sha256)
			fail("content", "revision digest mismatch");
		const pin = `${version}:${pkg.sha256}:${revisionDigest}`;
		if (seen.has(name)) {
			if (seen.get(name) !== pin)
				fail("dependency", "conflicting actor closure identities or metadata");
			return;
		}
		seen.set(name, pin);
		for (const dependency of revision?.dependencies ?? [])
			visit(dependency.name, dependency.version, dependency.revisionDigest);
		result.push({ ...pkg, revisionDigest, revision });
	}
	visit(name, version, revisionDigest);
	return result;
}

function retainRevisionManifestOperation({
	storeRoot: selected,
	manifestFile,
}) {
	if (typeof manifestFile !== "string" || !manifestFile.trim())
		fail("manifestFile", "expected local file");
	const source = path.resolve(manifestFile),
		sourceRoot = rootPath(path.dirname(source), "revision source");
	const manifest = parseRecord(
		readStoreFile(sourceRoot, path.basename(source)),
	);
	validate(manifest);
	if (manifest.revisionVersion !== 1)
		fail("record", "adoption accepts legacy releases only");
	const recordDigest = hashRecord(domain, manifest),
		bytes = canonicalJSON(manifest),
		root = storeRoot(selected);
	const result = (status) => ({
		identity: manifest.identity,
		sha256: manifest.content.sha256,
		recordDigest,
		status,
	});
	const preflight = () => {
		verify(root, manifest, recordDigest, verification());
		const label = readLabel(root, manifest.identity);
		if (label && label.recordDigest !== recordDigest)
			fail("identity-conflict", "immutable label cannot be repointed");
		if (
			statOrNull(safePath(root, recordPath(recordDigest))) &&
			!readStoreFile(root, recordPath(recordDigest)).equals(bytes)
		)
			fail("record", "immutable record digest mismatch");
		if (label) readRetained(root, recordDigest);
		return label;
	};
	if (preflight()) return result("reused");
	const writer = safePath(root, ".writer-lock");
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
		if (preflight()) return result("reused");
		mkdirSync(safePath(root, ".staging"), { recursive: true });
		staging = mkdtempSync(
			path.join(safePath(root, ".staging"), "package-revision-"),
		);
		writeFlushed(path.join(staging, "record.json"), bytes);
		if (!readStoreFile(staging, "record.json").equals(bytes))
			fail("record", "staged readback mismatch");
		const label = { identity: manifest.identity, recordDigest };
		writeFlushed(path.join(staging, "label.json"), canonicalJSON(label));
		if (!readStoreFile(staging, "label.json").equals(canonicalJSON(label)))
			fail("label", "staged readback mismatch");
		if (preflight()) return result("reused");
		const target = safePath(root, recordPath(recordDigest));
		mkdirSync(path.dirname(target), { recursive: true });
		const index = safePath(root, labelPath(manifest.identity));
		mkdirSync(path.dirname(index), { recursive: true });
		preflight();
		if (!statOrNull(target))
			publish(
				path.join(staging, "record.json"),
				safePath(root, recordPath(recordDigest)),
				renameSync,
			);
		publish(
			path.join(staging, "label.json"),
			safePath(root, labelPath(manifest.identity)),
			renameSync,
		);
		lookupRevisionManifest({ storeRoot: root, recordDigest });
		return result("published");
	} finally {
		// Published immutable artifacts survive a caught failure; only our private staging is removed.
		try {
			if (staging) rmSync(staging, { recursive: true, force: true });
		} finally {
			rmSync(writer, { recursive: true, force: true });
		}
	}
}

export const revisionClosure = inStoreSession(revisionClosureOperation);
export const retainRevisionManifest = inStoreSession(
	retainRevisionManifestOperation,
);
