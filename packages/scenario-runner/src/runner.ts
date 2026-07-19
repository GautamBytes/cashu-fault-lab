import {
  applyObservation,
  assertQuiescentLiveness,
  assertSafety,
  emptyOracleModel,
  type Observation,
  type OracleModel,
} from '@cashu-fault-lab/oracle';
import { containsSensitiveData, HistoryRecorder, redact, type HistoryEvent } from './history.js';
import { assertReplayableArtifact, minimizeFailingCommands } from './replay.js';
import { VirtualScheduler } from './scheduler.js';

export interface FaultRule {
  readonly kind: string;
  readonly occurrence?: number;
  readonly delayMs?: number;
  readonly duplicateCount?: number;
  readonly statusCode?: number;
}

export type ScenarioCommand =
  | {
      readonly type: 'configure_fault';
      readonly target: 'http' | 'nostr' | 'receiver' | 'mint';
      readonly rule: FaultRule;
    }
  | { readonly type: 'send'; readonly sender: string; readonly requestId: string }
  | { readonly type: 'restart'; readonly component: string }
  | { readonly type: 'advance_time'; readonly milliseconds: number }
  | { readonly type: 'clear_faults'; readonly target?: string }
  | { readonly type: 'assert_quiescent' };

export interface ScenarioSpec {
  readonly name: string;
  readonly commands: readonly ScenarioCommand[];
}

export interface DriverSendResult {
  readonly value: unknown;
  readonly observations: readonly Observation[];
}

export interface ScenarioDriver {
  reset(seed: string): Promise<void>;
  capabilities(): Promise<Readonly<Record<string, unknown>>>;
  configureFault(target: string, rule: FaultRule): Promise<void>;
  send(sender: string, requestId: string): Promise<DriverSendResult>;
  restart(component: string): Promise<void>;
  clearFaults(target?: string): Promise<void>;
}

export interface FailureArtifact {
  readonly schemaVersion: 1;
  readonly seed: string;
  readonly scenario: string;
  readonly commands: readonly ScenarioCommand[];
  readonly history: readonly HistoryEvent[];
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface ScenarioError {
  readonly name: string;
  readonly message: string;
}

function sameFailure(left: ScenarioError, right: ScenarioRunResult): boolean {
  return (
    right.status === 'failed' &&
    right.error.name === left.name &&
    right.error.message === left.message
  );
}

export type ScenarioRunResult =
  | { readonly status: 'passed'; readonly artifact: FailureArtifact }
  | {
      readonly status: 'failed';
      readonly artifact: FailureArtifact;
      readonly error: ScenarioError;
    };

function errorView(error: unknown): ScenarioError {
  if (error instanceof Error) {
    return { name: error.name, message: String(redact(error.message)) };
  }
  return { name: 'Error', message: String(redact(error)) };
}

function capabilitiesView(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const sanitized = redact(value);
  if (typeof sanitized !== 'object' || sanitized === null || Array.isArray(sanitized)) return {};
  return sanitized as Readonly<Record<string, unknown>>;
}

export class ScenarioRunner {
  readonly #driver: ScenarioDriver;

  constructor(driver: ScenarioDriver) {
    this.#driver = driver;
  }

  async run(spec: ScenarioSpec, seed: string): Promise<ScenarioRunResult> {
    if (typeof spec.name !== 'string' || spec.name.length === 0)
      throw new Error('Scenario needs a name');
    if (!Array.isArray(spec.commands)) throw new Error('Scenario commands must be an array');
    if (typeof seed !== 'string' || seed.length === 0) throw new Error('Scenario seed is required');
    if (containsSensitiveData(spec.commands)) {
      throw new Error('Scenario commands must not contain sensitive payment material');
    }

    const scheduler = new VirtualScheduler();
    const history = new HistoryRecorder(() => scheduler.now);
    let oracle = emptyOracleModel();
    let capabilities: Readonly<Record<string, unknown>> = {};
    let failure: ScenarioError | undefined;

    try {
      await this.#driver.reset(seed);
      capabilities = capabilitiesView(await this.#driver.capabilities());
    } catch (error) {
      failure = errorView(error);
    }

    if (!failure) {
      for (const [commandIndex, command] of spec.commands.entries()) {
        history.record({
          phase: 'invoked',
          actor: this.#actor(command),
          event: command.type,
          commandIndex,
          data: command,
        });
        try {
          const completion = await this.#execute(command, scheduler, history, commandIndex, oracle);
          oracle = completion.oracle;
          assertSafety(oracle);
          history.record({
            phase: 'completed',
            actor: this.#actor(command),
            event: command.type,
            commandIndex,
            outcome: 'passed',
            data: completion.value,
          });
        } catch (error) {
          failure = errorView(error);
          history.record({
            phase: 'completed',
            actor: this.#actor(command),
            event: command.type,
            commandIndex,
            outcome: 'failed',
            data: failure,
          });
          break;
        }
      }
    }

    if (!failure) {
      try {
        assertSafety(oracle);
      } catch (error) {
        failure = errorView(error);
      }
    }

    const artifact: FailureArtifact = {
      schemaVersion: 1,
      seed,
      scenario: spec.name,
      commands: structuredClone(spec.commands),
      history: history.snapshot(),
      capabilities,
    };
    return failure
      ? { status: 'failed', artifact, error: failure }
      : { status: 'passed', artifact };
  }

  async replay(artifact: FailureArtifact): Promise<ScenarioRunResult> {
    assertReplayableArtifact(artifact);
    return this.run({ name: artifact.scenario, commands: artifact.commands }, artifact.seed);
  }

  async shrink(artifact: FailureArtifact, runLimit = 100): Promise<FailureArtifact> {
    assertReplayableArtifact(artifact);
    const baseline = await this.replay(artifact);
    if (baseline.status !== 'failed') {
      throw new Error('Artifact does not reproduce a failure and cannot be minimized');
    }
    const commands = await minimizeFailingCommands(
      artifact.commands,
      async (candidate) => {
        const result = await this.run(
          { name: artifact.scenario, commands: candidate },
          artifact.seed,
        );
        return sameFailure(baseline.error, result);
      },
      runLimit,
    );
    const result = await this.run({ name: artifact.scenario, commands }, artifact.seed);
    if (!sameFailure(baseline.error, result)) {
      throw new Error('Minimized trace did not preserve the original failure');
    }
    return result.artifact;
  }

  async #execute(
    command: ScenarioCommand,
    scheduler: VirtualScheduler,
    history: HistoryRecorder,
    commandIndex: number,
    oracle: OracleModel,
  ): Promise<{ readonly oracle: OracleModel; readonly value: unknown }> {
    switch (command.type) {
      case 'configure_fault':
        await this.#driver.configureFault(command.target, command.rule);
        return { oracle, value: { configured: true } };
      case 'send': {
        const result = await this.#driver.send(command.sender, command.requestId);
        let nextOracle = oracle;
        for (const observation of result.observations) {
          history.record({
            phase: 'observation',
            actor: 'oracle',
            event: observation.type,
            commandIndex,
            data: observation,
          });
          nextOracle = applyObservation(nextOracle, observation);
        }
        return { oracle: nextOracle, value: result.value };
      }
      case 'restart':
        await this.#driver.restart(command.component);
        return { oracle, value: { restarted: command.component } };
      case 'advance_time':
        scheduler.advanceBy(command.milliseconds);
        return { oracle, value: { now: scheduler.now } };
      case 'clear_faults':
        await this.#driver.clearFaults(command.target);
        return { oracle, value: { cleared: command.target ?? 'all' } };
      case 'assert_quiescent':
        assertQuiescentLiveness(oracle);
        return { oracle, value: { quiescent: true } };
    }
  }

  #actor(command: ScenarioCommand): string {
    if (command.type === 'send') return command.sender;
    if (command.type === 'restart') return command.component;
    if (command.type === 'configure_fault') return command.target;
    return 'runner';
  }
}
