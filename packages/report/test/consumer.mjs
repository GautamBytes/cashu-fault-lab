import { renderJson, renderJunit } from '../dist/index.js';
import { INVARIANT_REGISTRY } from '@cashu-fault-lab/scenario-runner';
const result = {
  status: 'passed',
  artifact: {
    schemaVersion: 2,
    seed: 'test',
    scenario: 'x',
    commands: [],
    history: [],
    capabilities: {},
    invariants: INVARIANT_REGISTRY.map(({ id }) => ({
      id,
      status: 'not_applicable',
      confidence: 'derived',
      evidence: [],
      reason: 'Consumer fixture does not exercise this invariant.',
    })),
  },
};
const json = renderJson({ result });
if (typeof json !== 'string') process.exit(1);
const junit = renderJunit({ result });
if (typeof junit !== 'string') process.exit(1);
console.log('report consumer OK');
