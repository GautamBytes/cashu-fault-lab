import {
  validateAdapterCompatibility,
  type AdapterCompatibilityResult,
  type AdapterCapabilities,
  type AdapterMintIdentity,
  type AdapterRole,
} from '@cashu-fault-lab/adapter-contract';
import type { InvariantId, InvariantResult } from '@cashu-fault-lab/oracle';

export interface MatrixParticipant {
  readonly id: string;
  readonly capabilities: AdapterCapabilities;
}

export interface MatrixCaseCompatibility {
  readonly sender: AdapterCompatibilityResult;
  readonly receiver: AdapterCompatibilityResult;
}

export interface MatrixScenarioEvidence {
  readonly id: string;
  readonly seed: string;
  readonly status: 'passed' | 'failed' | 'not_applicable';
  readonly requiredInvariants: readonly InvariantId[];
  readonly invariants: readonly InvariantResult[];
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly componentVersions?: Readonly<Record<string, string>>;
  readonly imageDigests?: Readonly<Record<string, string>>;
  readonly code?: string;
  readonly reason?: string;
}

export type MatrixExecutionResult =
  | {
      readonly ok: true;
      readonly evidence?: Readonly<Record<string, unknown>>;
      readonly invariants?: readonly InvariantResult[];
      readonly mints?: readonly AdapterMintIdentity[];
      readonly scenarios?: readonly MatrixScenarioEvidence[];
      readonly releaseSuiteDigest?: string;
    }
  | { readonly ok: null; readonly reason: string }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type MatrixExecutor = (
  profile: string,
  sender: MatrixParticipant,
  receiver: MatrixParticipant,
) => Promise<MatrixExecutionResult>;

export function releaseSuiteFailure(
  scenarios: readonly MatrixScenarioEvidence[],
): { readonly code: 'RELEASE_SUITE_NOT_PASSED'; readonly reason: string } | undefined {
  const blockers = scenarios.filter(({ status }) => status !== 'passed');
  if (blockers.length === 0) return undefined;
  return {
    code: 'RELEASE_SUITE_NOT_PASSED',
    reason: `Required release scenarios did not pass: ${blockers
      .map(({ id, status }) => `${id} (${status})`)
      .join(', ')}`,
  };
}

interface MatrixCaseIdentity {
  readonly profile: string;
  readonly sender: string;
  readonly receiver: string;
  readonly compatibility?: MatrixCaseCompatibility;
}

export type MatrixCaseResult =
  | (MatrixCaseIdentity & {
      readonly status: 'passed';
      readonly senderCapabilities: AdapterCapabilities;
      readonly receiverCapabilities: AdapterCapabilities;
      readonly invariants: readonly InvariantResult[];
      readonly mints: readonly AdapterMintIdentity[];
      readonly scenarios: readonly MatrixScenarioEvidence[];
      readonly releaseSuiteDigest?: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
    })
  | (MatrixCaseIdentity & {
      readonly status: 'failed' | 'expected_failure';
      readonly code: string;
      readonly reason: string;
      readonly invariants?: readonly InvariantResult[];
      readonly mints?: readonly AdapterMintIdentity[];
      readonly scenarios?: readonly MatrixScenarioEvidence[];
      readonly releaseSuiteDigest?: string;
      readonly evidence?: Readonly<Record<string, unknown>>;
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

  async runPair(
    profile: string,
    sender: MatrixParticipant,
    receiver: MatrixParticipant,
  ): Promise<MatrixCaseResult> {
    const [result] = await this.run(profile, [sender], [receiver]);
    if (result === undefined) throw new Error('Matrix pair did not produce a result');
    return result;
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
        const compatibility: MatrixCaseCompatibility = {
          sender: validateAdapterCompatibility(sender.capabilities),
          receiver: validateAdapterCompatibility(receiver.capabilities),
        };
        const incompatible = [compatibility.sender, compatibility.receiver].find(
          (result): result is Extract<AdapterCompatibilityResult, { readonly ok: false }> =>
            !result.ok,
        );
        const compatibleIdentity = { ...identity, compatibility };
        if (incompatible !== undefined) {
          results.push({
            ...compatibleIdentity,
            status: 'failed',
            code: incompatible.code,
            reason: incompatible.reason,
          });
          continue;
        }
        const unsupported =
          unsupportedReason(profile, sender, 'sender') ??
          unsupportedReason(profile, receiver, 'receiver');
        if (unsupported) {
          results.push({ ...compatibleIdentity, status: 'not_applicable', reason: unsupported });
          continue;
        }
        let execution: MatrixExecutionResult;
        try {
          execution = await this.#execute(profile, sender, receiver);
        } catch {
          results.push({
            ...compatibleIdentity,
            status: 'failed',
            code: 'MATRIX_EXECUTION_ERROR',
            reason: 'Matrix executor failed',
          });
          continue;
        }
        if (execution.ok === null) {
          results.push({
            ...compatibleIdentity,
            status: 'not_applicable',
            reason: execution.reason,
          });
          continue;
        }
        if (execution.ok) {
          const scenarios = structuredClone(execution.scenarios ?? []);
          const suiteFailure = releaseSuiteFailure(scenarios);
          if (suiteFailure !== undefined) {
            results.push({
              ...compatibleIdentity,
              status: 'failed',
              ...suiteFailure,
              invariants: structuredClone(execution.invariants ?? []),
              mints: structuredClone(execution.mints ?? []),
              scenarios,
              ...(execution.releaseSuiteDigest === undefined
                ? {}
                : { releaseSuiteDigest: execution.releaseSuiteDigest }),
              ...(execution.evidence === undefined ? {} : { evidence: execution.evidence }),
            });
            continue;
          }
          results.push({
            ...compatibleIdentity,
            status: 'passed',
            senderCapabilities: structuredClone(sender.capabilities),
            receiverCapabilities: structuredClone(receiver.capabilities),
            invariants: structuredClone(execution.invariants ?? []),
            mints: structuredClone(execution.mints ?? []),
            scenarios,
            ...(execution.releaseSuiteDigest === undefined
              ? {}
              : { releaseSuiteDigest: execution.releaseSuiteDigest }),
            ...(execution.evidence === undefined ? {} : { evidence: execution.evidence }),
          });
          continue;
        }
        const expected =
          profile === 'nut26-nostr' && execution.code === 'NUT26_NIP_MAPPING_MISMATCH';
        results.push({
          ...compatibleIdentity,
          status: expected ? 'expected_failure' : 'failed',
          code: execution.code,
          reason: execution.reason,
        });
      }
    }
    return results;
  }
}
