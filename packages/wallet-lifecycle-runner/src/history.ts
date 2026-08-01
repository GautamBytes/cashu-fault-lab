import type { LifecycleObservation } from '@cashu-fault-lab/wallet-lifecycle-oracle';
import type { LifecycleScenarioCommand } from './runner.js';

export interface LifecycleHistoryEntry {
  readonly commandIndex: number;
  readonly commandType: LifecycleScenarioCommand['type'];
  readonly outcome: 'completed' | 'failed';
  readonly observationCount: number;
}

export interface LifecycleFailureIdentity {
  readonly commandIndex: number;
  readonly code: 'LIFECYCLE_DRIVER' | 'LIFECYCLE_INVARIANT';
  readonly message: string;
}

export interface LifecycleFailureArtifact {
  readonly schemaVersion: 1;
  readonly scenario: {
    readonly id: string;
    readonly seed: string;
    readonly requireQuiescence: boolean;
    readonly commands: readonly LifecycleScenarioCommand[];
  };
  readonly redacted: boolean;
  readonly history: readonly LifecycleHistoryEntry[];
  readonly observations: readonly LifecycleObservation[];
  readonly failure: LifecycleFailureIdentity;
}

function sanitizeCommand(command: LifecycleScenarioCommand): {
  readonly command: LifecycleScenarioCommand;
  readonly redacted: boolean;
} {
  if (command.type !== 'start') return { command: structuredClone(command), redacted: false };
  if (command.input.kind === 'receive') {
    return {
      command: { ...command, input: { ...command.input, token: '[REDACTED]' } },
      redacted: true,
    };
  }
  if (command.input.kind === 'melt') {
    return {
      command: { ...command, input: { ...command.input, invoice: '[REDACTED]' } },
      redacted: true,
    };
  }
  return { command: structuredClone(command), redacted: false };
}

export function createFailureArtifact(input: {
  readonly id: string;
  readonly seed: string;
  readonly requireQuiescence: boolean;
  readonly commands: readonly LifecycleScenarioCommand[];
  readonly history: readonly LifecycleHistoryEntry[];
  readonly observations: readonly LifecycleObservation[];
  readonly failure: LifecycleFailureIdentity;
}): LifecycleFailureArtifact {
  const sanitized = input.commands.map(sanitizeCommand);
  return Object.freeze({
    schemaVersion: 1,
    scenario: Object.freeze({
      id: input.id,
      seed: input.seed,
      requireQuiescence: input.requireQuiescence,
      commands: Object.freeze(sanitized.map((entry) => entry.command)),
    }),
    redacted: sanitized.some((entry) => entry.redacted),
    history: Object.freeze(structuredClone(input.history)),
    observations: Object.freeze(structuredClone(input.observations)),
    failure: Object.freeze({ ...input.failure }),
  });
}
