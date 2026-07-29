import { describe, expect, it } from 'vitest';
import { getReleaseStatus } from './release-status';

describe('getReleaseStatus', () => {
  it('reports the strict gate without turning requirements into passes', async () => {
    await expect(getReleaseStatus()).resolves.toMatchObject({
      label: 'Experimental developer preview',
      profile: 'delivery-v1',
      policySchemaVersion: 3,
      releaseSuiteScenarioCount: 13,
      minimumQualifyingPairs: 2,
      minimumDistinctMints: 2,
      currentQualifyingPairs: 0,
      currentDistinctMints: 0,
      blockers: [
        'Independent wallet receiver',
        'Independent mint and ledger evidence authorities',
        'Second qualifying implementation pair',
        'Second distinct mint identity',
        'External integration and review',
      ],
    });
  });
});
