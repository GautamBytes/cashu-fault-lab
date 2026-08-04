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

    expect(all).toHaveLength(50);
    expect(groups.map((group) => group.family)).toEqual([
      'concurrency',
      'conformance',
      'crash-recovery',
      'retry',
      'security',
      'wallet-doctor',
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
    expect(all.find((item) => item.slug === 'wallet-doctor/del-chain-break')).toMatchObject({
      name: 'Del-chain break across two relays',
      family: 'wallet-doctor',
      commandCount: 2,
      runCommand: 'pnpm lab wallet-doctor run del-chain-break --seed demo',
    });
    expect(all.find((item) => item.slug === 'wallet-doctor/missing-wallet-event')).toMatchObject({
      name: 'Wallet metadata absent from every relay',
      family: 'wallet-doctor',
    });
    expect(all.find((item) => item.slug === 'wallet-doctor/deletion-not-propagated')).toMatchObject(
      {
        name: 'Standalone deletion reaches one relay',
        family: 'wallet-doctor',
      },
    );
  });
});
