import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discoverExternalSkills, validateExternalSelection } from '../src/external-skills.js';
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-host-roots-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const make = (root, folder, frontmatter) => {
    const file = path.join(root, folder, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `---\n${frontmatter}\n---\nDO-NOT-INJECT\n`);
    return file;
  };
  return { home, make };
}
test('Claude configured home replaces the default personal skill root without granting arbitrary sibling reads', t => {
  const f = fixture(t);
  f.make(path.join(f.home, '.claude/skills'), 'old', 'name: old\ndescription: Old default.');
  const configured = path.join(f.home, 'custom Claude home');
  f.make(path.join(configured, 'skills'), 'custom', 'name: custom\ndescription: Configured home.');
  f.make(path.join(configured, 'sessions'), 'private', 'name: private\ndescription: Must not inspect.');
  const found = discoverExternalSkills({ home: f.home, env: { CLAUDE_CONFIG_DIR: configured } });
  assert.deepEqual(found.skills.map(s => s.hostId), ['custom']);
  assert.equal(found.roots[0].path, path.join(configured, 'skills'));
});

test('Claude plugin names use frontmatter override and do not double a valid namespace prefix', t => {
  const f = fixture(t); const root = path.join(f.home, 'plugin skills');
  f.make(root, 'directory-one', 'name: renamed\ndescription: Plugin override.');
  f.make(root, 'directory-two', 'name: team:qualified\ndescription: Qualified override.');
  f.make(root, 'directory-three', 'name: " padded "\ndescription: Invalid literal override.');
  const found = discoverExternalSkills({ home: f.home, env: {}, roots: [{ host: 'claude', scope: 'plugin', namespace: 'team', path: root }] });
  assert.deepEqual(found.skills.map(s => s.hostId).sort(), ['team:qualified', 'team:renamed']);
  assert.match(found.warnings.join('\n'), /identifier|native/i);
});

test('relative and empty Claude configured homes are rejected rather than reading the current directory', t => {
  const f = fixture(t);
  for (const value of ['', 'relative-home', `${f.home}/../outside`]) {
    assert.throws(() => discoverExternalSkills({ home: f.home, env: { CLAUDE_CONFIG_DIR: value } }), /CLAUDE_CONFIG_DIR|absolute/i);
  }
});

test('Claude frontmatter description is optional and a path selection with null description validates', t => {
  const f = fixture(t);
  f.make(path.join(f.home, '.claude/skills'), 'bare', 'allowed-tools: Read');
  const options = { home: f.home, env: {} };
  const found = discoverExternalSkills(options);
  assert.equal(found.skills.length, 1);
  assert.equal(found.skills[0].description, null);
  assert.equal(validateExternalSelection(found.skills[0], options).hostId, 'bare');
});
