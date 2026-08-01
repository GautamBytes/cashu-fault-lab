import {
  lifecycleSeedHash,
  type LifecycleHistoryEntry,
  type LifecycleScenarioCommand,
  type LifecycleScenarioRunResult,
  type LifecycleScenarioSpec,
} from '@cashu-fault-lab/wallet-lifecycle-runner';
import type { LifecycleObservation } from '@cashu-fault-lab/wallet-lifecycle-oracle';

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const OPERATION_ID = /^[A-Za-z0-9_-]{21}[AQgw]$/u;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface LifecycleReportInput {
  readonly scenario: LifecycleScenarioSpec;
  readonly result: LifecycleScenarioRunResult;
  readonly adapterId: string;
  readonly mintId: string;
  readonly componentVersions?: Readonly<Record<string, string>>;
  readonly imageDigests?: Readonly<Record<string, string>>;
}

export interface LifecycleReportDocument {
  readonly schemaVersion: 1;
  readonly suite: 'wallet-lifecycle-v1';
  readonly scenarioId: string;
  readonly seedHash: string;
  readonly status: 'passed' | 'failed';
  readonly adapterId: string;
  readonly mintId: string;
  readonly commands: readonly Readonly<Record<string, string | number | boolean>>[];
  readonly history: readonly LifecycleHistoryEntry[];
  readonly observations: readonly Readonly<Record<string, unknown>>[];
  readonly componentVersions: Readonly<Record<string, string>>;
  readonly imageDigests: Readonly<Record<string, string>>;
  readonly failure?: {
    readonly code: 'LIFECYCLE_DRIVER' | 'LIFECYCLE_INVARIANT';
    readonly commandIndex: number;
    readonly message: string;
  };
}

function commandView(
  command: LifecycleScenarioCommand,
): Readonly<Record<string, string | number | boolean>> {
  switch (command.type) {
    case 'fault':
      return {
        type: command.type,
        action: command.rule.action,
        endpoint: command.rule.endpoint,
        occurrence: command.rule.occurrence,
        ...(command.rule.delayMs === undefined ? {} : { delayMs: command.rule.delayMs }),
        ...(command.rule.truncateBytes === undefined
          ? {}
          : { truncateBytes: command.rule.truncateBytes }),
      };
    case 'clear_faults':
      return { type: command.type };
    case 'start':
      return {
        type: command.type,
        operationId: command.input.operationId,
        operation: command.input.kind,
        mint: command.input.mint,
        unit: command.input.unit,
        ...('amount' in command.input ? { amount: command.input.amount } : {}),
        ...(command.input.kind === 'mint' ? { method: command.input.method } : {}),
        ...(command.input.kind === 'melt' && command.input.preferAsync !== undefined
          ? { preferAsync: command.input.preferAsync }
          : {}),
        ...(command.input.kind === 'reconcile'
          ? { targetOperationId: command.input.targetOperationId }
          : {}),
      };
    case 'resume':
      return { type: command.type, operationId: command.operationId };
    case 'restart':
      return { type: command.type, component: command.component };
    case 'resume_concurrently':
      return {
        type: command.type,
        operationId: command.operationId,
        count: command.count,
      };
  }
}

function safeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function observationView(
  observation: LifecycleObservation,
): Readonly<Record<string, unknown>> | undefined {
  switch (observation.type) {
    case 'operation_observed':
      if (
        !OPERATION_ID.test(observation.operation.operationId) ||
        !safeUrl(observation.operation.mint) ||
        !HASH.test(observation.operation.intentHash)
      ) {
        return undefined;
      }
      return {
        type: observation.type,
        operation: {
          operationId: observation.operation.operationId,
          kind: observation.operation.kind,
          mint: observation.operation.mint,
          unit: observation.operation.unit,
          intentHash: observation.operation.intentHash,
          phase: observation.operation.phase,
        },
      };
    case 'phase_observed':
      return OPERATION_ID.test(observation.operationId)
        ? {
            type: observation.type,
            operationId: observation.operationId,
            phase: observation.phase,
            ...(observation.evidenceCode !== undefined && ID.test(observation.evidenceCode)
              ? { evidenceCode: observation.evidenceCode }
              : {}),
          }
        : undefined;
    case 'value_moved':
      return OPERATION_ID.test(observation.operationId) && ID.test(observation.effectId)
        ? {
            type: observation.type,
            operationId: observation.operationId,
            effectId: observation.effectId,
            unit: observation.unit,
            amount: observation.amount,
            from: observation.from,
            to: observation.to,
          }
        : undefined;
    case 'request_dispatched':
      return OPERATION_ID.test(observation.operationId) && HASH.test(observation.bodyHash)
        ? { ...observation }
        : undefined;
    case 'mint_quote_observed':
      return OPERATION_ID.test(observation.operationId) && HASH.test(observation.quoteHash)
        ? { ...observation }
        : undefined;
    case 'proof_state_observed':
      return OPERATION_ID.test(observation.operationId) && HASH.test(observation.proofId)
        ? { ...observation }
        : undefined;
    case 'lightning_settlement_observed':
      return OPERATION_ID.test(observation.operationId) &&
        HASH.test(observation.invoiceHash) &&
        HASH.test(observation.paymentHash)
        ? { ...observation }
        : undefined;
    case 'outputs_persisted':
      return OPERATION_ID.test(observation.operationId) && HASH.test(observation.outputPlanHash)
        ? { ...observation }
        : undefined;
  }
}

function metadata(
  values: Readonly<Record<string, string>> | undefined,
  pattern: RegExp,
  name: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (!ID.test(key) || !pattern.test(value)) throw new Error(`Lifecycle ${name} is invalid`);
    result[key] = value;
  }
  return result;
}

export function createLifecycleReport(input: LifecycleReportInput): LifecycleReportDocument {
  if (!ID.test(input.scenario.id) || !ID.test(input.adapterId) || !ID.test(input.mintId)) {
    throw new Error('Lifecycle report identity is invalid');
  }
  const failed = !input.result.ok;
  const seedHash = lifecycleSeedHash(input.scenario.seed);
  if (failed && seedHash !== input.result.artifact.scenario.seedHash) {
    throw new Error('Lifecycle report seed does not match failure evidence');
  }
  const history = failed ? input.result.artifact.history : input.result.history;
  const observations = failed
    ? input.result.artifact.observations
    : input.result.model.observations;
  return {
    schemaVersion: 1,
    suite: 'wallet-lifecycle-v1',
    scenarioId: input.scenario.id,
    seedHash,
    status: failed ? 'failed' : 'passed',
    adapterId: input.adapterId,
    mintId: input.mintId,
    commands: input.scenario.commands.map(commandView),
    history: structuredClone(history),
    observations: observations.flatMap((observation) => {
      const view = observationView(observation);
      return view === undefined ? [] : [view];
    }),
    componentVersions: metadata(input.componentVersions, VERSION, 'component version'),
    imageDigests: metadata(input.imageDigests, DIGEST, 'image digest'),
    ...(failed
      ? {
          failure: {
            code: input.result.artifact.failure.code,
            commandIndex: input.result.artifact.failure.commandIndex,
            message:
              input.result.artifact.failure.code === 'LIFECYCLE_INVARIANT'
                ? 'Lifecycle safety invariant failed.'
                : 'Lifecycle driver execution failed.',
          },
        }
      : {}),
  };
}
