import {
  HttpLifecycleAdapterClient,
  type LifecycleAdapterClient,
  type LifecycleOperationInput,
  type LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import type { LifecycleObservation } from '@cashu-fault-lab/wallet-lifecycle-oracle';
import {
  LifecycleScenarioRunner,
  replayLifecycleFailure,
  type LifecycleDriver,
  type LifecycleDriverStep,
  type LifecycleFaultRule,
} from '@cashu-fault-lab/wallet-lifecycle-runner';
import type {
  LifecycleLabRuntime,
  LifecycleMatrixCliResult,
  LifecycleRunExecution,
  LifecycleRunOptions,
} from './commands/lifecycle.js';

export interface LifecycleFaultController {
  configure(rule: LifecycleFaultRule | undefined): Promise<void>;
}

export interface LifecycleRestartController {
  restart(component: 'adapter' | 'mint'): Promise<void>;
}

export interface LifecycleAdapterResolution {
  readonly client: LifecycleAdapterClient;
  readonly componentVersion: string;
}

export interface HttpLifecycleLabRuntimeOptions {
  readonly adapter: (adapterId: string) => Promise<LifecycleAdapterResolution>;
  readonly faultController: LifecycleFaultController;
  readonly restartController?: LifecycleRestartController;
  readonly matrix?: (input: {
    readonly profile: string;
    readonly seed: string;
  }) => Promise<readonly LifecycleMatrixCliResult[]>;
}

const terminalPhases = new Set(['succeeded', 'failed_definitive', 'recovery_blocked']);

function requestKind(kind: LifecycleOperationView['kind']): 'mint' | 'swap' | 'melt' | undefined {
  if (kind === 'mint') return 'mint';
  if (kind === 'melt') return 'melt';
  if (kind === 'swap' || kind === 'send' || kind === 'receive') return 'swap';
  return undefined;
}

function requestPath(kind: 'mint' | 'swap' | 'melt'): string {
  if (kind === 'mint') return '/v1/mint/bolt11';
  if (kind === 'melt') return '/v1/melt/bolt11';
  return '/v1/swap';
}

function phasePath(
  from: LifecycleOperationView['phase'],
  to: LifecycleOperationView['phase'],
): readonly LifecycleOperationView['phase'][] {
  if (from === to || terminalPhases.has(from)) return [];
  const forward: LifecycleOperationView['phase'][] = [];
  let current = from;
  const add = (phase: LifecycleOperationView['phase']): void => {
    forward.push(phase);
    current = phase;
  };
  if (current === 'created' && to !== 'created') add('prepared');
  if (current === 'prepared' && !['prepared', 'created'].includes(to)) add('submitted');
  if (
    current === 'submitted' &&
    (to === 'ambiguous' ||
      to === 'reconciling' ||
      to === 'failed_definitive' ||
      to === 'recovery_blocked')
  ) {
    add('ambiguous');
  }
  if (
    current === 'ambiguous' &&
    (to === 'reconciling' ||
      to === 'succeeded' ||
      to === 'failed_definitive' ||
      to === 'recovery_blocked')
  ) {
    add('reconciling');
  }
  if (current !== to) add(to);
  return forward;
}

class HttpLifecycleDriver implements LifecycleDriver {
  readonly #phases = new Map<string, LifecycleOperationView['phase']>();
  readonly #inputs = new Map<string, LifecycleOperationInput>();

  constructor(
    readonly client: LifecycleAdapterClient,
    readonly faults: LifecycleFaultController,
    readonly restarts: LifecycleRestartController | undefined,
  ) {}

  async reset(seed: string): Promise<void> {
    this.#phases.clear();
    this.#inputs.clear();
    await this.faults.configure(undefined);
    await this.client.reset(seed);
  }

  configureFault(rule: LifecycleFaultRule | undefined): Promise<void> {
    return this.faults.configure(rule);
  }

  async start(input: LifecycleOperationInput): Promise<LifecycleDriverStep> {
    this.#inputs.set(input.operationId, structuredClone(input));
    return { observations: this.#observations(input, await this.client.start(input)) };
  }

  async resume(operationId: string): Promise<LifecycleDriverStep> {
    const input = this.#inputs.get(operationId);
    if (input === undefined) throw new Error('Lifecycle resume input is unavailable');
    return { observations: this.#observations(input, await this.client.resume(operationId)) };
  }

  async restart(component: 'adapter' | 'mint'): Promise<LifecycleDriverStep> {
    if (this.restarts === undefined) throw new Error('Lifecycle restart controller is unavailable');
    await this.restarts.restart(component);
    return { observations: [] };
  }

  #observations(
    input: LifecycleOperationInput,
    view: LifecycleOperationView,
  ): readonly LifecycleObservation[] {
    if (
      view.operationId !== input.operationId ||
      view.kind !== input.kind ||
      view.mint !== input.mint ||
      view.unit !== input.unit
    ) {
      throw new Error('Lifecycle adapter changed operation identity');
    }
    const previous = this.#phases.get(view.operationId) ?? 'created';
    const observations: LifecycleObservation[] = [];
    if (!this.#phases.has(view.operationId)) {
      observations.push({
        type: 'operation_observed',
        operation: {
          operationId: view.operationId,
          kind: view.kind,
          mint: view.mint,
          unit: view.unit,
          intentHash: view.intentHash,
          phase: 'created',
        },
      });
    }
    for (const phase of phasePath(previous, view.phase)) {
      observations.push({
        type: 'phase_observed',
        operationId: view.operationId,
        phase,
        ...(phase === view.phase && view.evidenceCode !== undefined
          ? { evidenceCode: view.evidenceCode }
          : {}),
      });
    }
    const kind = requestKind(view.kind);
    if (kind !== undefined && view.requestHash !== undefined) {
      observations.push({
        type: 'request_dispatched',
        operationId: view.operationId,
        requestKind: kind,
        method: 'POST',
        path: requestPath(kind),
        bodyHash: view.requestHash,
      });
    }
    if (
      view.phase === 'succeeded' &&
      ['mint', 'swap', 'receive', 'restore'].includes(view.kind) &&
      view.outputPlanHash !== undefined &&
      view.amount !== undefined &&
      view.amount > 0
    ) {
      observations.push({
        type: 'outputs_persisted',
        operationId: view.operationId,
        outputPlanHash: view.outputPlanHash,
        amount: view.amount,
        unit: view.unit,
      });
    }
    this.#phases.set(view.operationId, view.phase);
    return observations;
  }
}

export class HttpLifecycleLabRuntime implements LifecycleLabRuntime {
  constructor(readonly options: HttpLifecycleLabRuntimeOptions) {}

  async run(input: LifecycleRunOptions): Promise<LifecycleRunExecution> {
    if (input.seed !== input.scenario.seed) {
      throw new Error('Lifecycle runtime seed does not match the scenario');
    }
    const adapter = await this.options.adapter(input.adapterId);
    const capabilities = await adapter.client.capabilities();
    const required = new Set(
      input.scenario.commands.flatMap((command) =>
        command.type === 'start' ? [command.input.kind] : [],
      ),
    );
    const missing = [...required].filter(
      (operation) => !capabilities.operations.includes(operation),
    );
    if (missing.length > 0) {
      throw new Error(`Lifecycle adapter does not support: ${missing.join(', ')}`);
    }
    const driver = new HttpLifecycleDriver(
      adapter.client,
      this.options.faultController,
      this.options.restartController,
    );
    return {
      result: await new LifecycleScenarioRunner(driver).run(input.scenario),
      componentVersions: { [input.adapterId]: adapter.componentVersion },
    };
  }

  matrix(input: {
    readonly profile: string;
    readonly seed: string;
  }): Promise<readonly LifecycleMatrixCliResult[]> {
    if (this.options.matrix === undefined) {
      return Promise.resolve([]);
    }
    return this.options.matrix(input);
  }

  async replay(input: Parameters<LifecycleLabRuntime['replay']>[0]) {
    const adapter = await this.options.adapter(input.adapterId);
    const driver = new HttpLifecycleDriver(
      adapter.client,
      this.options.faultController,
      this.options.restartController,
    );
    return replayLifecycleFailure(input.artifact, driver, input.seed);
  }
}

function environmentKey(adapterId: string, suffix: 'URL' | 'TOKEN'): string {
  const id = adapterId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_');
  return `CFL_LIFECYCLE_${id}_${suffix}`;
}

function requiredEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = env[key];
  if (value === undefined || value.length === 0 || /[\r\n]/u.test(value)) {
    throw new Error(`Lifecycle environment variable ${key} is missing or invalid`);
  }
  return value;
}

function gatewayOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Lifecycle fault gateway must be a loopback HTTP origin');
  }
  return url.origin;
}

class HttpLifecycleFaultController implements LifecycleFaultController {
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.#env = env;
  }

  async configure(rule: LifecycleFaultRule | undefined): Promise<void> {
    const origin = gatewayOrigin(requiredEnvironment(this.#env, 'CFL_HTTP_FAULT_GATEWAY_URL'));
    const token = requiredEnvironment(this.#env, 'CFL_HTTP_FAULT_GATEWAY_TOKEN');
    const url = `${origin}/__faults/v1/rules`;
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const signal = AbortSignal.timeout(5_000);
    const response =
      rule === undefined
        ? await fetch(url, { method: 'DELETE', headers, redirect: 'manual', signal })
        : await fetch(url, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            redirect: 'manual',
            signal,
            body: JSON.stringify(this.#gatewayRule(rule)),
          });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Lifecycle fault gateway rejected the control request');
    }
    await response.body?.cancel();
  }

  #gatewayRule(rule: LifecycleFaultRule): Readonly<Record<string, unknown>> {
    const common = {
      count: 1,
      occurrence: rule.occurrence,
      match: { endpointFamily: rule.endpoint },
    };
    switch (rule.action) {
      case 'drop_request':
        return { ...common, phase: 'before_forward', action: 'drop' };
      case 'drop_response':
        return { ...common, phase: 'after_downstream_response', action: 'drop' };
      case 'delay_request':
        return {
          ...common,
          phase: 'before_forward',
          action: 'delay',
          delayMs: rule.delayMs ?? 0,
        };
      case 'delay_response':
        return {
          ...common,
          phase: 'after_downstream_response',
          action: 'delay',
          delayMs: rule.delayMs ?? 0,
        };
      case 'duplicate_request':
        return { ...common, phase: 'before_forward', action: 'duplicate', duplicateCount: 1 };
      case 'reset_connection':
        return { ...common, phase: 'after_downstream_commit', action: 'drop' };
      case 'stale_response':
        return { ...common, phase: 'after_downstream_response', action: 'stale_response' };
      case 'truncate_response':
        return {
          ...common,
          phase: 'after_downstream_response',
          action: 'truncate',
          truncateBytes: rule.truncateBytes ?? 0,
        };
    }
  }
}

export function createEnvironmentLifecycleRuntime(
  env: Readonly<Record<string, string | undefined>>,
): HttpLifecycleLabRuntime {
  return new HttpLifecycleLabRuntime({
    adapter: async (adapterId) => {
      const url = requiredEnvironment(env, environmentKey(adapterId, 'URL'));
      const token = requiredEnvironment(env, environmentKey(adapterId, 'TOKEN'));
      const client = new HttpLifecycleAdapterClient({ baseUrl: url, token });
      const capabilities = await client.capabilities();
      return { client, componentVersion: capabilities.implementation.version };
    },
    faultController: new HttpLifecycleFaultController(env),
  });
}
