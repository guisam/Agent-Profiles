import { existsSync } from 'node:fs';
import path from 'node:path';
import { configureRoles, display, selectSkills } from './wizard.js';
import { resolveInstructions } from './resolve.js';
import { applyPresetExport, applyPresetImport, exportChoices, planPresetExport, planPresetImport, readPreset } from './presets.js';

async function choose(ids, label, ask, write) {
  if (!ids.length) return [];
  const choices = ids.map(id => ({ id, name: id, description: label, path: id, source: 'configuration' }));
  return (await selectSkills({ choices, initial: choices, label, ask, write })).map(item => item.id);
}

function describe(preset, write, contents = false) {
  const meta = preset.metadata;
  write(`${display(meta.get('display_name'))} (${display(meta.get('name'))}@${display(meta.get('version'))})`);
  write(`By ${display(meta.get('author'))}; license: ${display(meta.get('license'))}`);
  write(display(meta.get('description')));
  for (const [id, value] of preset.roles) {
    write(`Role ${id} (${display(value.get('file'))}): required [${value.get('skills').get('required').join(', ')}]; available [${value.get('skills').get('available').join(', ')}]`);
  }
  write(`Profiles included: ${[...preset.profiles.keys()].join(', ') || '(none)'}`);
  write(`Skills included: ${[...preset.includes.keys()].join(', ') || '(none)'}`);
  write(`Skills required locally: ${preset.requires.join(', ') || '(none)'}`);
  for (const section of ['models', 'families', 'defaults']) {
    for (const [key, value] of preset.data.get(section) ?? []) write(`${section}.${display(key)}: ${display(value instanceof Map ? value.get('profile') : value)}`);
  }
  write(`Instruction files: ${[...preset.payload.keys()].map(display).join(', ')}`);
  if (contents) for (const [file, content] of preset.payload) {
    write(`--- ${display(file)} ---`);
    write(content.toString('utf8').split(/\r?\n/).map(display).join('\n'));
  }
}

function preview(plan, write) {
  for (const action of plan.actions) write(display(action));
  for (const conflict of plan.conflicts) write(`Conflict: ${display(conflict.key)} (${display(conflict.file)})`);
  for (const error of plan.errors) write(`Unresolved: ${display(error)}`);
  for (const change of plan.changes) write(`${change.before === null ? 'Create' : 'Update'} ${display(change.file)}`);
  write('Replacements affect every local role/model referring to that ID. Renaming changes only imported references.');
}

/** @param {{command: string, location: string, root?: string, roles?: string[], contents?: boolean, ask: (prompt: string) => Promise<string>, write?: typeof console.log}} options */
export async function runPreset({ command, location, root, roles, contents = false, ask, write = console.log }) {
  if (!['inspect', 'import', 'export'].includes(command) || !location?.trim()) throw new Error('Usage: agent-profiles preset <inspect|import|export> <directory> [--root <repository>]');
  if (command === 'export') {
    const state = exportChoices(root);
    const selectedRoles = roles ?? await choose([...state.configuration.get('roles').keys()], 'Roles to export', ask, write);
    const profiles = await choose(state.profiles, 'Profiles to export', ask, write);
    const skills = new Set();
    for (const role of selectedRoles) {
      const result = resolveInstructions({ root, role });
      [...result.required, ...result.available].forEach(skill => skills.add(skill.id));
    }
    write('Selected skills will be bundled as Markdown. Unselected skills become required local dependencies. Referenced supporting assets are not copied.');
    const includeSkills = await choose([...skills], 'Skills to include', ask, write);
    const metadata = {};
    for (const key of ['name', 'display_name', 'description', 'author', 'version', 'license']) metadata[key] = (await ask(`Preset ${key}: `)).trim();
    const plan = planPresetExport({ root, destination: location, metadata, roles: selectedRoles, profiles, includeSkills });
    describe(plan.preset, write);
    write(`Create ${display(plan.target)} with ${plan.changes.length} files. No existing files will be replaced.`);
    if ((await ask('Export this preset? [y/N]: ')).trim().toLowerCase() !== 'y') { write('Cancelled; no files changed.'); return; }
    applyPresetExport(plan, true);
    write(`Exported ${display(plan.target)}. Review instructions and licensing before sharing.`);
    return;
  }
  const preset = readPreset(location);
  describe(preset, write, contents);
  if (command === 'inspect') {
    if (root && existsSync(path.join(root, '.agent-profiles/agents.yaml'))) preview(planPresetImport({ root, source: location, roles }), write);
    else write('Local dependencies and conflicts not checked: use --root with an initialized repository.');
    write('No changes have been made. Use --contents to review instruction text.');
    return;
  }
  const selectedRoles = roles ?? await choose([...preset.roles.keys()], 'Roles to import', ask, write);
  const decisions = new Map();
  const useDefaults = preset.data.get('defaults')?.size ? (await ask('Apply the preset default profile/role? [y/N]: ')).trim().toLowerCase() === 'y' : false;
  let plan;
  for (;;) {
    plan = planPresetImport({ root, source: location, roles: selectedRoles, decisions, useDefaults });
    if (!preset.manifest.equals(plan.preset.manifest) || [...preset.payload].some(([file, content]) => !plan.preset.payload.get(file)?.equals(content))) {
      throw new Error('Preset changed while choosing import options; inspect it again before importing');
    }
    preview(plan, write);
    if (!plan.conflicts.length) break;
    // Re-plan after each decision: keeping a role can remove its dependencies.
    const conflict = plan.conflicts[0];
    const answer = (await ask(`${display(conflict.key)}: keep, replace${conflict.rename ? ', rename:<new-id>' : ''}, or cancel: `)).trim();
    if (!answer || answer === 'cancel' || answer === 'q') { write('Cancelled; no files changed.'); return; }
    decisions.set(conflict.key, answer);
  }
  if (!plan.ready) throw new Error('Preset cannot be imported until the reported dependencies/configuration errors are resolved');
  if ((await ask('Apply these preset changes? [y/N]: ')).trim().toLowerCase() !== 'y') { write('Cancelled; no files changed.'); return; }
  const modified = applyPresetImport(plan, true);
  write(`Imported preset; ${modified.length} files updated. Configuration validated.`);
  if ((await ask('Customize roles and skills with the existing wizard now? [y/N]: ')).trim().toLowerCase() === 'y') await configureRoles({ root, ask, write });
}
