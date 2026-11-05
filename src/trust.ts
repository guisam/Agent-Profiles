// Trust policy and SSH signature verification (#71, step 2 of #55). This module only
// reads and verifies: it loads the machine and project trust policies, parses an
// OpenSSH allowed_signers file, and checks SSH signatures (the SSHSIG format that
// `ssh-keygen -Y sign` writes and Git uses for SSH commit signing) natively with
// Node's Ed25519. Nothing here enforces a policy; later steps call it.
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { errorMessage } from "./files.ts";

/** The SSHSIG namespace approvals are signed under (`ssh-keygen -Y sign -n ...`). */
export const APPROVAL_NAMESPACE = "agent-profiles-approval";

export const ED25519 = "ssh-ed25519";
export const SK_ED25519 = "sk-ssh-ed25519@openssh.com";
const KEY_TYPES = [ED25519, SK_ED25519];

/** Manifest effects (see packages.ts) and the ones a policy allows by default. */
export const EFFECTS = [
	"commands",
	"substitution",
	"external-references",
	"host-configuration",
];
const DEFAULT_EFFECTS = ["substitution"];

// --- SSH wire format

class Reader {
	offset = 0;
	readonly bytes: Buffer;
	readonly what: string;
	constructor(bytes: Buffer, what: string) {
		this.bytes = bytes;
		this.what = what;
	}
	take(length: number) {
		if (this.offset + length > this.bytes.length)
			throw new Error(`${this.what}: truncated`);
		const out = this.bytes.subarray(this.offset, this.offset + length);
		this.offset += length;
		return out;
	}
	uint32() {
		return this.take(4).readUInt32BE(0);
	}
	byte() {
		return this.take(1)[0];
	}
	string() {
		return this.take(this.uint32());
	}
	text() {
		return this.string().toString("utf8");
	}
	end() {
		if (this.offset !== this.bytes.length)
			throw new Error(`${this.what}: unexpected trailing bytes`);
	}
}

const sshString = (value: Buffer | string) => {
	const bytes = typeof value === "string" ? Buffer.from(value) : value;
	const length = Buffer.alloc(4);
	length.writeUInt32BE(bytes.length);
	return Buffer.concat([length, bytes]);
};

/** A public key blob: its type, the raw Ed25519 key, and for sk keys the application. */
export type SshPublicKey = {
	type: string;
	key: Buffer;
	application: string | null;
	blob: Buffer;
	/** OpenSSH's SHA256 fingerprint, as `ssh-keygen -l` prints it. */
	fingerprint: string;
};

export function parsePublicKey(blob: Buffer): SshPublicKey {
	const reader = new Reader(blob, "public key");
	const type = reader.text();
	if (!KEY_TYPES.includes(type))
		throw new Error(
			`unsupported key type ${type} (supported: ${KEY_TYPES.join(", ")})`,
		);
	const key = reader.string();
	if (key.length !== 32) throw new Error("public key: bad Ed25519 key length");
	const application = type === SK_ED25519 ? reader.text() : null;
	reader.end();
	return {
		type,
		key,
		application,
		blob,
		fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
	};
}

/** Ed25519 raw key → a Node key object (SPKI DER: fixed prefix + 32 bytes). */
const ed25519Key = (raw: Buffer) =>
	createPublicKey({
		key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
		format: "der",
		type: "spki",
	});

export type SshSignature = {
	publicKey: SshPublicKey;
	namespace: string;
	hashAlgorithm: "sha256" | "sha512";
	signatureType: string;
	signature: Buffer;
	/** sk keys only: the authenticator flags and counter. */
	flags: number | null;
	counter: number | null;
};

/** Parse an armored `-----BEGIN SSH SIGNATURE-----` block. */
export function parseSshSignature(armored: string): SshSignature {
	const match =
		/-----BEGIN SSH SIGNATURE-----([\s\S]*?)-----END SSH SIGNATURE-----/.exec(
			armored,
		);
	if (!match) throw new Error("signature: not an armored SSH signature");
	const bytes = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
	const reader = new Reader(bytes, "signature");
	if (reader.take(6).toString("latin1") !== "SSHSIG")
		throw new Error("signature: missing SSHSIG preamble");
	const version = reader.uint32();
	if (version !== 1)
		throw new Error(`signature: unsupported version ${version}`);
	const publicKey = parsePublicKey(reader.string());
	const namespace = reader.text();
	reader.string(); // reserved
	const hashAlgorithm = reader.text();
	if (hashAlgorithm !== "sha256" && hashAlgorithm !== "sha512")
		throw new Error(`signature: unsupported hash ${hashAlgorithm}`);
	const blob = new Reader(reader.string(), "signature blob");
	reader.end();
	const signatureType = blob.text();
	if (signatureType !== publicKey.type)
		throw new Error(
			`signature: type ${signatureType} does not match key ${publicKey.type}`,
		);
	const signature = blob.string();
	if (signature.length !== 64)
		throw new Error("signature: bad Ed25519 signature length");
	const sk = signatureType === SK_ED25519;
	const flags = sk ? blob.byte() : null;
	const counter = sk ? blob.uint32() : null;
	blob.end();
	return {
		publicKey,
		namespace,
		hashAlgorithm,
		signatureType,
		signature,
		flags,
		counter,
	};
}

/** The bytes an SSHSIG signature covers, for a message. */
function signedData(
	namespace: string,
	hashAlgorithm: "sha256" | "sha512",
	message: Buffer,
) {
	return Buffer.concat([
		Buffer.from("SSHSIG"),
		sshString(namespace),
		sshString(""),
		sshString(hashAlgorithm),
		sshString(createHash(hashAlgorithm).update(message).digest()),
	]);
}

/** Whether the signature's own key signed the message (no signer policy). */
function cryptographicallyValid(parsed: SshSignature, message: Buffer) {
	const data = signedData(parsed.namespace, parsed.hashAlgorithm, message);
	const { publicKey } = parsed;
	if (publicKey.type === ED25519)
		return verify(null, data, ed25519Key(publicKey.key), parsed.signature);
	// FIDO keys sign H(application) || flags || counter || H(data).
	const counter = Buffer.alloc(4);
	counter.writeUInt32BE(parsed.counter ?? 0);
	const authenticated = Buffer.concat([
		createHash("sha256")
			.update(publicKey.application ?? "")
			.digest(),
		Buffer.from([parsed.flags ?? 0]),
		counter,
		createHash("sha256").update(data).digest(),
	]);
	return verify(
		null,
		authenticated,
		ed25519Key(publicKey.key),
		parsed.signature,
	);
}

// --- allowed_signers

export type AllowedSigner = {
	line: number;
	principals: string[];
	namespaces: string[] | null;
	validAfter: Date | null;
	validBefore: Date | null;
	key: SshPublicKey;
};

/** Split on unquoted whitespace (or commas, for option lists), keeping quoted text. */
function tokens(text: string, separator: RegExp) {
	const out: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (const char of text) {
		if (char === '"') {
			quoted = !quoted;
			started = true;
			continue;
		}
		if (!quoted && separator.test(char)) {
			if (started) out.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (quoted) throw new Error("unterminated quote");
	if (started) out.push(current);
	return out;
}

// valid-after/valid-before: YYYYMMDD[HHMM[SS]], local time unless it ends in Z.
function signerTime(value: string) {
	const match = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})?)?(Z)?$/.exec(
		value,
	);
	if (!match) throw new Error(`bad time ${value}`);
	const [, y, mo, d, h = "0", mi = "0", s = "0", z] = match;
	const parts = [y, mo, d, h, mi, s].map(Number);
	const date = z
		? new Date(
				Date.UTC(
					parts[0],
					parts[1] - 1,
					parts[2],
					parts[3],
					parts[4],
					parts[5],
				),
			)
		: new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
	if (Number.isNaN(date.getTime())) throw new Error(`bad time ${value}`);
	return date;
}

/**
 * Parse an OpenSSH allowed_signers file. Unsupported lines (certificate
 * authorities, other key types) are reported as problems and skipped, so one
 * unknown line can't stop every other signer from verifying.
 */
export function parseAllowedSigners(text: string) {
	const signers: AllowedSigner[] = [];
	const problems: string[] = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = index + 1;
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) return;
		try {
			const fields = tokens(trimmed, /\s/);
			const principals = fields.shift();
			if (!principals || fields.length < 2)
				throw new Error("expected principals, a key type and a key");
			let options: string[] = [];
			if (
				!KEY_TYPES.includes(fields[0]) &&
				!/^(ssh-|sk-|ecdsa-)/.test(fields[0])
			)
				options = tokens(fields.shift() as string, /,/);
			const [type, base64] = fields;
			if (!KEY_TYPES.includes(type))
				throw new Error(`unsupported key type ${type}`);
			let namespaces: string[] | null = null;
			let validAfter: Date | null = null;
			let validBefore: Date | null = null;
			for (const option of options) {
				const [name, ...rest] = option.split("=");
				const value = rest.join("=");
				const key = name.toLowerCase();
				if (key === "namespaces") namespaces = value.split(",");
				else if (key === "valid-after") validAfter = signerTime(value);
				else if (key === "valid-before") validBefore = signerTime(value);
				else if (key === "cert-authority")
					throw new Error("certificate authorities are not supported");
				else throw new Error(`unsupported option ${name}`);
			}
			const key = parsePublicKey(Buffer.from(base64, "base64"));
			if (key.type !== type)
				throw new Error(`key is ${key.type}, line says ${type}`);
			signers.push({
				line,
				principals: principals.split(","),
				namespaces,
				validAfter,
				validBefore,
				key,
			});
		} catch (error) {
			problems.push(`line ${line}: ${errorMessage(error)}`);
		}
	});
	return { signers, problems };
}

// OpenSSH patterns: * and ? wildcards; a leading ! negates.
function patternMatches(pattern: string, value: string) {
	const source = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${source}$`).test(value);
}

export function principalAllowed(patterns: string[], principal: string) {
	if (
		patterns.some(
			(p) => p.startsWith("!") && patternMatches(p.slice(1), principal),
		)
	)
		return false;
	return patterns.some(
		(p) => !p.startsWith("!") && patternMatches(p, principal),
	);
}

export type Verified = {
	principal: string;
	keyType: string;
	fingerprint: string;
	signerLine: number;
};

/**
 * Verify an armored SSH signature over a message for a principal, against parsed
 * allowed signers: like `ssh-keygen -Y verify -I <principal> -n <namespace>`.
 * Throws with the reason when it doesn't verify.
 */
export function verifySshSignature({
	message,
	signature,
	namespace,
	principal,
	signers,
	now = new Date(),
	requireUserPresence = true,
}: {
	message: Buffer;
	signature: string;
	namespace: string;
	principal: string;
	signers: AllowedSigner[];
	now?: Date;
	requireUserPresence?: boolean;
}): Verified {
	const parsed = parseSshSignature(signature);
	if (parsed.namespace !== namespace)
		throw new Error(
			`signed for namespace ${parsed.namespace}, expected ${namespace}`,
		);
	const signer = signers.find(
		(entry) =>
			entry.key.blob.equals(parsed.publicKey.blob) &&
			principalAllowed(entry.principals, principal),
	);
	if (!signer)
		throw new Error(
			`key ${parsed.publicKey.fingerprint} is not an allowed signer for ${principal}`,
		);
	if (
		signer.namespaces &&
		!signer.namespaces.some((n) => patternMatches(n, namespace))
	)
		throw new Error(
			`allowed_signers line ${signer.line} does not allow namespace ${namespace}`,
		);
	if (signer.validAfter && now < signer.validAfter)
		throw new Error(
			`allowed_signers line ${signer.line} is not valid until ${signer.validAfter.toISOString()}`,
		);
	if (signer.validBefore && now >= signer.validBefore)
		throw new Error(
			`allowed_signers line ${signer.line} expired at ${signer.validBefore.toISOString()}`,
		);
	if (!cryptographicallyValid(parsed, message))
		throw new Error("signature does not match the signed content");
	// Bit 0 is user presence (a touch). Stricter than `ssh-keygen -Y verify`, which
	// accepts an untouched signature: a touch is what an agent session can't supply.
	if (
		parsed.signatureType === SK_ED25519 &&
		requireUserPresence &&
		!((parsed.flags ?? 0) & 1)
	)
		throw new Error("hardware key signature lacks user presence (no touch)");
	return {
		principal,
		keyType: parsed.signatureType,
		fingerprint: parsed.publicKey.fingerprint,
		signerLine: signer.line,
	};
}

// --- trust policy

export type TrustPolicy = {
	/** Policy files that contributed, machine first. */
	files: string[];
	allowedSigners: string | null;
	signingKey: string | null;
	requireApproval: boolean;
	/** Package-name patterns; a package must match every list (machine and project). */
	namespaces: string[][];
	/** Allowed manifest effects (the intersection of every policy). */
	effects: string[];
	/** Approver principal patterns; every list must allow a principal. */
	principals: string[][];
	problems: string[];
};

export const machineTrustFile = () =>
	process.env.AGENT_PROFILES_TRUST ||
	path.join(os.homedir(), ".agent-profiles", "trust.yaml");
export const PROJECT_TRUST = ".agent-profiles/trust.yaml";

const MACHINE_KEYS = [
	"version",
	"allowed_signers",
	"signing_key",
	"require_approval",
	"namespaces",
	"effects",
	"principals",
];
// A project file is repository content any process can edit: it narrows, never widens,
// and never names keys.
const PROJECT_KEYS = [
	"version",
	"require_approval",
	"namespaces",
	"effects",
	"principals",
];

function expandHome(value: string, base: string) {
	const home = value === "~" || /^~[\\/]/.test(value);
	return home
		? path.join(os.homedir(), value.slice(1))
		: path.resolve(base, value);
}

function readPolicyFile(file: string, keys: string[], problems: string[]) {
	if (!existsSync(file)) return null;
	let data: unknown;
	try {
		data = parseYaml(readFileSync(file, "utf8"));
	} catch (error) {
		problems.push(`${file}: ${errorMessage(error)}`);
		return null;
	}
	if (data === null || typeof data !== "object" || Array.isArray(data)) {
		problems.push(`${file}: expected a mapping`);
		return null;
	}
	const record = data as Record<string, unknown>;
	const bad = Object.keys(record).filter((key) => !keys.includes(key));
	if (bad.length)
		problems.push(
			`${file}: ${bad.join(", ")} not allowed here${keys === PROJECT_KEYS ? " (a project policy can only narrow the machine policy; keys come from the machine policy)" : ""}`,
		);
	if (record.version !== 1) problems.push(`${file}: version: expected 1`);
	const list = (name: string, allowed?: string[]) => {
		const value = record[name];
		if (value === undefined) return null;
		if (
			!Array.isArray(value) ||
			value.some((item) => typeof item !== "string" || !item) ||
			(allowed && value.some((item) => !allowed.includes(item)))
		) {
			problems.push(
				`${file}: ${name}: expected a list of ${allowed ? `values from ${allowed.join(", ")}` : "nonempty strings"}`,
			);
			return null;
		}
		return value as string[];
	};
	const text = (name: string) => {
		const value = record[name];
		if (value === undefined) return null;
		if (typeof value !== "string" || !value) {
			problems.push(`${file}: ${name}: expected a path`);
			return null;
		}
		return expandHome(value, path.dirname(file));
	};
	const requireApproval = record.require_approval;
	if (requireApproval !== undefined && typeof requireApproval !== "boolean")
		problems.push(`${file}: require_approval: expected true or false`);
	return {
		allowedSigners: keys.includes("allowed_signers")
			? text("allowed_signers")
			: null,
		signingKey: keys.includes("signing_key") ? text("signing_key") : null,
		requireApproval: requireApproval === true,
		namespaces: list("namespaces"),
		effects: list("effects", EFFECTS),
		principals: list("principals"),
	};
}

/**
 * The effective trust policy for a project: the machine policy (AGENT_PROFILES_TRUST
 * or ~/.agent-profiles/trust.yaml), narrowed by the project's .agent-profiles/trust.yaml.
 * Returns null when neither exists, so projects without a policy are unaffected.
 */
export function loadTrustPolicy({
	root,
}: {
	root?: string;
} = {}): TrustPolicy | null {
	const problems: string[] = [];
	const machineFile = machineTrustFile();
	const projectFile = root ? path.join(root, PROJECT_TRUST) : null;
	const machine = readPolicyFile(machineFile, MACHINE_KEYS, problems);
	const project = projectFile
		? readPolicyFile(projectFile, PROJECT_KEYS, problems)
		: null;
	const files = [
		...(existsSync(machineFile) ? [machineFile] : []),
		...(projectFile && existsSync(projectFile) ? [projectFile] : []),
	];
	if (!files.length) return null;
	const layers = [machine, project].filter((layer) => layer !== null);
	const effects = layers.reduce(
		(allowed, layer) =>
			layer.effects
				? allowed.filter((e) => layer.effects?.includes(e))
				: allowed,
		machine?.effects ?? DEFAULT_EFFECTS,
	);
	const policy: TrustPolicy = {
		files,
		allowedSigners: machine?.allowedSigners ?? null,
		signingKey: machine?.signingKey ?? null,
		requireApproval: layers.some((layer) => layer.requireApproval),
		namespaces: layers.flatMap((layer) =>
			layer.namespaces ? [layer.namespaces] : [],
		),
		effects,
		principals: layers.flatMap((layer) =>
			layer.principals ? [layer.principals] : [],
		),
		problems,
	};
	if (policy.requireApproval && !policy.allowedSigners)
		problems.push(
			"require_approval is on but the machine policy names no allowed_signers file, so no approval can verify",
		);
	return policy;
}

/** The allowed signers the policy names, with any file problems added to the policy's. */
export function policySigners(policy: TrustPolicy) {
	if (!policy.allowedSigners) return [];
	if (!existsSync(policy.allowedSigners)) {
		policy.problems.push(
			`allowed_signers ${policy.allowedSigners}: file not found`,
		);
		return [];
	}
	const { signers, problems } = parseAllowedSigners(
		readFileSync(policy.allowedSigners, "utf8"),
	);
	policy.problems.push(
		...problems.map(
			(problem) => `allowed_signers ${policy.allowedSigners} ${problem}`,
		),
	);
	return signers;
}

/** Whether a package name matches the policy's namespace patterns (every layer). */
export function namespaceAllowed(policy: TrustPolicy, name: string) {
	return policy.namespaces.every((patterns) =>
		patterns.some((pattern) => patternMatches(pattern, name)),
	);
}

/** Effects a manifest declares that the policy doesn't allow. */
export function disallowedEffects(policy: TrustPolicy, effects: string[]) {
	return effects.filter((effect) => !policy.effects.includes(effect));
}

/** Whether every policy layer allows a principal to approve. */
export function approverAllowed(policy: TrustPolicy, principal: string) {
	return policy.principals.every((patterns) =>
		principalAllowed(patterns, principal),
	);
}

/** Doctor lines for the trust policy: what is configured, and its problems. */
export function trustReport(root: string) {
	const policy = loadTrustPolicy({ root });
	if (!policy) return { notes: [], errors: [] };
	const signers = policySigners(policy);
	const notes = [
		`Trust policy: ${policy.files.join(" + ")}; require_approval ${policy.requireApproval ? "on" : "off"}; ${policy.allowedSigners ? `${signers.length} allowed signer key${signers.length === 1 ? "" : "s"} in ${policy.allowedSigners}` : "no allowed_signers"}; namespaces ${policy.namespaces.length ? policy.namespaces.map((list) => list.join(",")).join(" ∩ ") : "any"}; effects ${policy.effects.join(", ") || "none"}`,
	];
	return {
		notes,
		errors: policy.problems.map((problem) => `Trust policy: ${problem}`),
	};
}
