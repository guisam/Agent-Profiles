// Signed approvals (#71 part 2, step 2 of #55). An approval is an SSH signature over
// one library version's exact digest, by a principal the trust policy allows.
// Approvals are committed with the project under .agent-profiles/approvals/, so
// reviewers and CI see and verify the same files. This module writes approvals
// (`library approve`) and reports their status; enforcement comes in part 3.
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { errorMessage } from "./files.ts";
import { type LibraryVersion, libraryInfo } from "./library.ts";
import {
	APPROVAL_NAMESPACE,
	approverAllowed,
	disallowedEffects,
	loadTrustPolicy,
	namespaceAllowed,
	parsePublicKey,
	policySigners,
	principalAllowed,
	type TrustPolicy,
	verifySshSignature,
} from "./trust.ts";

export const APPROVALS = ".agent-profiles/approvals";

export type ApprovalPayload = {
	schema: 1;
	package: string;
	version: string;
	sha256: string;
	revisionDigest: string | null;
	principal: string;
	approvedAt: string;
};

/**
 * The bytes that are signed: fixed key order, no whitespace, one trailing newline.
 * Verification re-serializes the parsed file the same way, so a project formatter
 * that reflows the JSON (as Biome did to a signed fixture) can't break an approval.
 */
export function canonicalPayload(payload: ApprovalPayload) {
	return Buffer.from(
		`${JSON.stringify({
			schema: payload.schema,
			package: payload.package,
			version: payload.version,
			sha256: payload.sha256,
			revisionDigest: payload.revisionDigest,
			principal: payload.principal,
			approvedAt: payload.approvedAt,
		})}\n`,
	);
}

// A principal is a file name: no separators, no patterns.
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9@._+-]*$/;

/** .agent-profiles/approvals/@ns/name/<version>/ */
export function approvalDirectory(root: string, name: string, version: string) {
	if (!/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(name))
		throw new Error(`${name}: expected @namespace/name`);
	if (!/^[0-9A-Za-z.+-]+$/.test(version))
		throw new Error(`${version}: not a version`);
	return path.join(root, APPROVALS, ...name.split("/"), version);
}

function parsePayload(text: string): ApprovalPayload {
	const value = JSON.parse(text);
	const keys = [
		"schema",
		"package",
		"version",
		"sha256",
		"revisionDigest",
		"principal",
		"approvedAt",
	];
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join() !== [...keys].sort().join()
	)
		throw new Error(`expected exactly ${keys.join(", ")}`);
	if (value.schema !== 1) throw new Error("schema: expected 1");
	for (const key of ["package", "version", "principal", "approvedAt"])
		if (typeof value[key] !== "string" || !value[key])
			throw new Error(`${key}: expected a string`);
	if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256))
		throw new Error("sha256: expected 64 lowercase hex");
	if (
		value.revisionDigest !== null &&
		(typeof value.revisionDigest !== "string" ||
			!/^[0-9a-f]{64}$/.test(value.revisionDigest))
	)
		throw new Error("revisionDigest: expected null or 64 lowercase hex");
	return value as ApprovalPayload;
}

export type ApprovalStatus = {
	status: "approved" | "unapproved";
	approvedBy: {
		principal: string;
		fingerprint: string;
		keyType: string;
		approvedAt: string;
	}[];
	/** Approval files present that don't count, with the reason. */
	problems: string[];
	/** Policy limits this version breaks, regardless of approvals. */
	policy: string[];
};

/**
 * Whether a library version is approved for a project under its trust policy, or
 * null when there is no policy. Every file in the version's approval folder is
 * checked; a file that doesn't verify is reported, never counted.
 */
export function approvalStatus({
	root,
	storeRoot,
	name,
	version,
	policy = loadTrustPolicy({ root }),
}: {
	root: string;
	storeRoot?: string;
	name: string;
	version: string;
	policy?: TrustPolicy | null;
}): ApprovalStatus | null {
	if (!policy) return null;
	const [entry] = libraryInfo({ storeRoot, name, version }).versions;
	return versionApproval({ root, policy, name, version, entry });
}

/** The same check for a version already looked up (library info, outdated). */
export function versionApproval({
	root,
	policy,
	name,
	version,
	entry,
}: {
	root: string;
	policy: TrustPolicy;
	name: string;
	version: string;
	entry: LibraryVersion | undefined;
}): ApprovalStatus {
	const status: ApprovalStatus = {
		status: "unapproved",
		approvedBy: [],
		problems: [],
		policy: [],
	};
	if (!entry || "error" in entry) {
		status.problems.push(
			`${name}@${version} is not verified${entry && "error" in entry ? `: ${entry.error}` : ""}`,
		);
		return status;
	}
	if (!namespaceAllowed(policy, name))
		status.policy.push(`namespace of ${name} is not allowed`);
	const effects = disallowedEffects(policy, entry.effects);
	if (effects.length)
		status.policy.push(`effects not allowed: ${effects.join(", ")}`);
	const signers = policySigners(policy);
	let directory: string;
	try {
		directory = approvalDirectory(root, name, version);
	} catch (error) {
		status.problems.push(errorMessage(error));
		return status;
	}
	if (!existsSync(directory)) return status;
	const relative = (file: string) =>
		path.relative(root, file).split(path.sep).join("/");
	for (const file of readdirSync(directory).sort()) {
		if (!file.endsWith(".json")) continue;
		const payloadFile = path.join(directory, file);
		const principal = file.slice(0, -".json".length);
		try {
			const payload = parsePayload(readFileSync(payloadFile, "utf8"));
			if (payload.principal !== principal)
				throw new Error(`names principal ${payload.principal}`);
			if (payload.package !== name || payload.version !== version)
				throw new Error(
					`approves ${payload.package}@${payload.version}, not ${name}@${version}`,
				);
			if (payload.sha256 !== entry.sha256)
				throw new Error(
					`approves digest ${payload.sha256}, but the library's ${version} is ${entry.sha256}`,
				);
			if (payload.revisionDigest !== entry.revisionDigest)
				throw new Error("approves a different revision");
			if (!approverAllowed(policy, principal))
				throw new Error(`${principal} is not an allowed approver here`);
			const sigFile = `${payloadFile}.sig`;
			if (!existsSync(sigFile)) throw new Error("no .sig file");
			const verified = verifySshSignature({
				message: canonicalPayload(payload),
				signature: readFileSync(sigFile, "utf8"),
				namespace: APPROVAL_NAMESPACE,
				principal,
				signers,
			});
			status.approvedBy.push({
				principal,
				fingerprint: verified.fingerprint,
				keyType: verified.keyType,
				approvedAt: payload.approvedAt,
			});
		} catch (error) {
			status.problems.push(`${relative(payloadFile)}: ${errorMessage(error)}`);
		}
	}
	if (status.approvedBy.length) status.status = "approved";
	return status;
}

/** One line for text output: "approved by a, b" or "not approved (...)". */
export function describeApproval(status: ApprovalStatus | null) {
	if (!status) return null;
	const parts = [
		status.status === "approved"
			? `approved by ${status.approvedBy.map((a) => `${a.principal} (${a.keyType === "ssh-ed25519" ? "key" : "hardware key"})`).join(", ")}`
			: "not approved",
		...status.policy.map((p) => `policy: ${p}`),
		...status.problems.map((p) => `ignored: ${p}`),
	];
	return parts.join("; ");
}

// --- approve

function publicKeyFor(key: string) {
	const pub = key.endsWith(".pub") ? key : `${key}.pub`;
	if (!existsSync(pub))
		throw new Error(
			`${pub}: not found; signing_key must be a key whose .pub file is next to it, or the .pub of a key in ssh-agent`,
		);
	const [, base64] = readFileSync(pub, "utf8").trim().split(/\s+/);
	return parsePublicKey(Buffer.from(base64 ?? "", "base64"));
}

/**
 * Sign an approval for one library version with `ssh-keygen -Y sign`, write it under
 * .agent-profiles/approvals/, then verify it as `approvalStatus` will. A hardware
 * key asks for a touch on the terminal. A failed signature or verification leaves
 * nothing behind.
 */
export function approvePackage({
	root,
	storeRoot,
	name,
	version,
	key,
	principal,
	now = new Date(),
	sshKeygen = "ssh-keygen",
}: {
	root: string;
	storeRoot?: string;
	name: string;
	version: string;
	key?: string;
	principal?: string;
	now?: Date;
	sshKeygen?: string;
}) {
	const policy = loadTrustPolicy({ root });
	if (!policy?.allowedSigners)
		throw new Error(
			"library approve needs a trust policy with allowed_signers (~/.agent-profiles/trust.yaml); see docs/trust.md",
		);
	const signingKey = key ?? policy.signingKey;
	if (!signingKey)
		throw new Error(
			"library approve needs a key: set signing_key in ~/.agent-profiles/trust.yaml or pass --key",
		);
	const publicKey = publicKeyFor(path.resolve(signingKey));
	const signers = policySigners(policy);
	const entries = signers.filter((s) => s.key.blob.equals(publicKey.blob));
	if (!entries.length)
		throw new Error(
			`key ${publicKey.fingerprint} is not in allowed_signers ${policy.allowedSigners}`,
		);
	if (!principal) {
		const named = [
			...new Set(
				entries.flatMap((s) =>
					s.principals.filter((p) => PRINCIPAL.test(p) && !/[*?]/.test(p)),
				),
			),
		];
		if (named.length !== 1)
			throw new Error(
				`key ${publicKey.fingerprint} is listed for ${named.length ? named.join(", ") : "pattern principals only"}; pass --principal`,
			);
		principal = named[0];
	}
	if (!PRINCIPAL.test(principal))
		throw new Error(
			`${principal}: a principal must be letters, digits and @ . _ + -`,
		);
	if (!entries.some((s) => principalAllowed(s.principals, principal)))
		throw new Error(
			`allowed_signers doesn't list key ${publicKey.fingerprint} for ${principal}`,
		);
	if (!approverAllowed(policy, principal))
		throw new Error(`${principal} is not an allowed approver for this project`);
	const [entry] = libraryInfo({ storeRoot, name, version }).versions;
	if (!entry) throw new Error(`${name}@${version} is not in the library`);
	if ("error" in entry)
		throw new Error(`${name}@${version} is not verified: ${entry.error}`);
	const payload: ApprovalPayload = {
		schema: 1,
		package: name,
		version,
		sha256: entry.sha256,
		revisionDigest: entry.revisionDigest,
		principal,
		approvedAt: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
	};
	const directory = approvalDirectory(root, name, version);
	mkdirSync(directory, { recursive: true });
	const file = path.join(directory, `${principal}.json`);
	const sig = `${file}.sig`;
	const previous = [file, sig].map((f) =>
		existsSync(f) ? readFileSync(f) : null,
	);
	const restore = () =>
		[file, sig].forEach((f, i) => {
			const bytes = previous[i];
			if (bytes) writeFileSync(f, bytes);
			else rmSync(f, { force: true });
		});
	writeFileSync(file, canonicalPayload(payload));
	rmSync(sig, { force: true });
	// stdin/stderr stay on the terminal: a passphrase prompt or a touch request.
	const signed = spawnSync(
		sshKeygen,
		[
			"-Y",
			"sign",
			"-f",
			path.resolve(signingKey),
			"-n",
			APPROVAL_NAMESPACE,
			file,
		],
		{ stdio: ["inherit", "ignore", "inherit"] },
	);
	if (signed.error || signed.status !== 0 || !existsSync(sig)) {
		restore();
		throw new Error(
			`ssh-keygen -Y sign failed${signed.error ? `: ${errorMessage(signed.error)}` : ` (exit ${signed.status})`}; nothing was written`,
		);
	}
	const status = approvalStatus({
		root,
		storeRoot,
		name,
		version,
		policy,
	});
	const mine = status?.approvedBy.find((a) => a.principal === principal);
	if (!mine) {
		const reason = status?.problems.find((p) =>
			p.includes(`${principal}.json`),
		);
		restore();
		throw new Error(
			`the new approval doesn't verify${reason ? ` (${reason})` : ""}; nothing was written`,
		);
	}
	const relative = (f: string) =>
		path.relative(root, f).split(path.sep).join("/");
	return {
		name,
		version,
		sha256: entry.sha256,
		principal,
		fingerprint: mine.fingerprint,
		keyType: mine.keyType,
		files: [relative(file), relative(sig)],
		policy: status?.policy ?? [],
	};
}

export function formatApproval(result: ReturnType<typeof approvePackage>) {
	return [
		`Approved ${result.name}@${result.version} (sha256 ${result.sha256})`,
		`  as ${result.principal} with ${result.keyType} ${result.fingerprint}`,
		`  wrote ${result.files.join(" and ")}; commit them with the project`,
		...result.policy.map((p) => `  Policy: ${p}`),
	].join("\n");
}
