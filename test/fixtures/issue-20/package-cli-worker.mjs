// Child-only native interception, following materialize-worker.mjs. Discovery is inert.

import childProcess from "node:child_process";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

if (process.argv[2] !== undefined) {
	const q = JSON.parse(process.argv[2]);
	const owned = fs.realpathSync(q.ownedRoot);
	const inside = (value) => {
		if (typeof value !== "string" || !path.isAbsolute(value)) return false;
		const relative = path.relative(owned, path.resolve(value));
		return (
			relative === "" ||
			(!path.isAbsolute(relative) &&
				relative !== ".." &&
				!relative.startsWith(`..${path.sep}`))
		);
	};
	const tempRelative = path.relative(fs.realpathSync(os.tmpdir()), owned);
	if (
		path.dirname(tempRelative) !== "." ||
		!path.basename(owned).startsWith("p9-cli-")
	)
		throw new Error("worker requires owned mkdtemp child");
	const check = (value) => {
		if (!inside(value)) throw new Error("worker path escapes owned root");
		let ancestor = path.resolve(value);
		while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
		if (!inside(fs.realpathSync(ancestor)))
			throw new Error("worker canonical path escapes owned root");
	};
	for (const value of [
		q.cwd,
		q.audit,
		q.storeRoot,
		q.destination,
		q.marker,
		q.release,
		q.drift?.file,
	].filter((v) => v !== undefined))
		check(value);
	if (q.argv !== undefined) {
		if (!Array.isArray(q.argv) || !q.argv.every((v) => typeof v === "string"))
			throw new Error("worker argv must be strings");
		for (let i = 0; i < q.argv.length; i++) {
			if (
				/^--(?:root|store|output-root|destination|protect-root|sources|source)=/.test(
					q.argv[i],
				)
			)
				throw new Error("worker requires separate owned path operands");
			if (
				[
					"--root",
					"--store",
					"--output-root",
					"--destination",
					"--protect-root",
					"--sources",
				].includes(q.argv[i])
			)
				check(q.argv[i + 1]);
			if (q.argv[i] === "--source") {
				const value = q.argv[i + (q.argv[0] === "install" ? 3 : 1)];
				// Remote inputs are inert parser/refusal controls; every local path remains owned.
				if (value !== undefined && !/^[a-z]+:\/\//i.test(value))
					check(path.resolve(q.cwd, value));
			}
		}
	}
	const original = Object.fromEntries(
		[
			"writeFileSync",
			"readFileSync",
			"openSync",
			"existsSync",
			"renameSync",
		].map((k) => [k, fs[k]]),
	);
	const counts = {
		backingReads: 0,
		renames: 0,
		drift: 0,
		dispatch: [],
		listen: 0,
	};
	const audit = () => {
		if (q.audit) original.writeFileSync(q.audit, JSON.stringify(counts));
	};
	process.once("exit", audit);
	const denied =
		(name) =>
		(...args) => {
			counts.dispatch.push({
				name,
				argv: name === "spawnSync" ? args[1] : null,
			});
			if (q.allowExecutableCounter && name === "spawnSync")
				return { status: 0, stdout: "", stderr: "" };
			throw new Error(`forbidden acquisition/dispatch: ${name}`);
		};
	for (const [target, names] of [
		[
			childProcess,
			[
				"spawn",
				"spawnSync",
				"exec",
				"execSync",
				"execFile",
				"execFileSync",
				"fork",
			],
		],
		[net, ["connect", "createConnection"]],
		[tls, ["connect"]],
		[http, ["request", "get"]],
		[https, ["request", "get"]],
		[dns, ["lookup", "resolve"]],
		[dns.promises, ["lookup", "resolve"]],
		[globalThis, ["fetch"]],
	])
		for (const name of names) target[name] = denied(name);
	net.Server.prototype.listen = () => {
		counts.listen++;
		throw new Error(
			"owned-listen-stop: resolver preflight reached native listener",
		);
	};
	const observe = (value) => {
		if (typeof value !== "string" || !q.storeRoot) return;
		const relative = path.relative(q.storeRoot, path.resolve(value));
		if (
			relative !== ".." &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative)
		)
			counts.backingReads++;
	};
	fs.openSync = (value, flags, ...rest) => {
		if (flags === "r" || (typeof flags === "number" && (flags & 3) === 0))
			observe(value);
		return original.openSync(value, flags, ...rest);
	};
	fs.readFileSync = (value, ...rest) => {
		observe(value);
		const bytes = original.readFileSync(value, ...rest);
		if (
			q.drift &&
			counts.drift === 0 &&
			typeof value === "string" &&
			path.resolve(value) === q.drift.file
		) {
			original.writeFileSync(
				q.drift.file,
				Buffer.from(q.drift.bytes, "base64"),
			);
			counts.drift++;
		}
		return bytes;
	};
	function beforeRename(from, to) {
		if (typeof to !== "string" || path.resolve(to) !== q.destination) return;
		check(path.resolve(from));
		check(path.resolve(to));
		counts.renames++;
		if (!q.marker) return;
		original.writeFileSync(q.marker, "before-final-rename");
		const wait = new Int32Array(new SharedArrayBuffer(4));
		while (!original.existsSync(q.release)) Atomics.wait(wait, 0, 0, 10);
	}
	fs.renameSync = (from, to) => {
		beforeRename(from, to);
		return original.renameSync(from, to);
	};
	const callbackRename = fs.rename;
	fs.rename = (from, to, callback) => {
		try {
			beforeRename(from, to);
		} catch (error) {
			queueMicrotask(() => callback(error));
			return;
		}
		callbackRename(from, to, callback);
	};
	const promiseRename = fs.promises.rename.bind(fs.promises);
	fs.promises.rename = async (from, to) => {
		beforeRename(from, to);
		await promiseRename(from, to);
	};
	syncBuiltinESMExports();
	if (q.op === "control") {
		const native = await import("node:fs");
		const cp = await import("node:child_process");
		const stage = path.join(owned, "control-stage");
		native.mkdirSync(stage);
		native.writeFileSync(
			path.join(stage, "raw"),
			Buffer.from([0, 255, 13, 10]),
		);
		if (q.entry === "promise")
			await native.promises.rename(stage, q.destination);
		else if (q.entry === "callback")
			await new Promise((resolve, reject) =>
				native.rename(stage, q.destination, (e) => (e ? reject(e) : resolve())),
			);
		else native.renameSync(stage, q.destination);
		const raw = native.readFileSync(path.join(q.destination, "raw"));
		for (const [name, run] of [
			["spawnSync", () => cp.spawnSync("never-run")],
			["fetch", () => fetch("https://invalid.example")],
		]) {
			let message;
			try {
				await run();
			} catch (error) {
				message = error.message;
			}
			if (message !== `forbidden acquisition/dispatch: ${name}`)
				throw new Error("dispatch interception control failed");
		}
		console.log(JSON.stringify({ raw: [...raw], counts }));
	} else if (q.op === "drift-control") {
		const { readPackage } = await import("../../../src/packages.js");
		const first = readPackage({ root: q.cwd });
		const second = readPackage({ root: q.cwd });
		console.log(
			JSON.stringify({
				first: first.manifest.package,
				second: second.manifest.package,
				counts,
			}),
		);
	} else if (q.op === "cli") {
		process.chdir(q.cwd);
		process.argv = [
			process.execPath,
			new URL("../../../bin/agent-profiles.js", import.meta.url).pathname,
			...q.argv,
		];
		await import("../../../bin/agent-profiles.js");
	} else throw new Error("unknown owned worker operation");
}
