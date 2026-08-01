import type { LifecycleCapabilities } from '@cashu-fault-lab/wallet-lifecycle-contract';
import type { LifecycleOperationKind } from '@cashu-fault-lab/wallet-lifecycle-core';

export interface LifecycleMatrixParticipant {
  readonly id: string;
  readonly capabilities: LifecycleCapabilities;
}

export type LifecycleMatrixExecution =
  | { readonly ok: true; readonly evidence?: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export type LifecycleMatrixResult =
  | {
      readonly id: string;
      readonly implementationId: string;
      readonly status: 'passed';
      readonly evidence?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly id: string;
      readonly implementationId: string;
      readonly status: 'failed';
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly id: string;
      readonly implementationId: string;
      readonly status: 'not_applicable';
      readonly reason: string;
    };

export type LifecycleMatrixExecutor = (
  participant: LifecycleMatrixParticipant,
) => Promise<LifecycleMatrixExecution>;

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

export class LifecycleCompatibilityMatrix {
  constructor(readonly execute: LifecycleMatrixExecutor) {}

  assertIndependent(participants: readonly LifecycleMatrixParticipant[]): void {
    const identities = new Set(
      participants.map((participant) => participant.capabilities.implementation.id),
    );
    if (identities.size < 2) {
      throw new Error('Lifecycle release evidence requires distinct implementation identities');
    }
  }

  async run(
    requiredOperations: readonly LifecycleOperationKind[],
    participants: readonly LifecycleMatrixParticipant[],
  ): Promise<readonly LifecycleMatrixResult[]> {
    if (requiredOperations.length === 0) throw new Error('Lifecycle matrix requires operations');
    const results: LifecycleMatrixResult[] = [];
    for (const participant of participants) {
      const implementationId = participant.capabilities.implementation.id;
      if (!IDENTIFIER_PATTERN.test(participant.id) || !IDENTIFIER_PATTERN.test(implementationId)) {
        results.push({
          id: participant.id,
          implementationId,
          status: 'failed',
          code: 'LIFECYCLE_IDENTITY_INVALID',
          reason: 'Lifecycle participant identity is invalid',
        });
        continue;
      }
      const missing = requiredOperations.filter(
        (operation) => !participant.capabilities.operations.includes(operation),
      );
      if (missing.length > 0) {
        results.push({
          id: participant.id,
          implementationId,
          status: 'not_applicable',
          reason: `Missing lifecycle operations: ${missing.join(', ')}`,
        });
        continue;
      }
      try {
        const execution = await this.execute(participant);
        if (execution.ok) {
          results.push({
            id: participant.id,
            implementationId,
            status: 'passed',
            ...(execution.evidence === undefined
              ? {}
              : { evidence: structuredClone(execution.evidence) }),
          });
        } else {
          results.push({
            id: participant.id,
            implementationId,
            status: 'failed',
            code: execution.code,
            reason: execution.reason,
          });
        }
      } catch {
        results.push({
          id: participant.id,
          implementationId,
          status: 'failed',
          code: 'LIFECYCLE_MATRIX_EXECUTION',
          reason: 'Lifecycle matrix executor failed',
        });
      }
    }
    return results;
  }
}
