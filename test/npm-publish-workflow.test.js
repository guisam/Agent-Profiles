import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("npm publishing requires explicit dispatch and publishes the rehearsed tarball", () => {
	const workflow = parse(
		fs.readFileSync(
			new URL("../.github/workflows/publish.yml", import.meta.url),
			"utf8",
		),
	);
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
	const job = workflow.jobs.publish;
	assert.match(job.if, /github\.repository == 'guisam\/Agent-Profiles'/);
	assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
	assert.equal(job.permissions["id-token"], "write");
	assert.equal(job.environment, "npm");
	const setup = job.steps.find((step) =>
		step.uses?.startsWith("actions/setup-node@"),
	);
	assert.equal(setup.with["node-version"], 24);
	const publish = job.steps.find((step) => step.name === "Publish with OIDC");
	assert.equal(publish.if, "inputs.publish");
	const rehearsal = job.steps.find(
		(step) => step.name === "Rehearse publication",
	);
	assert.equal(rehearsal.run.replace(" --dry-run", ""), publish.run);
	assert.match(
		publish.run,
		/\$RUNNER_TEMP\/agent-profiles-\$RELEASE_VERSION\.tgz/,
	);
});
