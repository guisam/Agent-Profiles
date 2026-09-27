#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { detectAgents, doctor, findRoot, install, uninstall } from '../src/install.js';
import { configureRoles } from '../src/wizard.js';
import { integrations } from '../src/integrations.js';
import { runPreset } from '../src/preset-wizard.js';
import { resolveInstructions } from '../src/resolve.js';
import { formatProof, resolutionOutput } from '../src/diagnostics.js';
import { startVisualizer } from '../src/visualize.js';

const agentChoices = integrations.map(adapter => adapter.id).join(', ');

async function question(prompt) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Interactive input is unavailable; configure requires a terminal, as do preset import/export. For init use --agent; for uninstall omit --delete-config.');
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
      role: { type: 'string', multiple: true },
      contents: { type: 'boolean', default: false },
      model: { type: 'string' },
      family: { type: 'string' },
      skill: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      port: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(`Usage: agent-profiles <command> [--root <directory>]

Commands:
  init        Install bootstrap integrations and example configuration
  configure   Create, edit, or delete roles and select local skills (interactive)
  doctor      Validate configuration and report integration status (read-only)
  uninstall   Remove managed bootstrap blocks; retain configuration
  preset      Inspect, import, or export a local preset directory
  proof       Measure resolved instruction bytes and characters (read-only)
  visualize   Serve a local context explorer (read-only; Ctrl+C to stop)

Context proof:
  proof [--model <id>] [--family <id>] [--role <id>] [--skill <id> ...]
        [--json [--contents]]

Visualizer:
  visualize [--model <id>] [--family <id>] [--role <id>] [--skill <id> ...]
            [--port <0-65535>]  (default: an available local port)

Presets:
  preset inspect <directory> [--contents] [--role <id> ...]
  preset import <directory> [--role <id> ...]  (interactive confirmation)
  preset export <new-directory> [--role <id> ...]  (interactive selection)

Options:
  --root <directory>  Target repository (default: nearest Git root)
  --agent <id>        Select ${agentChoices} for init; repeat for multiple agents
  --delete-config     Also delete .agent-profiles during uninstall; asks to confirm
  -h, --help          Show this help

Examples:
  agent-profiles init --agent claude --agent codex
  agent-profiles configure
  agent-profiles doctor`);
  } else {
    if (command === 'preset') {
      if (positionals.length !== 3 || !['inspect', 'import', 'export'].includes(positionals[1])) throw new Error('Usage: agent-profiles preset <inspect|import|export> <directory>');
    } else if (positionals.length !== 1 || !['init', 'configure', 'doctor', 'uninstall', 'proof', 'visualize'].includes(command)) throw new Error('Choose one command: init, configure, doctor, uninstall, preset, proof, visualize');
    if (values.agent && command !== 'init') throw new Error('--agent is only supported by init');
    if (values['delete-config'] && command !== 'uninstall') throw new Error('--delete-config is only supported by uninstall');
    if (values.role && !['preset', 'proof', 'visualize'].includes(command)) throw new Error('--role is only supported by preset, proof, or visualize');
    if (['proof', 'visualize'].includes(command) && values.role?.length > 1) throw new Error(`${command} accepts one --role`);
    if ((values.model !== undefined || values.family !== undefined || values.skill) && !['proof', 'visualize'].includes(command)) throw new Error('--model, --family, and --skill are only supported by proof or visualize');
    if (values.json && command !== 'proof') throw new Error('--json is only supported by proof');
    if (values.port !== undefined && (command !== 'visualize' || !/^\d+$/.test(values.port))) throw new Error('--port requires an integer from 0 to 65535 and is only supported by visualize');
    if (values.contents && !(command === 'preset' && positionals[1] === 'inspect') && !(command === 'proof' && values.json)) throw new Error('--contents requires preset inspect or proof --json');
    if (values.root !== undefined && !values.root.trim()) throw new Error('--root requires a directory');
    let target = values.root;
    if (target === undefined) {
      try { target = findRoot(); } catch (error) {
        if (command !== 'preset' || positionals[1] !== 'inspect') throw error;
        target = process.cwd();
      }
    }
    const root = realpathSync(target);
    if (!(command === 'proof' && values.json)) console.log(`Agent Profiles\nRepository: ${root}`);
    if (command === 'visualize') {
      const { server, url } = await startVisualizer({ root, port: values.port === undefined ? 0 : Number(values.port), model: values.model, family: values.family, role: values.role?.[0], skills: values.skill });
      console.log(`Context explorer: ${url}\nOpen this local URL in your browser. Read-only; press Ctrl+C to stop.`);
      const stop = () => { server.close(); server.closeAllConnections(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } else if (command === 'proof') {
      const result = resolveInstructions({ root, model: values.model, family: values.family, role: values.role?.[0], skills: values.skill });
      console.log(values.json ? JSON.stringify(resolutionOutput(result, values.contents), null, 2) : formatProof(result));
    } else if (command === 'preset') {
      await runPreset({ command: positionals[1], location: positionals[2], root, roles: values.role, contents: values.contents, ask: question });
    } else if (command === 'init') {
      let agents = values.agent;
      if (!agents) {
        const detected = detectAgents(root);
        if (detected.some(agent => agent.installed)) {
          console.log('Existing integrations: ' + detected.filter(agent => agent.installed).map(agent => agent.id).join(', '));
        }
        const defaults = detected.filter(agent => agent.detected).map(agent => agent.id);
        const answer = await question(`Which coding agents? ${agentChoices}${defaults.length ? ` [${defaults.join(', ')}]` : ''}: `);
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
