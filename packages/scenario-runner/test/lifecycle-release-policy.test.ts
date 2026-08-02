import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  evaluateLifecycleReleaseSuite,
  validateLifecycleReleaseSuite,
  type LifecycleReleaseEvidence,
  type LifecycleReleaseSuite,
} from '../src/index.js';

const suite = validateLifecycleReleaseSuite(
  JSON.parse(
    readFileSync(new URL('../../../spec/lifecycle-release-suite.json', import.meta.url), 'utf8'),
  ),
);

function evidence(walletId: string, language: string, mintId: string): LifecycleReleaseEvidence {
  const sourceCharacter = walletId === 'cashu-ts' ? 'a' : 'b';
  const buildCharacter = walletId === 'cashu-ts' ? 'c' : 'd';
  return {
    wallet: {
      id: walletId,
      language,
      sourceDigest: `sha256:${sourceCharacter.repeat(64)}`,
      buildDigest: `sha256:${buildCharacter.repeat(64)}`,
    },
    mint: { id: mintId, implementation: mintId.split('-')[0]! },
    operations: suite.requiredOperations,
    releaseSuiteDigest: suite.releaseSuiteDigest,
    secretScanPassed: true,
    scenarios: suite.requiredScenarios.map((id) => ({
      id,
      status: 'passed',
      replayDigest: `sha256:${'e'.repeat(64)}`,
      invariants: suite.requiredInvariants.map((invariant) => ({
        id: invariant,
        status: 'passed',
      })),
    })),
  };
}

describe('wallet lifecycle release policy', () => {
  it('validates the checked-in suite against its published schema and exact digest', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../../../spec/schemas/lifecycle-release-suite.schema.json', import.meta.url),
        'utf8',
      ),
    ) as object;
    expect(new Ajv2020({ strict: true }).validate(schema, suite)).toBe(true);
    expect(() =>
      validateLifecycleReleaseSuite({
        ...suite,
        requiredScenarios: suite.requiredScenarios.slice(1),
      }),
    ).toThrow(/digest|scenario/u);
  });

  it('accepts complete evidence from two independent wallet and mint implementations', () => {
    expect(
      evaluateLifecycleReleaseSuite(suite, [
        evidence('cashu-ts', 'typescript', 'nutshell-local'),
        evidence('cdk', 'rust', 'mintd-local'),
      ]),
    ).toEqual({ passed: true, reasons: [] });
  });

  it('rejects skipped scenarios, missing replay, secret leaks, and one implementation aliases', () => {
    const first = evidence('cashu-ts', 'typescript', 'nutshell-local');
    const result = evaluateLifecycleReleaseSuite(suite, [
      {
        ...first,
        secretScanPassed: false,
        scenarios: first.scenarios.map((scenario, index) => {
          if (index !== 0) return scenario;
          const { replayDigest: _replayDigest, ...withoutReplay } = scenario;
          return { ...withoutReplay, status: 'not_applicable' };
        }),
      },
      { ...first, mint: { id: 'nutshell-alias', implementation: 'nutshell' } },
    ]);

    expect(result.passed).toBe(false);
    expect(result.reasons.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        'LIFECYCLE_MINIMUM_WALLETS',
        'LIFECYCLE_MINIMUM_MINTS',
        'LIFECYCLE_REQUIRED_SCENARIO',
        'LIFECYCLE_REPLAY_REQUIRED',
        'LIFECYCLE_SECRET_SCAN',
      ]),
    );
  });

  it('rejects unknown fields and a policy that permits skipped required scenarios', () => {
    expect(() => validateLifecycleReleaseSuite({ ...suite, allowSkippedRequired: true })).toThrow(
      /allowSkippedRequired/u,
    );
    expect(() => validateLifecycleReleaseSuite({ ...suite, surprise: true })).toThrow(
      /unknown field/u,
    );
  });

  it('rejects malformed, contradictory, duplicate, and secret-bearing forged evidence', () => {
    const first = evidence('cashu-ts', 'typescript', 'nutshell-local');
    const contradictory = {
      ...first,
      wallet: { ...first.wallet, buildDigest: `sha256:${'f'.repeat(64)}` },
      mint: { id: 'mintd-local', implementation: 'mintd' },
    };
    const result = evaluateLifecycleReleaseSuite(suite, [
      first,
      first,
      contradictory,
      { ...evidence('cdk', 'rust', 'mintd-local'), proof: 'secret-forgery' } as never,
    ]);
    expect(result.passed).toBe(false);
    expect(result.reasons.filter(({ code }) => code === 'LIFECYCLE_EVIDENCE_INVALID')).toHaveLength(
      3,
    );
  });
});
