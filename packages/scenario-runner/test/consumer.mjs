import { ScenarioRunner } from '../dist/index.js';
const driver = {
  reset: async () => {},
  capabilities: async () => ({
    componentVersions: { consumer: '1.0.0' },
    roles: {
      sender: { profiles: ['delivery-v1'] },
      receiver: { profiles: ['delivery-v1'] },
    },
  }),
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
