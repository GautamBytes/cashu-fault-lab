import { describe, expect, it } from 'vitest';
import { getScenarioGroups, scenarioSourceLocation } from './scenarios';

describe('getScenarioGroups', () => {
  it('rejects a root-level JSON path without a family directory', () => {
    expect(() => scenarioSourceLocation('root-level.json')).toThrow(
      'must belong to a top-level family directory',
    );
  });

  it('discovers and groups every checked-in scenario', async () => {
    const groups = await getScenarioGroups();
    const all = groups.flatMap((group) => group.scenarios);

    expect(all).toHaveLength(41);
    expect(groups.map((group) => group.family)).toEqual([
      'concurrency',
      'conformance',
      'crash-recovery',
      'retry',
      'security',
      'wallet-lifecycle',
    ]);
    expect(all.find((item) => item.slug === 'retry/response-lost')).toMatchObject({
      name: 'http-response-lost',
      family: 'retry',
      commandCount: 3,
      sourceUrl:
        'https://github.com/GautamBytes/cashu-fault-lab/blob/main/scenarios/retry/response-lost.json',
    });
    expect(all.find((item) => item.slug === 'wallet-lifecycle/concurrent-resume')).toMatchObject({
      name: 'Concurrent resume',
      family: 'wallet-lifecycle',
      commandCount: 4,
    });
  });
});
