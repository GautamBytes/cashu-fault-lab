import type { LifecycleOperationInput } from '@cashu-fault-lab/wallet-lifecycle-contract';
import {
  applyLifecycleObservation,
  assertLifecycleQuiescence,
  assertLifecycleSafety,
  emptyLifecycleModel,
  type LifecycleModel,
  type LifecycleObservation,
} from '@cashu-fault-lab/wallet-lifecycle-oracle';
import {
  createFailureArtifact,
  type LifecycleFailureArtifact,
  type LifecycleFailureIdentity,
  type LifecycleHistoryEntry,
} from './history.js';

export interface LifecycleFaultRule {
  readonly action:
    | 'drop_request'
    | 'drop_response'
    | 'delay_request'
    | 'delay_response'
    | 'reset_connection'
    | 'stale_response'
    | 'truncate_response';
  readonly endpoint: 'mint' | 'swap' | 'melt' | 'quote' | 'proof_state' | 'restore';
  readonly occurrence: number;
}

export type LifecycleScenarioCommand =
  | { readonly type: 'fault'; readonly rule: LifecycleFaultRule }
  | { readonly type: 'clear_faults' }
  | { readonly type: 'start'; readonly input: LifecycleOperationInput }
  | { readonly type: 'resume'; readonly operationId: string };

export interface LifecycleScenarioSpec {
  readonly id: string;
  readonly seed: string;
  readonly commands: readonly LifecycleScenarioCommand[];
  readonly requireQuiescence?: boolean;
}

export interface LifecycleDriverStep {
  readonly observations: readonly LifecycleObservation[];
}

export interface LifecycleDriver {
  reset(seed: string): Promise<void>;
  configureFault(rule: LifecycleFaultRule | undefined): Promise<void>;
  start(input: LifecycleOperationInput): Promise<LifecycleDriverStep>;
  resume(operationId: string): Promise<LifecycleDriverStep>;
}

export type LifecycleScenarioRunResult =
  | {
      readonly ok: true;
      readonly model: LifecycleModel;
      readonly history: readonly LifecycleHistoryEntry[];
    }
  | {
      readonly ok: false;
      readonly artifact: LifecycleFailureArtifact;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Lifecycle scenario failed';
}

function failureCode(error: unknown): LifecycleFailureIdentity['code'] {
  return error instanceof Error && error.message.startsWith('Lifecycle oracle safety violation:')
    ? 'LIFECYCLE_INVARIANT'
    : 'LIFECYCLE_DRIVER';
}

export class LifecycleScenarioRunner {
  constructor(readonly driver: LifecycleDriver) {}

  async run(spec: LifecycleScenarioSpec): Promise<LifecycleScenarioRunResult> {
    let model = emptyLifecycleModel();
    const history: LifecycleHistoryEntry[] = [];
    const requireQuiescence = spec.requireQuiescence ?? false;

    try {
      await this.driver.reset(spec.seed);
    } catch (error) {
      return {
        ok: false,
        artifact: createFailureArtifact({
          id: spec.id,
          seed: spec.seed,
          requireQuiescence,
          commands: spec.commands,
          history,
          observations: model.observations,
          failure: { commandIndex: -1, code: 'LIFECYCLE_DRIVER', message: errorMessage(error) },
        }),
      };
    }

    for (const [commandIndex, command] of spec.commands.entries()) {
      try {
        let step: LifecycleDriverStep = { observations: [] };
        switch (command.type) {
          case 'fault':
            await this.driver.configureFault(command.rule);
            break;
          case 'clear_faults':
            await this.driver.configureFault(undefined);
            break;
          case 'start':
            step = await this.driver.start(command.input);
            break;
          case 'resume':
            step = await this.driver.resume(command.operationId);
            break;
        }
        for (const observation of step.observations) {
          model = applyLifecycleObservation(model, observation);
          assertLifecycleSafety(model);
        }
        history.push({
          commandIndex,
          commandType: command.type,
          outcome: 'completed',
          observationCount: step.observations.length,
        });
      } catch (error) {
        history.push({
          commandIndex,
          commandType: command.type,
          outcome: 'failed',
          observationCount: 0,
        });
        return {
          ok: false,
          artifact: createFailureArtifact({
            id: spec.id,
            seed: spec.seed,
            requireQuiescence,
            commands: spec.commands,
            history,
            observations: model.observations,
            failure: {
              commandIndex,
              code: failureCode(error),
              message: errorMessage(error),
            },
          }),
        };
      }
    }

    if (requireQuiescence) {
      try {
        assertLifecycleQuiescence(model);
      } catch (error) {
        return {
          ok: false,
          artifact: createFailureArtifact({
            id: spec.id,
            seed: spec.seed,
            requireQuiescence,
            commands: spec.commands,
            history,
            observations: model.observations,
            failure: {
              commandIndex: spec.commands.length,
              code: 'LIFECYCLE_INVARIANT',
              message: errorMessage(error),
            },
          }),
        };
      }
    }

    return { ok: true, model, history: Object.freeze(structuredClone(history)) };
  }
}
