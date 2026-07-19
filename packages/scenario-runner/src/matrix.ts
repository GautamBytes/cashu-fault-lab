import type { AdapterCapabilities, AdapterRole } from '@cashu-fault-lab/adapter-contract';

export interface MatrixParticipant {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
}

export type MatrixExecutionResult =
  | { readonly ok: true; readonly evidence?: Readonly<Record<string, unknown>> }
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
  const capability = participant.capabilities.profiles?.find(
    (candidate) => candidate.name === profile && candidate.roles.includes(role),
  );
  if (!capability) return `${participant.id}: ${profile} ${role} capability is not declared`;
  if (capability.status === 'unsupported') {
    return `${participant.id}: ${capability.reason ?? `${profile} ${role} is unsupported`}`;
  }
  return undefined;
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
