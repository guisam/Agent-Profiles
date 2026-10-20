import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseYaml, resolveInstructions } from '../src/resolve.js';

const configuration = `version: 2
default_profile: constrained
default_role: reviewer
models: {}
families: {}
roles:
  reviewer:
    file: roles/reviewer.md
    skills: {required: [], available: []}
`;
const profile = '# Constrained\nTake small verified steps.\n';
const role = '# Reviewer\nReview changes for defects.\n';

function repository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'p4-null-maps-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('p4-null-maps-'));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, '.agent-profiles/profiles'), { recursive: true });
  mkdirSync(path.join(root, '.agent-profiles/roles'));
  writeFileSync(path.join(root, '.agent-profiles/profiles/constrained.md'), profile);
  writeFileSync(path.join(root, '.agent-profiles/roles/reviewer.md'), role);
  return root;
}

function assertLoaded(result) {
  assert.deepEqual(result.loaded.map(({ path, content }) => [path, content]), [
    ['.agent-profiles/profiles/constrained.md', profile],
    ['.agent-profiles/roles/reviewer.md', role],
  ]);
}

for (const field of ['profiles', 'assignments']) {
  for (const [name, suffix] of [['omitted', ''], ['empty mapping', `${field}: {}\n`]]) {
    test(`P4-F1 ${field} ${name} loads local instructions`, t => {
      const root = repository(t);
      assertLoaded(resolveInstructions({ root, configuration: parseYaml(configuration + suffix) }));
    });
  }
  for (const [name, value] of [['explicit null', ' null'], ['implicit null', ''], ['array', ' []'], ['scalar', ' false']]) {
    test(`P4-F1 ${field} ${name} rejects at the field mapping`, t => {
      const root = repository(t);
      assertLoaded(resolveInstructions({ root, configuration: parseYaml(configuration + `${field}: {}\n`) }));
      assert.throws(() => resolveInstructions({ root, configuration: parseYaml(configuration + `${field}:${value}\n`) }),
        { message: `${field}: expected a mapping` });
    });
  }
}
