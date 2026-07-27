import type {
  AdapterCapabilities,
  AdapterMintIdentity,
  AdapterRole,
} from '@cashu-fault-lab/adapter-contract';
import type { InvariantResult } from '@cashu-fault-lab/oracle';

export interface MatrixParticipant {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
}

export type MatrixExecutionResult =
  | {
      readonly ok: true;
      readonly evidence?: Readonly<Record<string, unknown>>;
      readonly invariants?: readonly InvariantResult[];
      readonly mints?: readonly AdapterMintIdentity[];
    }
  | { readonly ok: null; readonly reason: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type MatrixExecutor = (
  profile: string,
  sender: MatrixParticipant,
  receiver: MatrixParticipant,
) => Promise<MatrixExecutionResult>;

interface MatrixCaseIdentity {
  readonly profile: string;
  readonly sender: string;
  readonly receiver: string;
}

export type MatrixCaseResult =
  | (MatrixCaseIdentity & {
      readonly status: 'passed';
      readonly senderCapabilities: AdapterCapabilities;
      readonly receiverCapabilities: AdapterCapabilities;
      readonly invariants: readonly InvariantResult[];
      readonly mints: readonly AdapterMintIdentity[];
      readonly evidence?: Readonly<Record<string, unknown>>;
    })
  | (MatrixCaseIdentity & {
      readonly status: 'failed' | 'expected_failure';
      readonly code: string;
      readonly reason: string;
    })
  | (MatrixCaseIdentity & {
      readonly status: 'not_applicable';
      readonly reason: string;
    });

function unsupportedReason(
  profile: string,
  participant: MatrixParticipant,
  role: AdapterRole,
): string | undefined {
  const capability = participant.capabilities.roles[role];
  if (capability?.profiles.includes(profile)) return undefined;
  return `${participant.id}: ${profile} ${role} capability is not declared`;
}

export class CompatibilityMatrix {
  readonly #execute: MatrixExecutor;

  constructor(execute: MatrixExecutor) {
    this.#execute = execute;
  }

  async run(
    profile: string,
    senders: readonly MatrixParticipant[],
    receivers: readonly MatrixParticipant[],
  ): Promise<readonly MatrixCaseResult[]> {
    if (!profile) throw new Error('Matrix profile is required');
    if (senders.length < 1 || receivers.length < 1) {
      throw new Error('Matrix requires at least one sender and receiver');
    }
    const results: MatrixCaseResult[] = [];
    for (const sender of senders) {
      for (const receiver of receivers) {
        const identity: MatrixCaseIdentity = {
          profile,
          sender: sender.id,
          receiver: receiver.id,
        };
        const unsupported =
          unsupportedReason(profile, sender, 'sender') ??
          unsupportedReason(profile, receiver, 'receiver');
        if (unsupported) {
          results.push({ ...identity, status: 'not_applicable', reason: unsupported });
          continue;
        }
        let execution: MatrixExecutionResult;
        try {
          execution = await this.#execute(profile, sender, receiver);
        } catch {
          results.push({
            ...identity,
            status: 'failed',
            code: 'MATRIX_EXECUTION_ERROR',
            reason: 'Matrix executor failed',
          });
          continue;
        }
        if (execution.ok === null) {
          results.push({ ...identity, status: 'not_applicable', reason: execution.reason });
          continue;
        }
        if (execution.ok) {
          results.push({
            ...identity,
            status: 'passed',
            senderCapabilities: structuredClone(sender.capabilities),
            receiverCapabilities: structuredClone(receiver.capabilities),
            invariants: structuredClone(execution.invariants ?? []),
            mints: structuredClone(execution.mints ?? []),
            ...(execution.evidence === undefined ? {} : { evidence: execution.evidence }),
          });
          continue;
        }
        const expected =
          profile === 'nut26-nostr' && execution.code === 'NUT26_NIP_MAPPING_MISMATCH';
        results.push({
          ...identity,
          status: expected ? 'expected_failure' : 'failed',
          code: execution.code,
          reason: execution.reason,
        });
      }
    }
    return results;
  }
}
