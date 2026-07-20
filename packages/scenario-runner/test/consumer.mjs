import { ScenarioRunner } from '../dist/index.js';
const driver = {
  reset: async () => {},
  capabilities: async () => ({}),
  configureFault: async () => {},
  send: async () => ({ value: {}, observations: [] }),
  restart: async () => {},
  clearFaults: async () => {},
};
const runner = new ScenarioRunner(driver);
const result = await runner.run(
  { name: 'smoke', commands: [{ type: 'assert_quiescent' }] },
  'smoke-seed',
);
if (result.status !== 'passed') process.exit(1);
console.log('scenario-runner consumer OK');
