import { parseArgs } from 'node:util';
import { resolveInstructions } from '../src/resolve.js';

try {
  const { values } = parseArgs({
    options: {
      root: { type: 'string' },
      model: { type: 'string' },
      family: { type: 'string' },
      role: { type: 'string' },
      contents: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: npm run resolve -- [--root <repo>] [--model <id>] [--family <id>] [--role <id>] [--contents]');
  } else {
    const result = resolveInstructions(values);
    if (!values.contents) result.loaded = result.loaded.map(({ path }) => ({ path }));
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(`Agent Profiles: ${error.message}`);
  process.exitCode = 1;
}
