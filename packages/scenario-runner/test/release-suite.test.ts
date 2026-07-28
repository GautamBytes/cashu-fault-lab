import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateReleaseSuite, type ReleaseSuite } from '../src/release-suite.js';

const entry = {
  id: 'retry-response-lost',
  scenario: 'scenarios/retry/response-lost.json',
  transports: ['http'],
  senderDurability: 'persistent',
  receiverDurability: 'restart_safe',
  requiredInvariants: ['retry-convergence', 'stable-duplicate-response'],
} as const;

const suite: ReleaseSuite = {
  schemaVersion: 1,
  profile: 'delivery-v1',
  scenarios: [entry],
};

describe('release suite', () => {
  it('validates the repository suite and a minimal strict suite', () => {
    const repositorySuite = JSON.parse(
      readFileSync(new URL('../../../spec/release-suite.json', import.meta.url), 'utf8'),
    ) as unknown;

    expect(validateReleaseSuite(suite)).toEqual(suite);
    expect(validateReleaseSuite(repositorySuite)).toEqual(repositorySuite);
  });

  it('keeps release-policy scenario requirements aligned with the suite', () => {
    const repositorySuite = validateReleaseSuite(
      JSON.parse(
        readFileSync(new URL('../../../spec/release-suite.json', import.meta.url), 'utf8'),
      ),
    );
    const repositoryPolicy = JSON.parse(
      readFileSync(new URL('../../../spec/release-policy.json', import.meta.url), 'utf8'),
    ) as { readonly requiredScenarios: readonly string[] };

    expect(repositoryPolicy.requiredScenarios).toEqual(
      repositorySuite.scenarios.map(({ id }) => id),
    );
  });

  it('rejects unknown and missing fields', () => {
    expect(() => validateReleaseSuite({ ...suite, unexpected: true })).toThrowError(
      /unknown field/i,
    );
    const { profile: _profile, ...missingProfile } = suite;
    expect(() => validateReleaseSuite(missingProfile)).toThrowError(/fields/i);
    expect(() =>
      validateReleaseSuite({
        ...suite,
        scenarios: [{ ...entry, unexpected: true }],
      }),
    ).toThrowError(/unknown field/i);
  });

  it('rejects duplicate IDs, transports, and invariants', () => {
    expect(() => validateReleaseSuite({ ...suite, scenarios: [entry, entry] })).toThrowError(
      /duplicate scenario id/i,
    );
    expect(() =>
      validateReleaseSuite({
        ...suite,
        scenarios: [{ ...entry, transports: ['http', 'http'] }],
      }),
    ).toThrowError(/transports/i);
    expect(() =>
      validateReleaseSuite({
        ...suite,
        scenarios: [
          {
            ...entry,
            requiredInvariants: ['retry-convergence', 'retry-convergence'],
          },
        ],
      }),
    ).toThrowError(/requiredInvariants/i);
  });

  it.each([
    '../secrets.json',
    'scenarios/../secrets.json',
    '/scenarios/retry/response-lost.json',
    'scenarios//retry/response-lost.json',
    'scenarios/retry/response-lost.yaml',
  ])('rejects unsafe scenario path %s', (scenario) => {
    expect(() =>
      validateReleaseSuite({
        ...suite,
        scenarios: [{ ...entry, scenario }],
      }),
    ).toThrowError(/scenario path/i);
  });

  it('rejects unknown invariants and durability values', () => {
    expect(() =>
      validateReleaseSuite({
        ...suite,
        scenarios: [{ ...entry, requiredInvariants: ['not-a-real-invariant'] }],
      }),
    ).toThrowError(/requiredInvariants/i);
    expect(() =>
      validateReleaseSuite({
        ...suite,
        scenarios: [{ ...entry, receiverDurability: 'eventually-durable' }],
      }),
    ).toThrowError(/durability/i);
  });
});
