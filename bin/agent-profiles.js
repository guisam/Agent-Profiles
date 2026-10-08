#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { realpathSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { detectAgents, doctor, findRoot, install, installPackage, uninstall } from '../src/install.js';
import { configureRoles, display } from '../src/wizard.js';
import { readConfiguration } from '../src/configure.js';
import { discoverSkills } from '../src/skills.js';
import { integrations } from '../src/integrations.js';
import { runPreset } from '../src/preset-wizard.js';
import { resolveInstructions } from '../src/resolve.js';
import { formatContext, formatProof, resolutionOutput } from '../src/diagnostics.js';
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
      'identity-source': { type: 'string' },
      host: { type: 'string' },
      package: { type: 'string' },
      skill: { type: 'string', multiple: true },
      json: { type: 'boolean', default: false },
      port: { type: 'string' },
      external: { type: 'boolean', default: false },
      sources: { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(`Usage: agent-profiles <command> [--root <directory>]

Commands:
  init        Install bootstrap integrations and example configuration
  resolve     Print the resolved instructions for an agent to follow (read-only)
  configure   Create, edit, or delete roles and select skills (interactive)
  skills      Inspect bounded skill metadata and source availability (read-only)
  doctor      Validate configuration and report integration status (read-only)
  uninstall   Remove managed bootstrap blocks; retain configuration
  preset      Inspect, import, or export a local preset directory
  proof       Measure resolved instruction bytes and characters (read-only)
  visualize   Serve a local context explorer (read-only; Ctrl+C to stop)

Agent context:
  resolve [--host <id>] [--model <id>] [--family <id>] [--identity-source host|host-stated|user]
          [--role <id>] [--skill <id> ...] [--json [--contents]]

Context proof:
  proof [--host <id>] [--model <id>] [--family <id>] [--role <id>] [--skill <id> ...]
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
  --package <spec>    For init: install this agent-profiles package or tarball as a
                      dev dependency so the bootstrap command can run
  --external          Include external native skill inventory in skills/configure/doctor
  --sources <file>    Machine-local skill roots JSON; implies --external
  --delete-config     Also delete .agent-profiles during uninstall; asks to confirm
  -h, --help          Show this help

Examples:
  agent-profiles init --agent claude --agent codex
  agent-profiles configure
  agent-profiles doctor`);
  } else {
    if (command === 'preset') {
      if (positionals.length !== 3 || !['inspect', 'import', 'export'].includes(positionals[1])) throw new Error('Usage: agent-profiles preset <inspect|import|export> <directory>');
    } else if (positionals.length !== 1 || !['init', 'configure', 'skills', 'doctor', 'uninstall', 'resolve', 'proof', 'visualize'].includes(command)) throw new Error('Choose one command: init, configure, skills, doctor, uninstall, resolve, preset, proof, visualize');
    if (values.package !== undefined && command !== 'init') throw new Error('--package is only supported by init');
    if (values.agent && command !== 'init') throw new Error('--agent is only supported by init');
    if (values['delete-config'] && command !== 'uninstall') throw new Error('--delete-config is only supported by uninstall');
    const resolving = ['resolve', 'proof', 'visualize'].includes(command);
    if (values.role && !resolving && command !== 'preset') throw new Error('--role is only supported by preset, resolve, proof, or visualize');
    if (resolving && values.role?.length > 1) throw new Error(`${command} accepts one --role`);
    if ((values.model !== undefined || values.family !== undefined || values.skill) && !resolving) throw new Error('--model, --family, and --skill are only supported by resolve, proof, or visualize');
    if (values.host !== undefined && !['resolve', 'proof'].includes(command)) throw new Error('--host is only supported by resolve or proof');
    if (values['identity-source'] !== undefined && command !== 'resolve') throw new Error('--identity-source is only supported by resolve');
    if (values.json && !['resolve', 'proof', 'skills'].includes(command)) throw new Error('--json is only supported by resolve, proof, or skills');
    if ((values.external || values.sources !== undefined) && !['skills', 'configure', 'doctor'].includes(command)) throw new Error('--external and --sources are only supported by skills, configure, or doctor');
    if (values.sources !== undefined && !values.sources.trim()) throw new Error('--sources requires a file');
    const discoveryOptions = { external: values.external || values.sources !== undefined, sourceOptions: values.sources === undefined ? undefined : { sourcesFile: values.sources } };
    if (values.port !== undefined && (command !== 'visualize' || !/^\d+$/.test(values.port))) throw new Error('--port requires an integer from 0 to 65535 and is only supported by visualize');
    if (values.contents && !(command === 'preset' && positionals[1] === 'inspect') && !(['resolve', 'proof'].includes(command) && values.json)) throw new Error('--contents requires preset inspect, or resolve or proof with --json');
    if (values.root !== undefined && !values.root.trim()) throw new Error('--root requires a directory');
    let target = values.root;
    if (target === undefined) {
      try { target = findRoot(); } catch (error) {
        if (command !== 'preset' || positionals[1] !== 'inspect') throw error;
        target = process.cwd();
      }
    }
    const root = realpathSync(target);
    if (!(command === 'proof' && values.json) && command !== 'resolve' && !(command === 'skills' && values.json)) console.log(`Agent Profiles\nRepository: ${root}`);
    if (command === 'visualize') {
      const { server, url } = await startVisualizer({ root, port: values.port === undefined ? 0 : Number(values.port), model: values.model, family: values.family, role: values.role?.[0], skills: values.skill });
      console.log(`Context explorer: ${url}\nOpen this local URL in your browser. Read-only; press Ctrl+C to stop.`);
      const stop = () => { server.close(); server.closeAllConnections(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    } else if (command === 'resolve') {
      const result = resolveInstructions({ root, host: values.host, model: values.model, family: values.family, identitySource: /** @type {any} */ (values['identity-source']), role: values.role?.[0], skills: values.skill });
      console.log(values.json ? JSON.stringify(resolutionOutput(result, values.contents), null, 2) : formatContext(result));
    } else if (command === 'proof') {
      const result = resolveInstructions({ root, host: values.host, model: values.model, family: values.family, role: values.role?.[0], skills: values.skill });
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
      console.log(`Configuration validated. Default profile: ${result.profile}; default role: ${result.role}.`);
      // The block is only useful once its command runs; install the package when asked to.
      // An explicit --package always installs: a matching version string does not prove matching code.
      let { availability } = result;
      let spec = values.package;
      if (spec === undefined && !availability.runnable && stdin.isTTY && stdout.isTTY) {
        console.log(`The bootstrap cannot run yet: ${availability.reason}.`);
        spec = (await question(`Install agent-profiles as a dev dependency now? Package spec or tarball [agent-profiles@${result.ownVersion}], or "skip": `)).trim() || `agent-profiles@${result.ownVersion}`;
        if (spec === 'skip') spec = undefined;
      }
      if (spec !== undefined) availability = installPackage(root, spec);
      const report = doctor(root);
      for (const problem of report.bootstrap) console.error(`Bootstrap: ${problem}`);
      if (report.bootstrap.length) {
        console.error('The bootstrap is not runnable yet. Fix the items above, then run agent-profiles doctor.');
        process.exitCode = 1;
      } else console.log(`Bootstrap runnable with agent-profiles ${availability.version}. Run agent-profiles doctor to inspect the installation.`);
    } else if (command === 'configure') {
      await configureRoles({ root, ask: question, ...discoveryOptions });
    } else if (command === 'skills') {
      const found = discoverSkills(root, readConfiguration(root).configuration, discoveryOptions);
      if (values.json) console.log(JSON.stringify(found, null, 2));
      else {
        for (const skill of found.skills) console.log(`${display(skill.id)} — ${display(skill.name)}\n  ${display(skill.description ?? '(no description)')}\n  ${display(skill.source)}; ${display(skill.host ?? 'instruction')}/${display(skill.scope ?? 'repository')}; ${display(skill.availability ?? 'local metadata')}; ${display(skill.path ?? '(host-provided)')}`);
        for (const warning of found.warnings) console.log(`Inventory: ${display(warning)}`);
        console.log('Metadata is not proof of host enablement or native invocation.');
      }
    } else if (command === 'doctor') {
      const result = doctor(root);
      if (result.profile) console.log(`Default profile: ${result.profile}; default role: ${result.role}`);
      for (const agent of result.agents) console.log(`${agent.name}: ${agent.installed ? 'bootstrap installed' : 'not installed'} (${agent.file})`);
      for (const note of result.notes) console.log(note);
      // Three independent questions: is the configuration valid, can the bootstrap run, can each host satisfy each role?
      const section = (title, problems, ok) => {
        console.log(`\n${title}: ${problems.length ? `${problems.length} problem${problems.length === 1 ? '' : 's'}` : ok}`);
        for (const problem of problems) console.error(`  ${problem}`);
      };
      section('Configuration', result.errors, 'valid');
      section('Bootstrap availability', result.bootstrap, `runnable (agent-profiles ${result.availability.version})`);
      section('Host compatibility', result.capabilities, 'no cross-host required-skill conflicts; native invocation not verified');
      console.log(result.valid ? '\nInstallation is ready.' : '\nInstallation needs attention.');
      if (discoveryOptions.external) {
        const found = discoverSkills(root, readConfiguration(root).configuration, discoveryOptions);
        console.log('\nExternal inventory (metadata only; native invocation unverified)');
        for (const skill of found.skills.filter(skill => skill.host && skill.scope !== 'project')) console.log(`  ${display(skill.id)}: ${display(skill.availability)} (${display(skill.host)}/${display(skill.scope)}; ${display(skill.path ?? 'host-provided')})`);
        for (const warning of found.warnings) console.log(`Inventory: ${display(warning)}`);
      }
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
