import type { AdapterCapabilities } from '@cashu-fault-lab/adapter-contract';
import {
  CompatibilityMatrix,
  runReferenceDeliveryProbe,
  type FailureArtifact,
  type MatrixCaseResult,
  type MatrixParticipant,
  type ScenarioRunResult,
  type ScenarioSpec,
} from '@cashu-fault-lab/scenario-runner';
import type { LabRuntime } from './index.js';

function profile(
  name: string,
  status: 'supported' | 'unsupported',
  reason?: string,
): NonNullable<AdapterCapabilities['profiles']>[number] {
  return {
    name,
    roles: ['sender', 'receiver'],
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

const referenceCapabilities: AdapterCapabilities = {
  implementation: 'reference-ts',
  version: '0.0.0',
  nuts: [2, 3, 7, 9, 10, 12, 18, 19],
  transports: ['http', 'nostr'],
  evidenceTier: 'T3',
  encodings: ['creqA'],
  profiles: [
    profile('legacy-nut18', 'supported'),
    profile('delivery-v1', 'supported'),
    profile('nut26-nostr', 'unsupported', 'Reference adapter does not implement creqB'),
  ],
};

function upstreamCapabilities(
  implementation: 'cashu-ts' | 'cdk',
  version: string,
): AdapterCapabilities {
  return {
    implementation,
    version,
    nuts: [18, 26],
    transports: ['http', 'nostr'],
    evidenceTier: 'T0',
    encodings: ['creqA', 'creqB'],
    profiles: [
      profile('legacy-nut18', 'supported'),
      profile(
        'delivery-v1',
        'unsupported',
        `${implementation} does not implement the experimental receipt/idempotency profile`,
      ),
      profile('nut26-nostr', 'supported'),
    ],
  };
}

const participants: readonly MatrixParticipant[] = [
  { id: 'reference-ts', capabilities: referenceCapabilities },
  { id: 'cashu-ts', capabilities: upstreamCapabilities('cashu-ts', '4.7.2') },
  { id: 'cdk', capabilities: upstreamCapabilities('cdk', '0.17.3') },
];

function missing(): never {
  throw new Error('This command requires the packaged lab service environment');
}

export class PackagedLabRuntime implements LabRuntime {
  async up(): Promise<void> {
    return missing();
  }

  async run(_scenario: ScenarioSpec, _seed: string): Promise<ScenarioRunResult> {
    return missing();
  }

  async replay(_artifact: FailureArtifact): Promise<ScenarioRunResult> {
    return missing();
  }

  async matrix(profileName: string, _seed: string): Promise<readonly MatrixCaseResult[]> {
    const matrix = new CompatibilityMatrix(async (selected, sender, receiver) => {
      if (selected === 'delivery-v1') return runReferenceDeliveryProbe();
      if (selected === 'legacy-nut18') {
        return {
          ok: true,
          evidence: {
            tier: 'T0',
            vectorSet: 'spec/vectors/upstream-payment-requests.json',
            cashuNutsRef: 'fccb68e9129de5348003f573dc97e1ee380a1076',
            senderEncodings: sender.capabilities.encodings ?? [],
            receiverEncodings: receiver.capabilities.encodings ?? [],
          },
        };
      }
      if (selected === 'nut26-nostr') {
        return {
          ok: false,
          code: 'NUT26_NIP_MAPPING_MISMATCH',
          reason: 'NUT-26 NIP-04/raw-key transport cannot be treated as NUT-18 NIP-17/nprofile',
        };
      }
      return { ok: false, code: 'UNKNOWN_PROFILE', reason: 'Matrix profile is not implemented' };
    });
    return matrix.run(profileName, participants, participants);
  }
}
