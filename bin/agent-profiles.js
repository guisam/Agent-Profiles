#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { detectAgents, doctor, findRoot, install, uninstall } from '../src/install.js';
import { configureRoles } from '../src/wizard.js';

async function question(prompt) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive input is unavailable; configure requires a terminal. For init use --agent; for uninstall omit --delete-config.');
  const reader = createInterface({ input: stdin, output: stdout });
  try { return await reader.question(prompt); } finally { reader.close(); }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      agent: { type: 'string', multiple: true },
      'delete-config': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log('Usage: agent-profiles <init|configure|doctor|uninstall> [--root <directory>]\n  init [--agent claude] [--agent codex]\n  configure  (interactive roles and local skills)\n  uninstall [--delete-config]  (deletion requires interactive confirmation)');
  } else {
    if (positionals.length !== 1 || !['init', 'configure', 'doctor', 'uninstall'].includes(command)) throw new Error('Choose one command: init, configure, doctor, uninstall');
    if (values.agent && command !== 'init') throw new Error('--agent is only supported by init');
    if (values['delete-config'] && command !== 'uninstall') throw new Error('--delete-config is only supported by uninstall');
    if (values.root !== undefined && !values.root.trim()) throw new Error('--root requires a directory');
    const root = realpathSync(values.root ?? findRoot());
    console.log(`Agent Profiles\nRepository: ${root}`);
    if (command === 'init') {
      let agents = values.agent;
      if (!agents) {
        const detected = detectAgents(root);
        if (detected.some(agent => agent.installed)) {
          console.log('Existing integrations: ' + detected.filter(agent => agent.installed).map(agent => agent.id).join(', '));
        }
        const defaults = detected.filter(agent => agent.detected).map(agent => agent.id);
        const answer = await question(`Which coding agents? claude, codex${defaults.length ? ` [${defaults.join(', ')}]` : ''}: `);
        agents = answer.trim() ? answer.trim().split(/[\s,]+/) : defaults;
      }
      const result = install({ root, agents });
      for (const file of result.modified) console.log(`Updated ${file}`);
      if (!result.modified.length) console.log('Already installed. No changes required.');
      console.log(`Configuration validated. Default profile: ${result.profile}; default role: ${result.role}.\nRun agent-profiles doctor to inspect the installation.`);
    } else if (command === 'configure') {
      await configureRoles({ root, ask: question });
    } else if (command === 'doctor') {
      const result = doctor(root);
      if (result.profile) console.log(`Default profile: ${result.profile}; default role: ${result.role}`);
      for (const agent of result.agents) console.log(`${agent.name}: ${agent.installed ? 'bootstrap installed' : 'not installed'} (${agent.file})`);
      for (const error of result.errors) console.error(`Error: ${error}`);
      console.log(result.valid ? 'Configuration and all profile, role, and skill references are valid.' : 'Installation needs attention.');
      if (!result.valid) process.exitCode = 1;
    } else {
      let confirmed = false;
      if (values['delete-config']) {
        confirmed = await question('Delete all user-authored files in .agent-profiles? Type "delete .agent-profiles" to confirm: ') === 'delete .agent-profiles';
        if (!confirmed) throw new Error('Cancelled; no files changed');
      }
      const result = uninstall({ root, deleteConfig: values['delete-config'], confirmed });
      for (const file of result.modified) console.log(`Updated ${file}`);
      if (!result.modified.length) console.log('No managed integration blocks found.');
      console.log(result.configurationRetained ? 'Integration removed. Configuration retained in .agent-profiles/.' : 'Integration removed. No .agent-profiles/ directory remains.');
    }
  }
} catch (error) {
  console.error(`Agent Profiles: ${error.message}`);
  process.exitCode = 1;
}
