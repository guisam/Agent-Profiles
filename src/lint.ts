// Instruction lint (#55 step 3): warnings, never blocks. Skills are text injected
// into an agent's context, so a package can carry prompt injection. These
// heuristics flag text that often signals it (hidden characters, instructions to
// override earlier rules or keep things from the user, sending data somewhere,
// shell commands in a package that doesn't declare them) so a person reads those
// lines before publishing or applying. They can't prove text is safe, and they
// will flag harmless text too. Deterministic: no model calls.

export type LintRule =
	| "hidden-text"
	| "html-comment"
	| "override"
	| "concealment"
	| "exfiltration"
	| "pipe-to-shell"
	| "shell"
	| "url"
	| "encoded";

export type LintFinding = {
	file: string;
	line: number;
	rule: LintRule;
	/** high: rarely legitimate in a skill; note: worth a look. */
	severity: "high" | "note";
	message: string;
	/** The line, trimmed to 160 characters, with invisible characters shown as \u{…}. */
	excerpt: string;
};

const HIDDEN = /[​-‍⁠-⁤‪-‮⁦-⁩­]|[\u{E0000}-\u{E007F}]/u;

const show = (text: string) =>
	text
		.replace(
			/[​-‍⁠-⁤‪-‮⁦-⁩­﻿]|[\u{E0000}-\u{E007F}]/gu,
			(char) => `\\u{${char.codePointAt(0)?.toString(16).toUpperCase()}}`,
		)
		.replace(/\t/g, " ")
		.trim()
		.slice(0, 160);

type LineRule = {
	rule: LintRule;
	severity: LintFinding["severity"];
	message: string;
	test: RegExp;
	/** Skip when the package declares this manifest effect. */
	unlessEffect?: string;
};

const SEND =
	"(?:send|post|upload|transmit|exfiltrate|forward|curl|wget|invoke-webrequest|invoke-restmethod)";
const SECRET =
	"(?:\\.env\\b|id_rsa|id_ed25519|\\.ssh\\b|\\.aws\\b|credentials?|api[ _-]?keys?|access[ _-]?tokens?|secrets?|passwords?|private[ _-]?keys?|cookies?|session[ _-]?tokens?)";

const LINE_RULES: LineRule[] = [
	{
		rule: "override",
		severity: "high",
		message:
			"asks the agent to set aside earlier or higher-priority instructions",
		test: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all|any|other|system|repository|user'?s?)\b[^.\n]{0,25}\b(?:instructions?|rules?|prompts?|guidelines?|messages?|directions?|polic(?:y|ies))\b/i,
	},
	{
		rule: "override",
		severity: "high",
		message: "tries to redefine the agent's role or instructions",
		test: /\b(?:you are now|from now on,? you|new (?:system )?instructions?:|your (?:real|true|new) (?:instructions|task|goal) (?:is|are)|enter (?:developer|debug|god) mode|(?:reveal|print|repeat|output) (?:your|the) system prompt)/i,
	},
	{
		rule: "concealment",
		severity: "high",
		message: "asks the agent to keep something from the user",
		test: /\b(?:do not|don't|never)\s+(?:tell|inform|mention(?: this)? to|alert|notify|show|reveal(?: this)? to)\s+(?:the\s+)?user\b|\bwithout\s+(?:telling|informing|asking|alerting|notifying)\s+(?:the\s+)?user\b|\b(?:keep|hide) (?:this|it|these) (?:secret|hidden|from (?:the )?user)\b/i,
	},
	{
		rule: "exfiltration",
		severity: "high",
		message: "sends secrets or local data somewhere",
		test: new RegExp(
			`\\b${SEND}\\b[^\\n]{0,80}${SECRET}|${SECRET}[^\\n]{0,80}\\b${SEND}\\b[^\\n]{0,40}\\b(?:to|into|at)\\b`,
			"i",
		),
	},
	{
		rule: "exfiltration",
		severity: "high",
		message: "sends data to an address",
		test: new RegExp(
			`\\b${SEND}\\b[^\\n]{0,60}\\b(?:to|into)\\s+(?:https?://|[\\w.-]+@[\\w-]+\\.[\\w.]+|[\\w-]+(?:\\.[\\w-]+)*\\.(?:com|net|org|io|dev|xyz|ru|cn|app|site|top|invalid)\\b)`,
			"i",
		),
	},
	{
		rule: "pipe-to-shell",
		severity: "high",
		message: "downloads and runs code",
		test: /\b(?:curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|iex|invoke-expression|pwsh|powershell)\b|\biex\s*\(\s*(?:new-object|iwr|irm|invoke-)/i,
	},
	{
		rule: "shell",
		severity: "note",
		message:
			"has a destructive or system-changing command, and the manifest doesn't declare the `commands` effect",
		test: /\b(?:rm\s+-rf|chmod\s+\+x|sudo\s+\S|Remove-Item\s+.*-Recurse|Set-ExecutionPolicy|reg\s+add|crontab\s+-)/i,
		unlessEffect: "commands",
	},
];

const URL = /\bhttps?:\/\/([^\s/)>\]"'`]+)/gi;
const BASE64 = /[A-Za-z0-9+/]{120,}={0,2}/;

/** Whether a file is text worth reading as instructions. */
const isText = (bytes: Buffer) => !bytes.includes(0);

/**
 * Lint every text file of a package. `effects` are the manifest's declared
 * effects: a declared `commands` effect quiets the plain shell note, and a
 * declared `external-references` effect quiets URL notes.
 */
export function lintPackage(
	files: { path: string; bytes: Buffer }[],
	effects: string[] = [],
): LintFinding[] {
	const findings: LintFinding[] = [];
	for (const file of files) {
		if (file.path === "package.yaml" || !isText(file.bytes)) continue;
		const text = file.bytes.toString("utf8");
		const lines = text.split(/\r?\n/);
		const add = (
			line: number,
			rule: LintRule,
			severity: LintFinding["severity"],
			message: string,
		) =>
			findings.push({
				file: file.path,
				line,
				rule,
				severity,
				message,
				excerpt: show(lines[line - 1] ?? ""),
			});
		lines.forEach((raw, index) => {
			const line = index + 1;
			// A byte-order mark at the very start is ordinary; anywhere else it isn't.
			const content = index === 0 ? raw.replace(/^﻿/, "") : raw;
			if (HIDDEN.test(content) || content.includes("﻿"))
				add(
					line,
					"hidden-text",
					"high",
					"contains invisible or direction-changing characters that can hide text from a reader",
				);
			for (const rule of LINE_RULES) {
				if (rule.unlessEffect && effects.includes(rule.unlessEffect)) continue;
				if (rule.test.test(content))
					add(line, rule.rule, rule.severity, rule.message);
			}
			if (!effects.includes("external-references"))
				for (const match of content.matchAll(URL))
					add(
						line,
						"url",
						"note",
						`links to ${match[1].toLowerCase()}; check it's expected, since the agent may follow it`,
					);
			if (BASE64.test(content))
				add(
					line,
					"encoded",
					"note",
					"contains a long encoded-looking string that a reader can't check by eye",
				);
		});
		// HTML comments don't render in Markdown, so a reader of the rendered skill misses them.
		for (const match of text.matchAll(/<!--([\s\S]*?)-->/g)) {
			if (!match[1].trim()) continue;
			const line = text.slice(0, match.index).split(/\r?\n/).length;
			add(
				line,
				"html-comment",
				"note",
				"has an HTML comment, which rendered Markdown hides but the agent still reads",
			);
		}
	}
	// One finding per file, line and rule.
	const seen = new Set<string>();
	return findings
		.filter((finding) => {
			const key = `${finding.file}:${finding.line}:${finding.rule}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(a, b) =>
				a.file.localeCompare(b.file) ||
				a.line - b.line ||
				a.rule.localeCompare(b.rule),
		);
}

/**
 * Findings in `after` that `before` didn't have, matched by file, rule and line text
 * (not line number), so moved lines aren't reported as new.
 */
export function newFindings(before: LintFinding[], after: LintFinding[]) {
	const old = new Set(before.map((f) => `${f.file}\0${f.rule}\0${f.excerpt}`));
	return after.filter((f) => !old.has(`${f.file}\0${f.rule}\0${f.excerpt}`));
}

export function formatLint(
	findings: (LintFinding & { new?: boolean })[],
	indent = "  ",
) {
	if (!findings.length) return [`${indent}Lint: no findings`];
	const high = findings.filter((f) => f.severity === "high").length;
	return [
		`${indent}Lint (heuristics; never blocks): ${findings.length} finding${findings.length === 1 ? "" : "s"}${high ? `, ${high} high` : ""}. Read these lines:`,
		...findings.map(
			(f) =>
				`${indent}  ${f.severity === "high" ? "HIGH" : "note"} ${f.file}:${f.line} ${f.rule}${f.new === false ? " (also in the current version)" : ""}: ${f.message}\n${indent}    ${f.excerpt}`,
		),
	];
}
