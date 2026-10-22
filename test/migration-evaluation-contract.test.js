import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { stringify } from 'yaml';
import { canonicalEvaluationJSON as canonicalJSON, hashEvaluationRecord as hashRecord, readPackage } from '../src/packages.js';
import { importPackage } from '../src/package-store.js';
import { retainRevisionManifest, readRevisionRecord } from '../src/revisions.js';
import { installDependencies } from '../src/package-lock.js';
import { resolveInstructions } from '../src/resolve.js';
import { createStamp, verifyStamp, reconstructStamp } from '../src/stamps.js';
import * as migrations from '../src/migrations.js';

const requiredExports = ['planMigrationEvaluation', 'migrationEvaluationPlan', 'importMigrationEvaluationResults', 'migrationEvaluationReport'];
const ready = requiredExports.every(name => typeof migrations[name] === 'function');
const evidenceTest = (name, body) => test(name, { skip: ready ? false : 'paired evidence interface absent; downstream body UNEXECUTED' }, body);
const cli = fileURLToPath(new URL('../bin/agent-profiles.js', import.meta.url));
const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const scope = { role: 'worker', model: 'local-llm', host: 'claude' };
const protocol = '@example/checkin';
function files(root) {
  const rows = [];
  function visit(relative = '') {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const member = relative ? `${relative}/${name}` : name, stat = fs.lstatSync(path.join(root, member));
      if (stat.isSymbolicLink()) rows.push([member, 'link', fs.readlinkSync(path.join(root, member))]);
      else if (stat.isDirectory()) { rows.push([member, 'directory']); visit(member); }
      else rows.push([member, stat.nlink, fs.readFileSync(path.join(root, member)).toString('hex')]);
    }
  }
  visit(); return rows;
}
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-evidence-'))), originalStore = process.env.AGENT_PROFILES_STORE;
  t.after(() => {
    if (originalStore === undefined) delete process.env.AGENT_PROFILES_STORE; else process.env.AGENT_PROFILES_STORE = originalStore;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const root = path.join(dir, 'project'), storeRoot = path.join(dir, 'store'), sources = path.join(dir, 'sources');
  const ambient = path.join(dir, 'ambient'), home = path.join(dir, 'home');
  fs.mkdirSync(home); put(path.join(ambient, 'marker'), 'Unrelated ambient bytes\r\n'); process.env.AGENT_PROFILES_STORE = ambient;
  const packages = new Map();
  for (const key of ['helper', 'reviewer']) {
    const name = `@example/eval-${key}`, source = path.join(sources, key);
    const task = `---\r\nname: eval-${key}\r\ndescription: Fictional ${key}\r\n---\r\n# ${key} café  \r\n`;
    const workflow = `# ${key} workflow\r\nRetain exact check-in evidence.  \r\n`;
    put(path.join(source, 'package.yaml'), stringify({ schema_version: 1, package: { name, version: '1.2.3', type: 'skill' },
      entrypoint: 'SKILL.md', behavior: { delivery: 'instruction', hosts: [], effects: [] } }));
    put(path.join(source, 'SKILL.md'), task); put(path.join(source, 'WORKFLOW.md'), workflow); put(path.join(source, 'resource.bin'), Buffer.from([0, 255, 13, 10]));
    packages.set(key, { ...importPackage({ sourceDirectory: source, storeRoot }), task, workflow });
  }
  const reviewer = packages.get('reviewer'), helper = packages.get('helper');
  const configFile = path.join(root, '.agent-profiles/agents.yaml'), lockFile = path.join(root, '.agent-profiles/agent-profiles.lock');
  const config = { version: 2, default_profile: 'base', default_role: 'worker', models: { 'local-llm': { profile: 'base' } }, families: {},
    roles: { worker: { file: 'roles/worker.md', skills: { required: ['review'], available: [] } } },
    skills: { review: { package: reviewer.identity.name, version: reviewer.identity.version } } };
  put(configFile, stringify(config)); put(path.join(root, '.agent-profiles/profiles/base.md'), '\uFEFF# Base\r\n');
  put(path.join(root, '.agent-profiles/roles/worker.md'), '# Worker\r\n'); put(path.join(root, 'AGENTS.md'), '# Owned fixture rules\n');
  installDependencies({ root, storeRoot });
  const input = { root, storeRoot, ...scope }, migration = migrations.startMigration({ ...input, sharing: 'fork' });
  const records = new Map();
  for (const key of ['helper', 'reviewer']) {
    const pkg = packages.get(key), manifest = { revisionVersion: 1, kind: 'release', identity: pkg.identity,
      content: { identity: pkg.identity, sha256: pkg.sha256 }, parent: null, candidate: null,
      dependencies: key === 'helper' ? [] : [{ ...helper.identity, sha256: helper.sha256, revisionDigest: records.get('helper').recordDigest }],
      workflow: { file: 'WORKFLOW.md', provides: key === 'helper' ? [{ protocol, major: 1 }] : [], requires: key === 'helper' ? [] : [{ protocol, major: 1 }] },
      provenance: { kind: 'legacy-adoption', workflowChange: { kind: 'initial', reason: 'Owned declaration; no compliance or attribution proof.' } } };
    const adoption = path.join(dir, `${key}-adoption.json`); put(adoption, JSON.stringify(manifest));
    records.set(key, retainRevisionManifest({ storeRoot, manifestFile: adoption }));
  }
  config.version = 3; config.skills.review.revision = records.get('reviewer').recordDigest;
  config.workflow_links = { checkin: { protocol, consumer: { assignment: scope, binding: 'skills.review' }, providers: [{ assignment: scope, binding: 'skills.review' }] } };
  put(configFile, stringify(config)); installDependencies({ root, storeRoot });
  const base = createStamp(input), workspace = path.join(root, migration.workspace), tree = path.join(workspace, 'packages', reviewer.sha256);
  const after = reviewer.task + 'Check stale evidence before reporting.\r\n', proposalFile = path.join(dir, 'proposal.json');
  put(proposalFile, JSON.stringify({ proposalVersion: 1, classification: 'package', target: { path: `packages/${reviewer.sha256}/SKILL.md` },
    change: { before: reviewer.task, after }, evidence: [{ sessionId: 'unverified-fixture-session', excerpt: 'Caller claims a stale check was missed.', baseStamp: migration.bases[0].stamp }] }));
  const proposal = migrations.proposeMigration({ root, storeRoot, id: migration.id, proposalFile });
  migrations.acceptMigrationProposal({ root, storeRoot, id: migration.id, proposalId: proposal.id });
  const candidateFile = path.join(dir, 'candidate.json');
  put(candidateFile, JSON.stringify({ candidateVersion: 1, id: 'eval-candidate', binding: 'skills.review', release: { name: reviewer.identity.name, version: '2.0.0' },
    migrationBase: migration.bases[0].stamp, evaluationBase: base.digest, configSha256: JSON.parse(fs.readFileSync(lockFile, 'utf8')).configSha256,
    expectedTreeSha256: readPackage({ root: tree }).sha256, proposalIds: [proposal.id], workflowChange: { kind: 'task-only', reason: 'Retain accepted task; no changed workflow.' } }));
  const candidate = migrations.publishMigrationCandidate({ root, storeRoot, id: migration.id, manifestFile: candidateFile });
  const candidateSnapshot = JSON.parse(fs.readFileSync(path.join(storeRoot, 'stamps/sha256', candidate.stampDigest, 'snapshot.json'), 'utf8'));
  const target = (member, declaration = null) => ({ assignment: { ...scope }, binding: 'skills.review', member, protocol: declaration });
  const plan = { planVersion: 1, id: 'paired-plan', candidateId: candidate.id, candidateRevisionDigest: candidate.revisionDigest, baseStamp: base.digest, candidateStamp: candidate.stampDigest,
    context: { assignment: { ...scope }, requestedSkills: [], workflowPeers: { base: base.snapshot.workflowPeers, candidate: candidateSnapshot.workflowPeers } },
    cases: [
      { id: 'fix', kind: 'motivating', input: 'Fictional stale evidence', expected: 'Refuse stale evidence', target: target(reviewer.identity.name) },
      { id: 'retain', kind: 'regression', input: 'Fictional valid review', expected: 'Keep exact review outcome', target: target(reviewer.identity.name) },
      { id: 'checkin', kind: 'workflow', input: 'Fictional handoff', expected: 'Retain check-in obligations', target: target(reviewer.identity.name, { protocol, major: 1 }) },
      { id: 'helper', kind: 'collateral', input: 'Fictional helper interaction', expected: 'Preserve helper behavior within primary trial', target: target(helper.identity.name) },
    ], trials: 2, conditions: {
      harness: { id: 'fictional-harness', version: 'offline-1', settings: { seed: 17, temperature: 0 } },
      judge: { id: 'fictional-judge', version: 'claim-1', settings: { temperature: 0 } },
      rubric: { id: 'literal-checks', version: '1', settings: { strict: true } },
    } };
  const planFile = path.join(dir, 'plan.json'), resultFile = path.join(dir, 'results.json'); put(planFile, JSON.stringify(plan));
  return { dir, root, storeRoot, ambient, home, sources, configFile, lockFile, input, migration, packages, records, base, candidate, candidateSnapshot, plan, planFile, resultFile, after };
}
const roots = f => [f.root, f.storeRoot, f.ambient].map(files);
const retainPlan = f => migrations.planMigrationEvaluation({ root: f.root, storeRoot: f.storeRoot, candidateId: f.candidate.id, planFile: f.planFile });
const readPlan = f => migrations.migrationEvaluationPlan({ storeRoot: f.storeRoot, id: f.plan.id });
const ingest = f => migrations.importMigrationEvaluationResults({ root: f.root, storeRoot: f.storeRoot, planId: f.plan.id, resultFile: f.resultFile });
const report = (f, id = 'paired-results') => migrations.migrationEvaluationReport({ storeRoot: f.storeRoot, id });
function outcomes(f, retained, id = 'paired-results') {
  return { resultVersion: 1, id, planDigest: retained.planDigest, candidateRevisionDigest: f.candidate.revisionDigest,
    conditions: { base: structuredClone(f.plan.conditions), candidate: structuredClone(f.plan.conditions) },
    outcomes: f.plan.cases.flatMap(c => [1, 2].flatMap(trial => ['base', 'candidate'].map(side => ({ caseId: c.id, trial, side,
      stampDigest: side === 'base' ? f.base.digest : f.candidate.stampDigest, assignment: { ...scope }, correct: side === 'candidate' || c.id !== 'fix',
      metrics: side === 'base' ? { costUsd: 2.25, tokens: 100, turns: 4, toolCalls: 3, latencyMs: 10 } : { costUsd: 1.25, tokens: 80, turns: 3, toolCalls: 2, latencyMs: 8 },
      evidenceRef: `opaque:caller-claim/${c.id}/${trial}/${side}` })))) };
}
function retainedPair(f) {
  const planned = retainPlan(f), results = outcomes(f, planned); put(f.resultFile, JSON.stringify(results));
  return { planned, results, imported: ingest(f) };
}
function refuses(f, operation, diagnostic) {
  const before = roots(f); assert.throws(operation, diagnostic); assert.deepEqual(roots(f), before);
}
function child(f, args, withRoot = true) {
  return spawnSync(process.execPath, [cli, ...args, ...(withRoot ? ['--root', f.root] : []), '--store', f.storeRoot], { cwd: f.dir, encoding: 'utf8',
    env: { ...process.env, AGENT_PROFILES_STORE: f.ambient, TMP: f.dir, TEMP: f.dir, TMPDIR: f.dir, HOME: f.home, USERPROFILE: f.home,
      CODEX_HOME: path.join(f.home, '.codex'), CLAUDE_CONFIG_DIR: path.join(f.home, '.claude') } });
}

test('evaluation fixture retains a real candidate base workflow closure and caller claims read-only', t => {
  const f = fixture(t), before = roots(f), rebuilt = reconstructStamp({ storeRoot: f.storeRoot, digest: f.candidate.stampDigest });
  assert.equal(verifyStamp({ storeRoot: f.storeRoot, digest: f.base.digest }).managedReproducible, true);
  assert.equal(verifyStamp({ storeRoot: f.storeRoot, digest: f.migration.bases[0].stamp }).managedReproducible, true);
  assert.equal(rebuilt.capture.kind, 'candidate'); assert.equal(rebuilt.workflowPeers[0].provider.revisionDigest, f.records.get('helper').recordDigest);
  assert.deepEqual(rebuilt.composition.find(e => e.package?.revisionDigest === f.candidate.revisionDigest && e.kind !== 'workflow').bytes, Buffer.from(f.after));
  assert.deepEqual(rebuilt.composition.find(e => e.package?.revisionDigest === f.candidate.revisionDigest && e.kind === 'workflow').bytes, Buffer.from(f.packages.get('reviewer').workflow));
  assert.equal(rebuilt.packages.length, 2); assert.equal(resolveInstructions(f.input).workflow.runtime, 'unverified');
  assert.equal(migrations.migrationCandidate({ storeRoot: f.storeRoot, id: f.candidate.id }).stampDigest, f.candidate.stampDigest);
  assert.equal(readRevisionRecord({ storeRoot: f.storeRoot, recordDigest: f.candidate.revisionDigest }).provenance.proposals[0].proposal.evidence[0].sessionId, 'unverified-fixture-session');
  assert.deepEqual(roots(f), before);
});

test('paired evaluation public retention ingestion and report interfaces exist', () => {
  assert.deepEqual(requiredExports.filter(name => typeof migrations[name] !== 'function'), [], 'existing migrations module must expose the paired evidence interface');
});

evidenceTest('evaluation plan retains exact immutable context cases conditions and non-repointing identity', t => {
  const f = fixture(t), project = files(f.root), ambient = files(f.ambient), candidate = migrations.migrationCandidate({ storeRoot: f.storeRoot, id: f.candidate.id });
  const retained = retainPlan(f), planDigest = hashRecord('agent-profiles/evaluation-plan/v1', f.plan);
  assert.deepEqual(retained, { id: f.plan.id, planDigest, status: 'published' });
  assert.deepEqual(readPlan(f), { planDigest, plan: f.plan });
  assert.deepEqual(fs.readFileSync(path.join(f.storeRoot, 'evaluations/plans/sha256', `${planDigest}.json`)), canonicalJSON(f.plan));
  const before = roots(f); assert.deepEqual(retainPlan(f), { ...retained, status: 'reused' }); assert.deepEqual(roots(f), before);
  const changed = structuredClone(f.plan); changed.conditions.harness.settings.seed = 18; put(f.planFile, JSON.stringify(changed));
  refuses(f, () => retainPlan(f), /immutable|conflict|repoint|already/i);
  assert.deepEqual(readPlan(f), { planDigest, plan: f.plan });
  assert.deepEqual(files(f.root), project); assert.deepEqual(files(f.ambient), ambient);
  assert.deepEqual(migrations.migrationCandidate({ storeRoot: f.storeRoot, id: f.candidate.id }), candidate);
});

evidenceTest('complete paired claims report exact per-case correctness and comparable efficiency without activation', t => {
  const f = fixture(t), project = files(f.root), ambient = files(f.ambient), pair = retainedPair(f), r = report(f);
  assert.deepEqual(pair.imported, { id: 'paired-results', planDigest: pair.planned.planDigest, resultDigest: hashRecord('agent-profiles/evaluation-result/v1', pair.results), status: 'published' });
  assert.deepEqual(fs.readFileSync(path.join(f.storeRoot, 'evaluations/results/sha256', `${pair.imported.resultDigest}.json`)), canonicalJSON(pair.results));
  assert.deepEqual(r.evidence, { integrity: 'verified', workflow: 'declared-compatible', correctness: 'external-claim', runtime: 'unverified', promotion: 'not-authorized' });
  assert.equal(r.baseStamp, f.base.digest); assert.deepEqual(r.candidate, { id: f.candidate.id, revisionDigest: f.candidate.revisionDigest, stampDigest: f.candidate.stampDigest });
  assert.deepEqual(r.context, f.plan.context); assert.deepEqual(r.cases.map(c => c.kind), ['motivating', 'regression', 'workflow', 'collateral']);
  assert.deepEqual(r.cases[0].base, { passed: 0, trials: 2, rate: 0 }); assert.deepEqual(r.cases[0].candidate, { passed: 2, trials: 2, rate: 1 });
  assert.deepEqual(r.cases[1].base, { passed: 2, trials: 2, rate: 1 }); assert.deepEqual(r.cases[1].candidate, { passed: 2, trials: 2, rate: 1 });
  assert.deepEqual(r.eligibility, { status: 'eligible', regressions: [] });
  assert.deepEqual(r.metrics.tokens, { expectedPairs: 8, availablePairs: 8, baseTotal: 800, candidateTotal: 640, delta: -160, paired: { base: 800, candidate: 640, delta: -160 } });
  assert.deepEqual(r.metrics.costUsd, { expectedPairs: 8, availablePairs: 8, baseTotal: 18, candidateTotal: 10, delta: -8, paired: { base: 18, candidate: 10, delta: -8 } });
  assert.equal(r.metrics.turns.delta, -8); assert.equal(r.metrics.toolCalls.delta, -8); assert.equal(r.metrics.latencyMs.delta, -16);
  assert.equal(r.cases[0].metrics.tokens.delta, -40);
  const before = roots(f); assert.deepEqual(ingest(f), { ...pair.imported, status: 'reused' }); assert.deepEqual(roots(f), before);
  pair.results.outcomes[0].metrics.costUsd = 3; put(f.resultFile, JSON.stringify(pair.results));
  refuses(f, () => ingest(f), /immutable|conflict|repoint|already/i); assert.deepEqual(report(f), r);
  assert.deepEqual(files(f.root), project); assert.deepEqual(files(f.ambient), ambient);
});

evidenceTest('one per-case correctness drop blocks despite aggregate correctness and efficiency gains', t => {
  const f = fixture(t), planned = retainPlan(f), results = outcomes(f, planned);
  results.outcomes.find(row => row.caseId === 'retain' && row.side === 'candidate' && row.trial === 1).correct = false;
  put(f.resultFile, JSON.stringify(results)); ingest(f); const r = report(f);
  assert.deepEqual(r.eligibility, { status: 'blocked', regressions: [{ caseId: 'retain', basePassed: 2, candidatePassed: 1, trials: 2, reason: 'per-case-correctness-drop' }] });
  assert.deepEqual(r.cases[1].candidate, { passed: 1, trials: 2, rate: 0.5 });
  assert.equal(r.cases.reduce((n, c) => n + c.base.passed, 0), 6); assert.equal(r.cases.reduce((n, c) => n + c.candidate.passed, 0), 7);
  assert.equal(r.metrics.tokens.delta, -160); assert.equal(r.evidence.promotion, 'not-authorized');
});

evidenceTest('unchanged correctness still reports efficiency improvement', t => {
  const f = fixture(t), planned = retainPlan(f), results = outcomes(f, planned);
  for (const row of results.outcomes) if (row.caseId === 'fix' && row.side === 'candidate') row.correct = false;
  put(f.resultFile, JSON.stringify(results)); ingest(f); const r = report(f);
  assert.equal(r.eligibility.status, 'eligible'); assert.deepEqual(r.cases[0].base, r.cases[0].candidate); assert.equal(r.metrics.tokens.delta, -160);
});

evidenceTest('efficiency loss alone does not veto complete correctness claims', t => {
  const f = fixture(t), planned = retainPlan(f), results = outcomes(f, planned);
  for (const row of results.outcomes) if (row.side === 'candidate') { row.metrics.latencyMs = 12; if (row.caseId === 'fix') row.correct = false; }
  put(f.resultFile, JSON.stringify(results)); ingest(f); const r = report(f);
  assert.equal(r.eligibility.status, 'eligible'); assert.equal(r.metrics.latencyMs.delta, 16); assert.equal(r.evidence.runtime, 'unverified');
});

evidenceTest('unavailable metrics retain explicit partial comparable coverage rather than fabricated totals', t => {
  const f = fixture(t), planned = retainPlan(f), results = outcomes(f, planned);
  for (const row of results.outcomes) row.metrics.costUsd = null;
  results.outcomes.find(row => row.side === 'candidate').metrics.tokens = null;
  put(f.resultFile, JSON.stringify(results)); ingest(f); const r = report(f);
  assert.deepEqual(r.metrics.tokens, { expectedPairs: 8, availablePairs: 7, baseTotal: 800, candidateTotal: null, delta: null, paired: { base: 700, candidate: 560, delta: -140 } });
  assert.deepEqual(r.metrics.costUsd, { expectedPairs: 8, availablePairs: 0, baseTotal: null, candidateTotal: null, delta: null, paired: { base: null, candidate: null, delta: null } });
  assert.equal(r.eligibility.status, 'eligible');
});

const planFaults = [
  ['missing motivating coverage', p => { p.cases = p.cases.filter(c => c.kind !== 'motivating'); }, /motivating|coverage/i],
  ['missing regression coverage', p => { p.cases = p.cases.filter(c => c.kind !== 'regression'); }, /regression|coverage/i],
  ['missing required workflow coverage', p => { p.cases = p.cases.filter(c => c.kind !== 'workflow'); }, /workflow.*(?:case|coverage|required)|coverage.*workflow/i],
  ['duplicate case id', p => { p.cases[1].id = p.cases[0].id; }, /duplicate.*case|case.*duplicate/i],
  ['foreign case target scope', p => { p.cases[0].target.assignment.model = 'foreign-model'; }, /scope|target|actor|assignment/i],
  ['mismatched captured peer', (p, f) => { p.context.workflowPeers.candidate[0].provider.revisionDigest = f.records.get('reviewer').recordDigest; }, /peer|workflow.*(?:binding|mismatch)|context/i],
  ['foreign active evaluation base', (p, f) => { p.baseStamp = f.migration.bases[0].stamp; }, /base|evaluation.*stamp|binding/i],
  ['foreign candidate revision', (p, f) => { p.candidateRevisionDigest = f.records.get('helper').recordDigest; }, /candidate|revision.*mismatch|binding/i],
];
for (const [name, mutate, diagnostic] of planFaults) evidenceTest(`evaluation plan refuses ${name} without writes`, t => {
  const f = fixture(t), invalid = structuredClone(f.plan); mutate(invalid, f); put(f.planFile, JSON.stringify(invalid));
  refuses(f, () => retainPlan(f), diagnostic);
});

const resultFaults = [
  ['missing outcome', r => { r.outcomes.pop(); }, /missing|incomplete|coverage/i],
  ['duplicate outcome with unchanged count', r => { r.outcomes[1] = structuredClone(r.outcomes[0]); }, /duplicate|coverage/i],
  ['foreign case', r => { r.outcomes[0].caseId = 'foreign-case'; }, /case|foreign/i],
  ['out of range trial', r => { r.outcomes[0].trial = 3; }, /trial/i],
  ['unsupported side', r => { r.outcomes[0].side = 'other'; }, /side/i],
  ['wrong side stamp', (r, f) => { r.outcomes.find(row => row.side === 'candidate').stampDigest = f.base.digest; }, /stamp|binding|side/i],
  ['wrong primary assignment', r => { r.outcomes[0].assignment.model = 'foreign-model'; }, /assignment|context|binding/i],
  ['wrong candidate revision', (r, f) => { r.candidateRevisionDigest = f.records.get('helper').recordDigest; }, /candidate|revision|binding/i],
  ['changed candidate judge settings', r => { r.conditions.candidate.judge.settings.temperature = 1; }, /conditions|judge|settings/i],
  ['foreign plan digest', (r, f) => { r.planDigest = f.candidate.revisionDigest; }, /plan|binding/i],
];
for (const [name, mutate, diagnostic] of resultFaults) evidenceTest(`paired results refuse ${name} without writes`, t => {
  const f = fixture(t), planned = retainPlan(f), invalid = outcomes(f, planned); mutate(invalid, f); put(f.resultFile, JSON.stringify(invalid));
  refuses(f, () => ingest(f), diagnostic);
});

const scalarFaults = [
  ['negative measured cost', r => { r.outcomes[0].metrics.costUsd = -1; }, /cost|metric|nonnegative/i],
  ['fractional token count', r => { r.outcomes[0].metrics.tokens = 1.5; }, /tokens|integer|metric/i],
  ['unsafe tool count', r => { r.outcomes[0].metrics.toolCalls = Number.MAX_SAFE_INTEGER + 1; }, /toolCalls|safe|metric/i],
  ['unsafe aggregate token total', r => { r.outcomes[0].metrics.tokens = Number.MAX_SAFE_INTEGER; }, /tokens|safe|overflow|metric/i],
  ['string turn count', r => { r.outcomes[0].metrics.turns = '4'; }, /turns|number|metric/i],
  ['missing unavailable marker', r => { delete r.outcomes[0].metrics.latencyMs; }, /latency|metric|missing|required|fields/i],
  ['empty evidence reference', r => { r.outcomes[0].evidenceRef = ''; }, /evidenceRef|evidence.*(?:nonempty|required)|nonempty/i],
  ['nonboolean correctness', r => { r.outcomes[0].correct = 1; }, /correct|boolean/i],
];
for (const [name, mutate, diagnostic] of scalarFaults) evidenceTest(`paired result schema refuses ${name}`, t => {
  const f = fixture(t), planned = retainPlan(f), invalid = outcomes(f, planned); mutate(invalid); put(f.resultFile, JSON.stringify(invalid));
  refuses(f, () => ingest(f), diagnostic);
});
evidenceTest('paired result schema refuses JSON numeric overflow rather than converting it to unavailable', t => {
  const f = fixture(t), planned = retainPlan(f), invalid = outcomes(f, planned); invalid.outcomes[0].metrics.latencyMs = 123456789;
  put(f.resultFile, JSON.stringify(invalid).replace('"latencyMs":123456789', '"latencyMs":1e999'));
  refuses(f, () => ingest(f), /finite|number|latency|metric|JSON/i);
});

for (const backing of ['candidate metadata', 'active base snapshot', 'peer companion', 'retained plan', 'missing base']) evidenceTest(`evaluation read report and equal-id reuse refuse ${backing} corruption without repair`, t => {
  const f = fixture(t), pair = retainedPair(f), originalReport = report(f);
  const target = backing === 'candidate metadata' ? path.join(f.storeRoot, 'revisions/sha256', `${f.candidate.revisionDigest}.json`) :
    backing === 'peer companion' ? path.join(f.storeRoot, 'objects/sha256', f.packages.get('helper').sha256, 'tree/WORKFLOW.md') :
      backing === 'retained plan' ? path.join(f.storeRoot, 'evaluations/plans/sha256', `${pair.planned.planDigest}.json`) :
        path.join(f.storeRoot, 'stamps/sha256', f.base.digest, 'snapshot.json');
  const original = fs.readFileSync(target);
  if (backing === 'missing base') fs.unlinkSync(target); else put(target, Buffer.concat([original, Buffer.from(' ')]));
  const broken = roots(f), diagnostic = /record|revision|digest|integrity|canonical|stamp|backing|missing|ENOENT|reconstruct|object/i;
  assert.throws(() => readPlan(f), diagnostic); assert.throws(() => report(f), diagnostic);
  assert.throws(() => retainPlan(f), diagnostic); assert.throws(() => ingest(f), diagnostic);
  assert.deepEqual(roots(f), broken); put(target, original); assert.deepEqual(report(f), originalReport);
});

evidenceTest('a rehashed retained result with a valid but wrong side stamp still refuses semantic report validation', t => {
  const f = fixture(t), pair = retainedPair(f); assert.equal(report(f).eligibility.status, 'eligible');
  const forged = structuredClone(pair.results); forged.outcomes.find(row => row.side === 'candidate').stampDigest = f.base.digest;
  const resultDigest = hashRecord('agent-profiles/evaluation-result/v1', forged);
  assert.notEqual(resultDigest, pair.imported.resultDigest);
  put(path.join(f.storeRoot, 'evaluations/results/sha256', `${resultDigest}.json`), canonicalJSON(forged));
  const indexFile = path.join(f.storeRoot, 'evaluations/results/ids', `${pair.results.id}.json`), originalIndex = fs.readFileSync(indexFile);
  const index = JSON.parse(originalIndex.toString('utf8')); index.resultDigest = resultDigest; put(indexFile, canonicalJSON(index));
  const before = roots(f); assert.throws(() => report(f), /stamp|side|binding|mismatch/i); assert.deepEqual(roots(f), before);
  put(indexFile, originalIndex); assert.equal(report(f).resultDigest, pair.imported.resultDigest);
});

evidenceTest('historical paired evidence survives later distinct plans and mutable project source removal', t => {
  const f = fixture(t), first = retainedPair(f), originalReport = report(f), originalPlan = readPlan(f);
  const laterPlan = structuredClone(f.plan); laterPlan.id = 'later-plan'; laterPlan.cases[0].input = 'Later fictional stale-evidence case';
  const laterPlanFile = path.join(f.dir, 'later-plan.json'); put(laterPlanFile, JSON.stringify(laterPlan));
  const later = migrations.planMigrationEvaluation({ root: f.root, storeRoot: f.storeRoot, candidateId: f.candidate.id, planFile: laterPlanFile });
  const laterResults = outcomes(f, later, 'later-results'); laterResults.outcomes[0].metrics.costUsd = 3;
  const laterResultFile = path.join(f.dir, 'later-results.json'); put(laterResultFile, JSON.stringify(laterResults));
  migrations.importMigrationEvaluationResults({ root: f.root, storeRoot: f.storeRoot, planId: laterPlan.id, resultFile: laterResultFile });
  assert.notEqual(report(f, 'later-results').resultDigest, first.imported.resultDigest); assert.deepEqual(report(f), originalReport);
  fs.rmSync(f.root, { recursive: true }); fs.rmSync(f.sources, { recursive: true });
  fs.unlinkSync(f.planFile); fs.unlinkSync(f.resultFile); fs.unlinkSync(laterPlanFile); fs.unlinkSync(laterResultFile);
  assert.deepEqual(readPlan(f), originalPlan); assert.deepEqual(report(f), originalReport);
  assert.equal(report(f, 'later-results').planDigest, later.planDigest);
  assert.equal(migrations.migrationCandidate({ storeRoot: f.storeRoot, id: f.candidate.id }).stampDigest, f.candidate.stampDigest);
});

for (const obstacle of ['protected namespace', 'busy store']) evidenceTest(`evaluation plan publication refuses ${obstacle} without modifying protected state`, t => {
  const f = fixture(t);
  if (obstacle === 'protected namespace') {
    const nested = path.join(f.root, '.agent-profiles/migrations/store'); fs.cpSync(f.storeRoot, nested, { recursive: true });
    assert.equal(verifyStamp({ storeRoot: nested, digest: f.candidate.stampDigest }).managedReproducible, true);
    const before = roots(f);
    assert.throws(() => migrations.planMigrationEvaluation({ root: f.root, storeRoot: nested, candidateId: f.candidate.id, planFile: f.planFile }), /overlap|namespace|migration.*store/i);
    assert.deepEqual(roots(f), before);
  } else {
    put(path.join(f.storeRoot, '.writer-lock/owner.json'), canonicalJSON({ pid: 12345, operation: 'fictional-other-writer' }));
    refuses(f, () => retainPlan(f), /store.busy|writer.*(?:busy|exists)|lock.*exists/i);
  }
});

function observeEvidenceFs(t, method, observe, operation) {
  const real = fs[method], mock = t.mock.method(fs, method, (...args) => observe(real, ...args)); syncBuiltinESMExports();
  try { return operation(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
}
function evidenceFailureState(f, before) {
  assert.deepEqual(files(f.root), before[0]); assert.deepEqual(files(f.ambient), before[2]);
  const after = files(f.storeRoot), retained = new Map(after.map(row => [row[0], row]));
  for (const row of before[1]) assert.deepEqual(retained.get(row[0]), row, `prior evidence ${row[0]} is unchanged`);
  assert.equal(fs.existsSync(path.join(f.storeRoot, '.writer-lock')), false);
  const stages = rows => rows.filter(row => row[0] === '.staging' || row[0].startsWith('.staging/'));
  assert.deepEqual(stages(after), stages(before[1]));
}

evidenceTest('results input edit after validated read stays a stale-input refusal before any final index', t => {
  const f = fixture(t), planned = retainPlan(f), results = outcomes(f, planned); put(f.resultFile, JSON.stringify(results));
  const edited = structuredClone(results); edited.outcomes[0].metrics.costUsd = 3; const editedBytes = Buffer.from(JSON.stringify(edited));
  const indexPath = path.join(f.storeRoot, 'evaluations/results/ids', `${results.id}.json`), before = roots(f);
  let inputFd = null, mutations = 0, editing = false, indexAttempts = 0, error;
  observeEvidenceFs(t, 'openSync', (real, target, ...args) => {
    const fd = real(target, ...args);
    if (!editing && mutations === 0 && path.resolve(target) === f.resultFile) inputFd = fd;
    return fd;
  }, () => observeEvidenceFs(t, 'closeSync', (real, fd, ...args) => {
    const selected = !editing && mutations === 0 && fd === inputFd, closed = real(fd, ...args);
    if (selected) {
      inputFd = null; editing = true;
      try { fs.writeFileSync(f.resultFile, editedBytes); mutations++; } finally { editing = false; }
    }
    return closed;
  }, () => observeEvidenceFs(t, 'renameSync', (real, from, to, ...args) => {
    if (path.resolve(to) === indexPath) indexAttempts++;
    return real(from, to, ...args);
  }, () => { try { ingest(f); } catch (caught) { error = caught; } })));
  assert.equal(mutations, 1, 'mutation follows the original safe-reader close'); assert.ok(error, 'changed input must refuse');
  assert.match(error.message, /stale|input.*changed/i); assert.equal(indexAttempts, 0); assert.equal(fs.existsSync(indexPath), false);
  assert.deepEqual(fs.readFileSync(f.resultFile), editedBytes); evidenceFailureState(f, before);
  assert.equal(readPlan(f).planDigest, planned.planDigest);
});

evidenceTest('caught final result-index EIO leaves no success and preserves prior evidence with valid staged backing', t => {
  const f = fixture(t), planned = retainPlan(f), results = outcomes(f, planned); put(f.resultFile, JSON.stringify(results));
  const resultDigest = hashRecord('agent-profiles/evaluation-result/v1', results), indexPath = path.join(f.storeRoot, 'evaluations/results/ids', `${results.id}.json`);
  const objectPath = path.join(f.storeRoot, 'evaluations/results/sha256', `${resultDigest}.json`), before = roots(f);
  const sourceBytes = fs.readFileSync(f.resultFile);
  const sentinel = Object.assign(new Error('paired result final-index EIO sentinel'), { code: 'EIO' });
  let observations = 0, error;
  observeEvidenceFs(t, 'renameSync', (real, from, to, ...args) => {
    if (path.resolve(to) !== indexPath) return real(from, to, ...args);
    observations++; assert.equal(fs.existsSync(indexPath), false);
    const bytes = fs.readFileSync(from), index = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(index, { evaluationIndexVersion: 1, id: results.id, resultDigest }); assert.deepEqual(bytes, canonicalJSON(index));
    assert.deepEqual(fs.readFileSync(objectPath), canonicalJSON(results));
    assert.equal(readPlan(f).planDigest, planned.planDigest); assert.equal(verifyStamp({ storeRoot: f.storeRoot, digest: f.candidate.stampDigest }).managedReproducible, true);
    throw sentinel;
  }, () => { try { ingest(f); } catch (caught) { error = caught; } });
  assert.equal(observations, 1); assert.ok(error); assert.match(error.message, /paired result final-index EIO sentinel/);
  assert.equal(fs.existsSync(indexPath), false); evidenceFailureState(f, before);
  assert.deepEqual(fs.readFileSync(f.resultFile), sourceBytes);
  if (fs.existsSync(objectPath)) assert.deepEqual(fs.readFileSync(objectPath), canonicalJSON(results));
  assert.equal(readPlan(f).planDigest, planned.planDigest);
});

evidenceTest('public paired plan results and report CLI honors explicit store without activation or runtime claims', t => {
  const f = fixture(t), project = files(f.root), ambient = files(f.ambient);
  const planned = child(f, ['migrate', 'plan', f.candidate.id, f.planFile, '--json']);
  assert.equal(planned.error, undefined, 'spawn/setup denial is not business RED'); assert.equal(planned.status, 0, planned.stderr); assert.equal(planned.stderr, '');
  const plan = JSON.parse(planned.stdout); assert.equal(plan.planDigest, hashRecord('agent-profiles/evaluation-plan/v1', f.plan));
  const results = outcomes(f, plan); put(f.resultFile, JSON.stringify(results));
  const imported = child(f, ['migrate', 'results', f.plan.id, f.resultFile, '--json']);
  assert.equal(imported.error, undefined); assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stderr, '');
  assert.equal(JSON.parse(imported.stdout).planDigest, plan.planDigest);
  const json = child(f, ['migrate', 'report', results.id, '--json']); assert.equal(json.error, undefined); assert.equal(json.status, 0, json.stderr);
  const r = JSON.parse(json.stdout); assert.equal(r.evidence.correctness, 'external-claim'); assert.equal(r.evidence.runtime, 'unverified'); assert.equal(r.evidence.promotion, 'not-authorized');
  const text = child(f, ['migrate', 'report', results.id]); assert.equal(text.error, undefined); assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(results.id)); assert.match(text.stdout, /external|claim|unverified/i);
  const invalid = structuredClone(results); invalid.id = 'invalid-cli-results'; invalid.outcomes[0].evidenceRef = ''; put(f.resultFile, JSON.stringify(invalid));
  const before = roots(f), rejected = child(f, ['migrate', 'results', f.plan.id, f.resultFile, '--json']);
  assert.equal(rejected.error, undefined); assert.notEqual(rejected.status, 0); assert.equal(rejected.stdout.trim(), '');
  assert.match(rejected.stderr, /evidenceRef|evidence.*(?:nonempty|required)|nonempty/i); assert.deepEqual(roots(f), before);
  assert.deepEqual(files(f.root), project); assert.deepEqual(files(f.ambient), ambient);
  fs.rmSync(f.root, { recursive: true });
  const historical = child(f, ['migrate', 'report', results.id, '--json'], false);
  assert.equal(historical.error, undefined); assert.equal(historical.status, 0, historical.stderr); assert.deepEqual(JSON.parse(historical.stdout), r);
});

import { readStoreFile } from '../src/package-store.js';
import * as observerFs from 'node:fs';

test('observer control: safe-reader post-close edit returns original bytes and restores synchronized methods', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-evidence-close-control-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input.json');
  const originalBytes = Buffer.from('{"fixture":"original","complete":true}\n');
  const editedBytes = Buffer.from('{"fixture":"edited","complete":true}\n');
  fs.writeFileSync(input, originalBytes);
  const originalOpen = fs.openSync, originalClose = fs.closeSync, originalWrite = fs.writeFileSync;
  let inputFd = null, interventions = 0, editing = false;
  const returned = observeEvidenceFs(t, 'openSync', (real, target, ...args) => {
    const fd = real(target, ...args);
    if (!editing && interventions === 0 && path.resolve(target) === input) inputFd = fd;
    return fd;
  }, () => observeEvidenceFs(t, 'closeSync', (real, fd, ...args) => {
    const selected = !editing && interventions === 0 && fd === inputFd;
    const closed = real(fd, ...args);
    if (selected) {
      inputFd = null; editing = true;
      try { originalWrite(input, editedBytes); interventions++; } finally { editing = false; }
    }
    return closed;
  }, () => readStoreFile(dir, 'input.json')));
  assert.equal(interventions, 1, 'the owned input changes once after its real close');
  assert.deepEqual(returned, originalBytes, 'safe-reader identity checks precede the post-close edit');
  assert.deepEqual(fs.readFileSync(input), editedBytes);
  assert.equal(fs.openSync, originalOpen); assert.equal(observerFs.openSync, originalOpen);
  assert.equal(fs.closeSync, originalClose); assert.equal(observerFs.closeSync, originalClose);
  assert.deepEqual(readStoreFile(dir, 'input.json'), editedBytes);
});

test('observer control: complete staged-index EIO preserves absent target and restores real rename retry', t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-evidence-rename-control-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, 'harness-stage.json'), target = path.join(dir, 'harness-final.json');
  const inertIndex = { fixtureVersion: 1, kind: 'inert-observer-control', id: 'harness-only', references: { content: 'fixture-content', record: 'fixture-record' } };
  const expected = canonicalJSON(inertIndex); fs.writeFileSync(staged, expected);
  const originalRename = fs.renameSync;
  const sentinel = Object.assign(new Error('standalone staged-index EIO sentinel'), { code: 'EIO' });
  let interventions = 0;
  observeEvidenceFs(t, 'renameSync', (real, from, to, ...args) => {
    if (path.resolve(to) !== target) return real(from, to, ...args);
    interventions++; assert.equal(fs.existsSync(target), false);
    const bytes = fs.readFileSync(from);
    assert.deepEqual(bytes, expected); assert.deepEqual(JSON.parse(bytes.toString('utf8')), inertIndex);
    assert.deepEqual(canonicalJSON(JSON.parse(bytes.toString('utf8'))), bytes);
    throw sentinel;
  }, () => assert.throws(() => observerFs.renameSync(staged, target), error => error === sentinel));
  assert.equal(sentinel.code, 'EIO'); assert.equal(sentinel.message, 'standalone staged-index EIO sentinel');
  assert.equal(interventions, 1); assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readFileSync(staged), expected);
  assert.equal(fs.renameSync, originalRename); assert.equal(observerFs.renameSync, originalRename);
  observerFs.renameSync(staged, target);
  assert.deepEqual(fs.readFileSync(target), expected); assert.equal(fs.existsSync(staged), false);
});
