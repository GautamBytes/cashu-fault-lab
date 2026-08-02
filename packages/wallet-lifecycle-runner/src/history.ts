import type { LifecycleObservation } from '@cashu-fault-lab/wallet-lifecycle-oracle';
import { createHash } from 'node:crypto';
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
  readonly detailHash?: string;
}

export interface LifecycleFailureArtifact {
  readonly schemaVersion: 2;
  readonly scenario: {
    readonly id: string;
    /** Domain-separated digest. The replay seed must be supplied out of band. */
    readonly seedHash: string;
    readonly requireQuiescence: boolean;
    readonly commands: readonly LifecycleScenarioCommand[];
  };
  readonly redacted: boolean;
  readonly history: readonly LifecycleHistoryEntry[];
  readonly observations: readonly LifecycleObservation[];
  readonly failure: LifecycleFailureIdentity;
}

export function lifecycleSeedHash(seed: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/wallet-lifecycle-replay-seed/v1\0')
    .update(seed)
    .digest('hex');
}

export function lifecycleFailurePublicMessage(code: LifecycleFailureIdentity['code']): string {
  return code === 'LIFECYCLE_INVARIANT'
    ? 'Lifecycle safety invariant failed.'
    : 'Lifecycle driver execution failed.';
}

export function lifecycleFailureDetailHash(failure: LifecycleFailureIdentity): string {
  return `sha256:${createHash('sha256')
    .update('cashu-fault-lab/wallet-lifecycle-failure-detail/v1\0')
    .update(failure.code)
    .update('\0')
    .update(failure.message)
    .digest('hex')}`;
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

function sanitizeFailureIdentity(failure: LifecycleFailureIdentity): LifecycleFailureIdentity {
  return {
    commandIndex: failure.commandIndex,
    code: failure.code,
    message: lifecycleFailurePublicMessage(failure.code),
    detailHash: failure.detailHash ?? lifecycleFailureDetailHash(failure),
  };
}

export function redactLifecycleFailureArtifact(
  artifact: LifecycleFailureArtifact,
): LifecycleFailureArtifact {
  const sanitized = artifact.scenario.commands.map(sanitizeCommand);
  return Object.freeze({
    schemaVersion: 2,
    scenario: Object.freeze({
      id: artifact.scenario.id,
      seedHash: artifact.scenario.seedHash,
      requireQuiescence: artifact.scenario.requireQuiescence,
      commands: Object.freeze(sanitized.map((entry) => entry.command)),
    }),
    redacted: artifact.redacted || sanitized.some((entry) => entry.redacted),
    history: Object.freeze(structuredClone(artifact.history)),
    observations: Object.freeze(structuredClone(artifact.observations)),
    failure: Object.freeze(sanitizeFailureIdentity(artifact.failure)),
  });
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
    schemaVersion: 2,
    scenario: Object.freeze({
      id: input.id,
      seedHash: lifecycleSeedHash(input.seed),
      requireQuiescence: input.requireQuiescence,
      commands: Object.freeze(sanitized.map((entry) => entry.command)),
    }),
    redacted: sanitized.some((entry) => entry.redacted),
    history: Object.freeze(structuredClone(input.history)),
    observations: Object.freeze(structuredClone(input.observations)),
    failure: Object.freeze(sanitizeFailureIdentity(input.failure)),
  });
}
