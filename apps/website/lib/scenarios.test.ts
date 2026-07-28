import { describe, expect, it } from 'vitest';
import { getScenarioGroups } from './scenarios';

describe('getScenarioGroups', () => {
  it('discovers and groups every checked-in scenario', async () => {
    const groups = await getScenarioGroups();
    const all = groups.flatMap((group) => group.scenarios);

    expect(all).toHaveLength(32);
    expect(groups.map((group) => group.family)).toEqual([
      'concurrency',
      'conformance',
      'crash-recovery',
      'retry',
      'security',
    ]);
    expect(all.find((item) => item.slug === 'retry/response-lost')).toMatchObject({
      name: 'http-response-lost',
      family: 'retry',
      commandCount: 3,
      sourceUrl:
        'https://github.com/GautamBytes/cashu-fault-lab/blob/main/scenarios/retry/response-lost.json',
    });
  });
});
