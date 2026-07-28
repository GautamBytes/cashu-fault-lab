import {
  developmentIdentity,
  type AdapterCapabilities,
  type AdapterMintIdentity,
} from '@cashu-fault-lab/adapter-contract';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  evaluateReleasePolicy,
  validateReleasePolicy,
  type InvariantResult,
  type MatrixCaseResult,
  type ReleasePolicy,
} from '../src/index.js';

const required = [
  'at-most-one-merchant-credit-per-delivery',
  'independent-ledger-evidence',
] as const;

const policy: ReleasePolicy = {
  schemaVersion: 2,
  profile: 'delivery-v1',
  minimumQualifyingPairs: 2,
  requireCrossImplementation: true,
  requireCrossLanguage: true,
  requireDistinctBuilds: true,
  minimumDistinctMints: 2,
  minimumEvidence: { sender: 'T1', receiver: 'T3' },
  requiredInvariants: required,
  requiredScenarios: ['retry-response-lost'],
  acceptedConfidence: ['observed', 'derived'],
};

function capability(
  id: string,
  language: string,
  role: 'sender' | 'receiver',
  tier: 'T0' | 'T1' | 'T2' | 'T3',
  mint: AdapterMintIdentity,
  buildAlias?: string,
): AdapterCapabilities {
  const identityId = buildAlias ?? id;
  const digest = (domain: string) =>
    `sha256:${createHash('sha256').update(`release-test/${domain}/${identityId}`).digest('hex')}`;
  const identity = {
    id: identityId,
    version: '1.0.0',
    language,
    runtime: language === 'rust' ? 'native' : 'node-24',
    sourceDigest: digest('source'),
    buildDigest: digest('build'),
  };
  return {
    schemaVersion: 2,
    implementation: { ...identity, id },
    roles: {
      [role]: {
        transports: ['http'],
        profiles: ['delivery-v1'],
        durability: role === 'receiver' ? 'restart_safe' : 'persistent',
        evidence: {
          tier,
          sources:
            role === 'receiver'
              ? ['adapter', 'runner', 'mint', 'durable_ledger']
              : ['adapter', 'runner', 'transport'],
        },
      },
    },
    nuts: [3, 7, 18],
    encodings: ['creqA'],
    mints: [mint],
  };
}

function invariant(
  id: (typeof required)[number],
  confidence: InvariantResult['confidence'] = 'observed',
): InvariantResult {
  return {
    id,
    status: 'passed',
    confidence,
    evidence: [{ source: 'ledger', description: 'Independent test evidence.' }],
  };
}

function passingCase(
  options: {
    sender?: string;
    receiver?: string;
    senderLanguage?: string;
    receiverLanguage?: string;
    senderTier?: 'T0' | 'T1' | 'T2' | 'T3';
    receiverTier?: 'T0' | 'T1' | 'T2' | 'T3';
    mint?: AdapterMintIdentity;
    invariants?: readonly InvariantResult[];
    senderBuildAlias?: string;
    receiverBuildAlias?: string;
  } = {},
): Extract<MatrixCaseResult, { readonly status: 'passed' }> {
  const sender = options.sender ?? 'sender-ts';
  const receiver = options.receiver ?? 'receiver-rs';
  const mint = options.mint ?? { id: 'nutshell-local', implementation: 'nutshell' };
  return {
    profile: 'delivery-v1',
    sender,
    receiver,
    status: 'passed',
    senderCapabilities: capability(
      sender,
      options.senderLanguage ?? 'typescript',
      'sender',
      options.senderTier ?? 'T1',
      mint,
      options.senderBuildAlias,
    ),
    receiverCapabilities: capability(
      receiver,
      options.receiverLanguage ?? 'rust',
      'receiver',
      options.receiverTier ?? 'T3',
      mint,
      options.receiverBuildAlias,
    ),
    mints: [mint],
    invariants: options.invariants ?? required.map((id) => invariant(id)),
  };
}

function codes(cases: readonly MatrixCaseResult[], selectedPolicy = policy): readonly string[] {
  return evaluateReleasePolicy(selectedPolicy, cases).reasons.map((reason) => reason.code);
}

describe('release policy', () => {
  it('validates the repository release policy and rejects unknown invariants', () => {
    const repositoryPolicy = JSON.parse(
      readFileSync(new URL('../../../spec/release-policy.json', import.meta.url), 'utf8'),
    );
    expect(validateReleasePolicy(repositoryPolicy)).toEqual(repositoryPolicy);
    expect(() =>
      validateReleasePolicy({
        ...repositoryPolicy,
        requiredInvariants: ['not-a-real-invariant'],
      }),
    ).toThrow(/requiredInvariants/u);
    expect(() =>
      validateReleasePolicy({
        ...repositoryPolicy,
        requiredScenarios: ['retry-response-lost', 'retry-response-lost'],
      }),
    ).toThrow(/requiredScenarios/u);
    expect(() =>
      validateReleasePolicy({
        ...repositoryPolicy,
        requiredScenarios: ['Unsafe Scenario'],
      }),
    ).toThrow(/requiredScenarios/u);
  });

  it('accepts two independent cross-language pairs backed by two mints', () => {
    const first = passingCase();
    const second = passingCase({
      sender: 'sender-rs',
      receiver: 'receiver-ts',
      senderLanguage: 'rust',
      receiverLanguage: 'typescript',
      mint: { id: 'cdk-local', implementation: 'cdk-mintd' },
    });

    expect(evaluateReleasePolicy(policy, [first, second])).toMatchObject({
      passed: true,
      qualifyingPairs: ['sender-rs->receiver-ts', 'sender-ts->receiver-rs'],
      reasons: [],
    });
  });

  it('rejects same implementation, same language, and non-distinct builds', () => {
    expect(
      codes([
        passingCase({ sender: 'same', receiver: 'same' }),
        passingCase({ senderLanguage: 'typescript', receiverLanguage: 'typescript' }),
        passingCase({
          senderLanguage: 'typescript',
          receiverLanguage: 'typescript',
          senderBuildAlias: 'same-build',
          receiverBuildAlias: 'same-build',
        }),
      ]),
    ).toEqual(
      expect.arrayContaining([
        'CROSS_IMPLEMENTATION_REQUIRED',
        'CROSS_LANGUAGE_REQUIRED',
        'DISTINCT_BUILD_REQUIRED',
      ]),
    );
  });

  it('enforces role-specific evidence floors', () => {
    expect(codes([passingCase({ senderTier: 'T0', receiverTier: 'T1' })])).toEqual(
      expect.arrayContaining(['SENDER_EVIDENCE_TOO_LOW', 'RECEIVER_EVIDENCE_TOO_LOW']),
    );
  });

  it('rejects deterministic development identities as release evidence', () => {
    const selected = passingCase();
    const sender = selected.senderCapabilities.implementation;
    const identity = developmentIdentity(sender);

    expect(
      codes([
        {
          ...selected,
          senderCapabilities: { ...selected.senderCapabilities, implementation: identity },
        },
      ]),
    ).toContain('DEVELOPMENT_IDENTITY_NOT_RELEASE_ELIGIBLE');
  });

  it('rejects missing and adapter-claimed invariant evidence', () => {
    expect(
      codes([
        passingCase({ invariants: [invariant(required[0])] }),
        passingCase({
          sender: 'sender-two',
          receiver: 'receiver-two',
          invariants: required.map((id) => invariant(id, 'adapter_claimed')),
        }),
      ]),
    ).toEqual(
      expect.arrayContaining(['REQUIRED_INVARIANT_MISSING', 'INVARIANT_CONFIDENCE_REJECTED']),
    );
  });

  it('deduplicates aliases of one build and still enforces pair and mint minima', () => {
    const first = passingCase();
    const alias = passingCase({
      sender: 'sender-alias',
      receiver: 'receiver-alias',
      senderBuildAlias: 'sender-ts',
      receiverBuildAlias: 'receiver-rs',
    });
    const result = evaluateReleasePolicy(policy, [first, alias]);

    expect(result.passed).toBe(false);
    expect(result.qualifyingPairs).toHaveLength(1);
    expect(result.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'DUPLICATE_PROVENANCE',
        'MINIMUM_QUALIFYING_PAIRS',
        'MINIMUM_DISTINCT_MINTS',
      ]),
    );
  });
});
