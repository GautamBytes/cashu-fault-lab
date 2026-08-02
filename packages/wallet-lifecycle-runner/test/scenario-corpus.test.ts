import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateLifecycleScenarioSpec } from '../src/index.js';

const requiredScenarios = [
  'mint-response-lost',
  'swap-response-lost',
  'melt-pending-restart',
  'melt-paid-response-lost',
  'receive-crash-before-save',
  'restore-duplicate',
  'concurrent-resume',
  'stale-quote',
  'security-quote-redaction',
] as const;

describe('wallet lifecycle scenario corpus', () => {
  it.each(requiredScenarios)('strictly validates %s', (id) => {
    const scenario = JSON.parse(
      readFileSync(
        new URL(`../../../scenarios/wallet-lifecycle/${id}.json`, import.meta.url),
        'utf8',
      ),
    ) as unknown;
    expect(validateLifecycleScenarioSpec(scenario)).toEqual({ ok: true });
  });

  it('rejects secret-bearing metadata and unknown command fields', () => {
    expect(
      validateLifecycleScenarioSpec({
        schemaVersion: 1,
        id: 'unsafe-scenario',
        seed: 'seed-1',
        requireQuiescence: true,
        commands: [{ type: 'clear_faults', quoteId: 'secret' }],
      }),
    ).toMatchObject({ ok: false });
  });
});
