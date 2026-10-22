#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { readConfiguration } from "../src/configure.ts";
import {
	formatContext,
	formatProof,
	resolutionOutput,
} from "../src/diagnostics.ts";
import { defaultUserRoots } from "../src/external-skills.js";
import { errorMessage } from "../src/files.ts";
import { formatInventory, inspectRepository } from "../src/inspect.js";
import {
	detectAgents,
	doctor,
	findRoot,
	install,
	installPackage,
	uninstall,
} from "../src/install.js";
import { integrations } from "../src/integrations.ts";
import { materializeStamp } from "../src/materialize.js";
import {
	abandonMigration,
	acceptMigrationProposal,
	applyMigrationPromotion,
	importMigrationEvaluationResults,
	migrationEvaluationReport,
	migrationProposals,
	migrationStatus,
	planMigrationEvaluation,
	previewMigrationPromotion,
	proposeMigration,
	publishMigrationCandidate,
	rejectMigrationProposal,
	startMigration,
} from "../src/migrations.js";
import { installDependencies } from "../src/package-lock.ts";
import { importPackage, rootPath } from "../src/package-store.ts";
import { readPackage } from "../src/packages.ts";
import { runPreset } from "../src/preset-wizard.ts";
import { resolveInstructions } from "../src/resolve.ts";
import { retainRevisionManifest } from "../src/revisions.ts";
import { discoverSkills } from "../src/skills.ts";
import { createStamp, diffStamps, verifyStamp } from "../src/stamps.ts";
import { startVisualizer } from "../src/visualize.ts";
import { configureRoles, display as displayText } from "../src/wizard.ts";

const agentChoices = integrations.map((adapter) => adapter.id).join(", ");
const display = (text) => displayText(text).replace(/[\x80-\x9f]/g, " ");

async function question(prompt) {
	if (!stdin.isTTY || !stdout.isTTY)
		throw new Error(
			"Interactive input is unavailable; configure requires a terminal, as do preset import/export. For init use --agent; for uninstall omit --delete-config.",
		);
	const reader = createInterface({ input: stdin, output: stdout });
	try {
		return await reader.question(prompt);
	} finally {
		reader.close();
	}
}

try {
	const { values, tokens } = parseArgs({
		allowPositionals: true,
		tokens: true,
		options: {
			root: { type: "string" },
			agent: { type: "string", multiple: true },
			"delete-config": { type: "boolean", default: false },
			help: { type: "boolean", short: "h" },
			role: { type: "string", multiple: true },
			contents: { type: "boolean", default: false },
			model: { type: "string" },
			family: { type: "string" },
			"identity-source": { type: "string" },
			host: { type: "string" },
			package: { type: "string" },
			skill: { type: "string", multiple: true },
			json: { type: "boolean", default: false },
			port: { type: "string" },
			external: { type: "boolean", default: false },
			sources: { type: "string" },
			store: { type: "string" },
			source: { type: "string", multiple: true },
			offline: { type: "boolean", default: false },
			"frozen-lockfile": { type: "boolean", default: false },
			adapter: { type: "string" },
			"output-root": { type: "string" },
			destination: { type: "string" },
			"protect-root": { type: "string", multiple: true },
			sharing: { type: "string" },
			reason: { type: "string" },
		},
	});
	let positionals = tokens
		.filter((token) => token.kind === "positional")
		.map((token) => token.value);
	const [command] = positionals;
	const packageCommands = [
		"add",
		"install",
		"stamp",
		"verify",
		"diff",
		"materialize",
		"migrate",
		"revision",
	];
	const sources = [];
	const sourceOperands = new Set();
	const seen = new Set();
	for (const [index, token] of tokens.entries()) {
		if (token.kind !== "option") continue;
		if (
			!["agent", "role", "skill", "source", "protect-root"].includes(
				token.name,
			) &&
			seen.has(token.name)
		)
			throw new Error(`--${token.name} may not repeat; use it once`);
		seen.add(token.name);
		if (token.name === "source" && command === "install") {
			const version = tokens[index + 1],
				directory = tokens[index + 2];
			if (version?.kind !== "positional" || directory?.kind !== "positional")
				throw new Error(
					"--source requires three operands: name version directory",
				);
			sources.push({
				name: token.value,
				version: version.value,
				directory: directory.value,
			});
			sourceOperands.add(version);
			sourceOperands.add(directory);
		}
	}
	if (command === "install")
		positionals = tokens.flatMap((token) =>
			token.kind === "positional" && !sourceOperands.has(token)
				? [token.value]
				: [],
		);
	if (values.help || !command) {
		console.log(`Usage: agent-profiles <command> [--root <directory>]

Commands:
  inspect     Inventory repository and machine metadata, even before init (read-only)
  init        Install bootstrap integrations and example configuration
  resolve     Print the resolved instructions for an agent to follow (read-only)
  configure   Create, edit, or delete roles and select skills (interactive)
  skills      Inspect bounded skill metadata and source availability (read-only)
  doctor      Validate configuration and report integration status (read-only)
  uninstall   Remove managed bootstrap blocks; retain configuration
  preset      Inspect, import, or export a local preset directory
  proof       Measure resolved instruction bytes and characters (read-only)
  visualize   Serve a local context explorer (read-only; Ctrl+C to stop)
  add         Import one @namespace/name@version from --source <local-directory>
  install     Install declared dependencies from repeatable --source <name> <version> <directory>
  stamp       Capture resolved instructions with the resolve selectors
  verify      Verify one full lowercase SHA-256 stamp digest in the store
  diff        Compare two full stamp digests
  materialize Export a stamp using --adapter filesystem-v1 --output-root <absolute-root>
              --destination <absolute-new-child> [--protect-root <absolute-path> ...]
  migrate     Develop isolated migration workspaces and review evidence-linked proposals
  revision    Adopt metadata for an existing immutable legacy release

Release metadata (declarations only; no workflow activation):
  revision record <manifest-file> [--store <directory>] [--json]

Migration workspaces (bounded task-only candidates, offline paired evidence and single-tuple promotion supported; provider execution not implemented):
  migrate start --role <id> --model <id> --host <id> --sharing fork|shared [--json]
  migrate status [<migration-id>] [--json]
  migrate abandon <migration-id> --reason <text> [--json]
  migrate propose <migration-id> <proposal-file> [--store <directory>] [--json]
  migrate proposals <migration-id> [--json]
  migrate accept <migration-id> <proposal-id> [--store <directory>] [--json]
  migrate reject <migration-id> <proposal-id> --reason <text> [--store <directory>] [--json]
  migrate candidate <migration-id> <candidate-file> [--store <directory>] [--json]
  migrate plan <candidate-id> <plan-file> [--store <directory>] [--json]
  migrate results <plan-id> <result-file> [--store <directory>] [--json]
  migrate report <result-id> [--store <directory>] [--json]
  migrate preview <decision-file> [--store <directory>] [--json]
  migrate promote <decision-file> [--store <directory>] [--json]

Agent context:
  resolve [--host <id>] [--model <id>] [--family <id>] [--identity-source host|host-stated|user]
          [--role <id>] [--skill <id> ...] [--json [--contents]]

Context proof:
  proof [--host <id>] [--model <id>] [--family <id>] [--role <id>] [--skill <id> ...]
        [--json [--contents]]

Setup inventory (works before init, including an empty/non-Git --root):
  inspect [--json] [--external] [--sources <approved-roots-json>]

Visualizer:
  visualize [--model <id>] [--family <id>] [--role <id>] [--skill <id> ...]
            [--port <0-65535>]  (default: an available local port)

Presets:
  preset inspect <directory> [--contents] [--role <id> ...]
  preset import <directory> [--role <id> ...]  (interactive confirmation)
  preset export <new-directory> [--role <id> ...]  (interactive selection)

Options:
  --root <directory>  Target repository (default: nearest Git root)
  --store <directory> Operational package/stamp store (overrides AGENT_PROFILES_STORE)
  --offline           For install: use local bytes only (no remote acquisition is supported)
  --frozen-lockfile   For install: require and preserve the current complete lock
  --agent <id>        Select ${agentChoices} for init; repeat for multiple agents
  --package <spec>    For init: install this agent-profiles package or tarball as a
                      dev dependency so the bootstrap command can run
  --external          Include external native skill inventory in inspect/skills/configure/doctor
  --sources <file>    Machine-local skill roots JSON; implies --external
  --delete-config     Also delete .agent-profiles during uninstall; asks to confirm
  -h, --help          Show this help

Examples:
  agent-profiles init --agent claude --agent codex
  agent-profiles configure
  agent-profiles doctor`);
	} else {
		if (command === "preset") {
			if (
				positionals.length !== 3 ||
				!["inspect", "import", "export"].includes(positionals[1])
			)
				throw new Error(
					"Usage: agent-profiles preset <inspect|import|export> <directory>",
				);
		} else if (command === "revision") {
			if (positionals.length !== 3 || positionals[1] !== "record")
				throw new Error(
					"Usage: revision record <manifest-file> [--root <directory>] [--store <directory>] [--json]",
				);
			for (const option of seen)
				if (!["root", "store", "json"].includes(option))
					throw new Error(`--${option} is not supported by revision record`);
		} else if (command === "migrate") {
			const action = positionals[1];
			const counts = {
				start: [2],
				status: [2, 3],
				abandon: [3],
				propose: [4],
				proposals: [3],
				accept: [4],
				reject: [4],
				candidate: [4],
				plan: [4],
				results: [4],
				report: [3],
				preview: [3],
				promote: [3],
			};
			if (
				!Object.hasOwn(counts, action) ||
				!counts[action].includes(positionals.length)
			)
				throw new Error(
					"Usage: migrate start | status [id] | abandon <id> --reason <text> | propose <id> <proposal-file> | proposals <id> | accept <id> <proposal-id> | reject <id> <proposal-id> --reason <text> | candidate <id> <candidate-file> | plan <candidate-id> <plan-file> | results <plan-id> <result-file> | report <result-id> | preview <decision-file> | promote <decision-file>; provider execution is not implemented",
				);
			const allowed =
				action === "start"
					? ["root", "store", "role", "model", "host", "sharing", "json"]
					: [
							"root",
							"json",
							...(action === "proposals" ? [] : ["store"]),
							...(["abandon", "reject"].includes(action) ? ["reason"] : []),
						];
			for (const option of seen)
				if (!allowed.includes(option))
					throw new Error(`--${option} is not supported by migrate ${action}`);
		} else if (packageCommands.includes(command)) {
			const count = {
				add: 2,
				install: 1,
				stamp: 1,
				verify: 2,
				diff: 3,
				materialize: 2,
			}[command];
			if (positionals.length !== count)
				throw new Error(
					`Usage: ${command} accepts exactly ${count - 1} positional argument(s)${command === "diff" ? ": two digests, before and after" : ""}`,
				);
		} else if (
			positionals.length !== 1 ||
			![
				"inspect",
				"init",
				"configure",
				"skills",
				"doctor",
				"uninstall",
				"resolve",
				"proof",
				"visualize",
			].includes(command)
		)
			throw new Error(
				"Choose one command: inspect, init, configure, skills, doctor, uninstall, resolve, preset, proof, visualize, add, install, stamp, verify, diff, materialize",
			);
		if (values.package !== undefined && command !== "init")
			throw new Error("--package is only supported by init");
		if (values.agent && command !== "init")
			throw new Error("--agent is only supported by init");
		if (values["delete-config"] && command !== "uninstall")
			throw new Error("--delete-config is only supported by uninstall");
		if (
			(values.sharing !== undefined || values.reason !== undefined) &&
			command !== "migrate"
		)
			throw new Error("--sharing and --reason are only supported by migrate");
		const resolving = ["resolve", "proof", "visualize", "stamp"].includes(
			command,
		);
		if (
			values.role &&
			!resolving &&
			command !== "preset" &&
			command !== "migrate"
		)
			throw new Error(
				"--role is only supported by preset, resolve, proof, visualize, stamp, or migrate start",
			);
		if (resolving && values.role?.length > 1)
			throw new Error(`${command} accepts one --role`);
		if (command === "migrate" && values.role?.length > 1)
			throw new Error("migrate start accepts one --role");
		if (
			(values.model !== undefined ||
				values.family !== undefined ||
				values.skill) &&
			!resolving &&
			command !== "migrate"
		)
			throw new Error(
				"--model, --family, and --skill are only supported by resolve, proof, or visualize",
			);
		if (
			values.host !== undefined &&
			!["resolve", "proof", "stamp", "migrate"].includes(command)
		)
			throw new Error(
				"--host is only supported by resolve, proof, stamp, or migrate start",
			);
		if (
			values["identity-source"] !== undefined &&
			!["resolve", "stamp"].includes(command)
		)
			throw new Error(
				"--identity-source is only supported by resolve or stamp",
			);
		if (
			values.json &&
			!["inspect", "resolve", "proof", "skills", ...packageCommands].includes(
				command,
			)
		)
			throw new Error(
				"--json is only supported by inspect, resolve, proof, skills, or package commands",
			);
		if (values.source && !["add", "install"].includes(command))
			throw new Error("--source is only supported by add or install");
		if ((values.offline || values["frozen-lockfile"]) && command !== "install")
			throw new Error(
				"--offline and --frozen-lockfile are only supported by install",
			);
		if (
			(values.adapter !== undefined ||
				values["output-root"] !== undefined ||
				values.destination !== undefined ||
				values["protect-root"]) &&
			command !== "materialize"
		)
			throw new Error(
				"--adapter, --output-root, --destination, and --protect-root are only supported by materialize",
			);
		if (values.store !== undefined && !values.store.trim())
			throw new Error("--store requires a directory");
		if (values.store !== undefined && command === "uninstall")
			throw new Error(
				"--store is only supported by commands using package or stamp context",
			);
		if (command === "add" && values.source?.length !== 1)
			throw new Error(
				"--source requires exactly one local directory and may not repeat",
			);
		if (
			command === "add" &&
			!/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(
				positionals[1],
			)
		)
			throw new Error(
				"package identity: expected @namespace/name@exact-version",
			);
		if (["verify", "diff", "materialize"].includes(command)) {
			for (const digest of positionals.slice(1))
				if (!/^[0-9a-f]{64}$/.test(digest))
					throw new Error(
						"digest: expected 64 lowercase hexadecimal characters",
					);
		}
		if (command === "materialize") {
			for (const name of ["adapter", "output-root", "destination"])
				if (values[name] === undefined || !values[name].trim())
					throw new Error(
						`--${name} is required for materialize${name === "adapter" ? "; use filesystem-v1" : ""}`,
					);
		}
		if (
			(values.external || values.sources !== undefined) &&
			!["inspect", "skills", "configure", "doctor"].includes(command)
		)
			throw new Error(
				"--external and --sources are only supported by inspect, skills, configure, or doctor",
			);
		if (values.sources !== undefined && !values.sources.trim())
			throw new Error("--sources requires a file");
		const discoveryOptions = {
			external: values.external || values.sources !== undefined,
			sourceOptions:
				values.sources === undefined
					? undefined
					: { sourcesFile: values.sources },
		};
		if (
			values.port !== undefined &&
			(command !== "visualize" || !/^\d+$/.test(values.port))
		)
			throw new Error(
				"--port requires an integer from 0 to 65535 and is only supported by visualize",
			);
		if (
			values.contents &&
			!(command === "preset" && positionals[1] === "inspect") &&
			!(["resolve", "proof"].includes(command) && values.json)
		)
			throw new Error(
				"--contents requires preset inspect, or resolve or proof with --json",
			);
		if (values.root !== undefined && !values.root.trim())
			throw new Error("--root requires a directory");
		let target = values.root;
		if (
			target === undefined &&
			(["add", "verify", "diff", "revision"].includes(command) ||
				(command === "migrate" && positionals[1] === "report"))
		)
			target = process.cwd();
		if (target === undefined) {
			try {
				target = findRoot();
			} catch (error) {
				if (
					command !== "inspect" &&
					(command !== "preset" || positionals[1] !== "inspect")
				)
					throw error;
				target = process.cwd();
			}
		}
		const root = realpathSync(target);
		const storeRoot = values.store;
		const selectors = {
			root,
			storeRoot,
			host: values.host,
			model: values.model,
			family: values.family,
			identitySource: /** @type {any} */ (values["identity-source"]),
			role: values.role?.[0],
			skills: values.skill,
		};
		const report = (result, label) =>
			console.log(
				values.json
					? JSON.stringify(result, null, 2)
					: `${display(label)}\n${JSON.stringify(result, null, 2).replace(/[\x7f-\x9f]/g, " ")}`,
			);
		if (
			!(command === "proof" && values.json) &&
			command !== "resolve" &&
			command !== "inspect" &&
			!(command === "skills" && values.json) &&
			!packageCommands.includes(command)
		)
			console.log(`Agent Profiles\nRepository: ${root}`);
		if (command === "revision") {
			report(
				retainRevisionManifest({ storeRoot, manifestFile: positionals[2] }),
				"Revision metadata recorded (declarations only)",
			);
		} else if (command === "migrate") {
			let result;
			switch (positionals[1]) {
				case "start":
					result = startMigration({
						root,
						storeRoot,
						role: values.role?.[0],
						model: values.model,
						host: values.host,
						sharing: values.sharing,
					});
					break;
				case "status":
					result = migrationStatus({ root, id: positionals[2] });
					break;
				case "abandon":
					result = abandonMigration({
						root,
						id: positionals[2],
						reason: values.reason,
					});
					break;
				case "propose":
					result = proposeMigration({
						root,
						storeRoot,
						id: positionals[2],
						proposalFile: positionals[3],
					});
					break;
				case "proposals":
					result = migrationProposals({ root, id: positionals[2] });
					break;
				case "accept":
					result = acceptMigrationProposal({
						root,
						storeRoot,
						id: positionals[2],
						proposalId: positionals[3],
					});
					break;
				case "reject":
					result = rejectMigrationProposal({
						root,
						storeRoot,
						id: positionals[2],
						proposalId: positionals[3],
						reason: values.reason,
					});
					break;
				case "candidate":
					result = publishMigrationCandidate({
						root,
						storeRoot,
						id: positionals[2],
						manifestFile: positionals[3],
					});
					break;
				case "plan":
					result = planMigrationEvaluation({
						root,
						storeRoot,
						candidateId: positionals[2],
						planFile: positionals[3],
					});
					break;
				case "results":
					result = importMigrationEvaluationResults({
						root,
						storeRoot,
						planId: positionals[2],
						resultFile: positionals[3],
					});
					break;
				case "report":
					result = migrationEvaluationReport({ storeRoot, id: positionals[2] });
					break;
				case "preview":
					result = previewMigrationPromotion({
						root,
						storeRoot,
						decisionFile: positionals[2],
					});
					break;
				case "promote":
					result = applyMigrationPromotion({
						root,
						storeRoot,
						decisionFile: positionals[2],
					});
					break;
			}
			const notes = {
				report: ` ${positionals[2]} — external claims; runtime unverified; promotion not authorized`,
				preview:
					" (read-only; nothing applied) — correctness is an external claim; runtime unverified",
				promote:
					" — exact evaluated tuple only; correctness is an external claim; runtime unverified",
			};
			report(
				result,
				`Migration ${positionals[1]}${notes[positionals[1]] ?? ""}`,
			);
		} else if (command === "add") {
			const sourceDirectory = rootPath(values.source[0], "source");
			const inspected = readPackage({ root: sourceDirectory });
			const identity = inspected.manifest.package;
			if (`${identity.name}@${identity.version}` !== positionals[1])
				throw new Error(
					"package identity mismatch: source manifest differs from supplied identity",
				);
			report(
				importPackage({
					sourceDirectory,
					storeRoot,
					expectedDigest: inspected.sha256,
				}),
				`Package ${positionals[1]}`,
			);
		} else if (command === "install") {
			installDependencies({
				root,
				storeRoot,
				sources,
				frozen: values["frozen-lockfile"],
				offline: values.offline,
			});
			report(
				{ lockState: "valid", installRequired: false },
				"Dependencies installed; lock valid",
			);
		} else if (command === "stamp") {
			report(createStamp(selectors), "Captured stamp");
		} else if (command === "verify") {
			const result = verifyStamp({ digest: positionals[1], storeRoot });
			report(result, `Stamp ${positionals[1]}`);
			if (!result.managedReproducible) process.exitCode = 1;
		} else if (command === "diff") {
			const result = diffStamps({
				before: positionals[1],
				after: positionals[2],
				storeRoot,
			});
			report(result, `Stamps ${positionals[1]} -> ${positionals[2]}`);
			if (!result.complete) process.exitCode = 1;
		} else if (command === "materialize") {
			const { claudeConfig, codexSkills } = defaultUserRoots();
			report(
				materializeStamp({
					stampDigest: positionals[1],
					storeRoot,
					adapterId: values.adapter,
					adapterContractVersion: 1,
					destination: values.destination,
					outputRoot: values["output-root"],
					deniedRoots: [
						root,
						claudeConfig,
						codexSkills,
						...(values["protect-root"] ?? []),
					],
				}),
				`Materialized stamp ${positionals[1]}`,
			);
		} else if (command === "inspect") {
			const result = inspectRepository({ root, ...discoveryOptions });
			console.log(
				values.json ? JSON.stringify(result, null, 2) : formatInventory(result),
			);
		} else if (command === "visualize") {
			const { server, url } = await startVisualizer({
				root,
				storeRoot,
				port: values.port === undefined ? 0 : Number(values.port),
				model: values.model,
				family: values.family,
				role: values.role?.[0],
				skills: values.skill,
			});
			console.log(
				`Context explorer: ${url}\nOpen this local URL in your browser. Read-only; press Ctrl+C to stop.`,
			);
			const stop = () => {
				server.close();
				server.closeAllConnections();
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		} else if (command === "resolve") {
			const result = resolveInstructions(selectors);
			console.log(
				values.json
					? JSON.stringify(resolutionOutput(result, values.contents), null, 2)
					: formatContext(
							result,
							storeRoot === undefined
								? undefined
								: { root, storeRoot: rootPath(storeRoot, "store") },
						),
			);
		} else if (command === "proof") {
			const result = resolveInstructions({
				root,
				storeRoot,
				host: values.host,
				model: values.model,
				family: values.family,
				role: values.role?.[0],
				skills: values.skill,
			});
			console.log(
				values.json
					? JSON.stringify(resolutionOutput(result, values.contents), null, 2)
					: formatProof(result),
			);
		} else if (command === "preset") {
			await runPreset({
				command: positionals[1],
				location: positionals[2],
				root,
				storeRoot,
				roles: values.role,
				contents: values.contents,
				ask: question,
			});
		} else if (command === "init") {
			let agents = values.agent;
			if (!agents) {
				const detected = detectAgents(root);
				if (detected.some((agent) => agent.installed)) {
					console.log(
						"Existing integrations: " +
							detected
								.filter((agent) => agent.installed)
								.map((agent) => agent.id)
								.join(", "),
					);
				}
				const defaults = detected
					.filter((agent) => agent.detected)
					.map((agent) => agent.id);
				const answer = await question(
					`Which coding agents? ${agentChoices}${defaults.length ? ` [${defaults.join(", ")}]` : ""}: `,
				);
				agents = answer.trim() ? answer.trim().split(/[\s,]+/) : defaults;
			}
			const result = install({ root, agents, storeRoot });
			for (const file of result.modified) console.log(`Updated ${file}`);
			if (!result.modified.length)
				console.log("Already installed. No changes required.");
			console.log(
				`Configuration validated. Default profile: ${result.profile}; default role: ${result.role}.`,
			);
			// The block is only useful once its command runs; install the package when asked to.
			// An explicit --package always installs: a matching version string does not prove matching code.
			let { availability } = result;
			let spec = values.package;
			if (
				spec === undefined &&
				!availability.runnable &&
				stdin.isTTY &&
				stdout.isTTY
			) {
				console.log(`The bootstrap cannot run yet: ${availability.reason}.`);
				spec =
					(
						await question(
							`Install agent-profiles as a dev dependency now? Package spec or tarball [agent-profiles@${result.ownVersion}], or "skip": `,
						)
					).trim() || `agent-profiles@${result.ownVersion}`;
				if (spec === "skip") spec = undefined;
			}
			if (spec !== undefined) availability = installPackage(root, spec);
			const report = doctor(root, { storeRoot });
			for (const problem of report.bootstrap)
				console.error(`Bootstrap: ${problem}`);
			if (report.bootstrap.length) {
				console.error(
					"The bootstrap is not runnable yet. Fix the items above, then run agent-profiles doctor.",
				);
				process.exitCode = 1;
			} else
				console.log(
					`Bootstrap runnable with agent-profiles ${availability.version}. Run agent-profiles doctor to inspect the installation.`,
				);
		} else if (command === "configure") {
			await configureRoles({
				root,
				storeRoot,
				ask: question,
				...discoveryOptions,
			});
		} else if (command === "skills") {
			const found = discoverSkills(
				root,
				readConfiguration(root, { storeRoot }).configuration,
				discoveryOptions,
			);
			if (values.json) console.log(JSON.stringify(found, null, 2));
			else {
				for (const skill of found.skills)
					console.log(
						`${display(skill.id)} — ${display(skill.name ?? skill.id)}\n  ${display(skill.description ?? "(no description)")}\n  ` +
							(skill.package
								? `Package ${display(skill.package.name)}@${display(skill.package.version)}; ${display(skill.availability)}; ${display(skill.verification)}`
								: `${display(skill.source)}; ${display(skill.host ?? "instruction")}/${display(skill.scope ?? "repository")}; ${display(skill.availability ?? "local metadata")}; ${display(skill.path ?? "(host-provided)")}`) +
							`${skill.resources?.length ? `\n  Resources: ${skill.resources.map(display).join(", ")}` : ""}`,
					);
				for (const warning of found.warnings)
					console.log(`Inventory: ${display(warning)}`);
				console.log(
					"Metadata is not proof of host enablement or native invocation.",
				);
			}
		} else if (command === "doctor") {
			const result = doctor(root, { storeRoot });
			if (result.profile)
				console.log(
					`Default profile: ${result.profile}; default role: ${result.role}`,
				);
			for (const agent of result.agents)
				console.log(
					`${agent.name}: ${agent.installed ? "bootstrap installed" : "not installed"} (${agent.file})`,
				);
			for (const note of result.notes) console.log(note);
			// Three independent questions: is the configuration valid, can the bootstrap run, can each host satisfy each role?
			const section = (title, problems, ok) => {
				console.log(
					`\n${title}: ${problems.length ? `${problems.length} problem${problems.length === 1 ? "" : "s"}` : ok}`,
				);
				for (const problem of problems) console.error(`  ${problem}`);
			};
			section("Configuration", result.errors, "valid");
			section(
				"Bootstrap availability",
				result.bootstrap,
				`runnable (agent-profiles ${result.availability.version})`,
			);
			section(
				"Host compatibility",
				result.capabilities,
				"no cross-host required-skill conflicts; native invocation not verified",
			);
			console.log(
				result.valid
					? "\nInstallation is ready."
					: "\nInstallation needs attention.",
			);
			if (discoveryOptions.external) {
				const found = discoverSkills(
					root,
					readConfiguration(root, { storeRoot }).configuration,
					discoveryOptions,
				);
				console.log(
					"\nExternal inventory (metadata only; native invocation unverified)",
				);
				for (const skill of found.skills.filter(
					(skill) => skill.host && skill.scope !== "project",
				))
					console.log(
						`  ${display(skill.id)}: ${display(skill.availability)} (${display(skill.host)}/${display(skill.scope)}; ${display(skill.path ?? "host-provided")})`,
					);
				for (const warning of found.warnings)
					console.log(`Inventory: ${display(warning)}`);
			}
			if (!result.valid) process.exitCode = 1;
		} else {
			let confirmed = false;
			if (values["delete-config"]) {
				confirmed =
					(await question(
						'Delete all user-authored files in .agent-profiles? Type "delete .agent-profiles" to confirm: ',
					)) === "delete .agent-profiles";
				if (!confirmed) throw new Error("Cancelled; no files changed");
			}
			const result = uninstall({
				root,
				deleteConfig: values["delete-config"],
				confirmed,
			});
			for (const file of result.modified) console.log(`Updated ${file}`);
			if (!result.modified.length)
				console.log("No managed integration blocks found.");
			console.log(
				result.configurationRetained
					? "Integration removed. Configuration retained in .agent-profiles/."
					: "Integration removed. No .agent-profiles/ directory remains.",
			);
		}
	}
} catch (error) {
	console.error(`Agent Profiles: ${display(errorMessage(error))}`);
	process.exitCode = 1;
}
