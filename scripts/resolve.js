import { parseArgs } from 'node:util';
import { resolveInstructions } from '../src/resolve.js';
import { resolutionOutput } from '../src/diagnostics.js';

try {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      model: { type: 'string' },
      family: { type: 'string' },
      role: { type: 'string' },
      skill: { type: 'string', multiple: true },
      contents: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: npm run resolve -- [--root <repo>] [--model <id>] [--family <id>] [--role <id>] [--skill <id> ...] [--contents]');
  } else {
    const result = resolveInstructions({ ...values, skills: values.skill });
    console.log(JSON.stringify(resolutionOutput(result, values.contents), null, 2));
  }
} catch (error) {
  console.error(`Agent Profiles: ${error.message}`);
  process.exitCode = 1;
}
