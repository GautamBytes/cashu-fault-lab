import { renderJson, renderJunit } from '../dist/index.js';
const result = {
  status: 'passed',
  artifact: {
    schemaVersion: 1,
    seed: 'test',
    scenario: 'x',
    commands: [],
    history: [],
    capabilities: {},
  },
};
const json = renderJson({ result });
if (typeof json !== 'string') process.exit(1);
const junit = renderJunit({ result });
if (typeof junit !== 'string') process.exit(1);
console.log('report consumer OK');
