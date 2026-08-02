import {
  HttpLifecycleAdapterClient,
  LifecycleAdapterClientError,
  type LifecycleAdapterClient,
  type LifecycleCapabilities,
  type LifecycleOperationInput,
  type LifecycleOperationView,
  type LifecycleWalletView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { MintQuoteState, Wallet, getEncodedToken } from '@cashu/cashu-ts';
import type { LifecycleObservation } from '@cashu-fault-lab/wallet-lifecycle-oracle';
import {
  LifecycleScenarioRunner,
  replayLifecycleFailure,
  lifecycleSeedHash,
  validateLifecycleScenarioSpec,
  type LifecycleDriver,
  type LifecycleDriverStep,
  type LifecycleFaultRule,
  type LifecycleScenarioSpec,
} from '@cashu-fault-lab/wallet-lifecycle-runner';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  LifecycleLabRuntime,
  LifecycleMatrixCliResult,
  LifecycleMatrixEvidenceSummary,
  LifecycleRunExecution,
  LifecycleRunOptions,
} from './commands/lifecycle.js';
import { runtimeAssetPath } from './runtime-assets.js';

const execFileAsync = promisify(execFile);

export interface LifecycleFaultController {
  configure(rule: LifecycleFaultRule | undefined): Promise<void>;
}

export interface LifecycleRestartController {
  restart(component: 'adapter' | 'mint'): Promise<void>;
}

export interface LifecycleRestartControllerInput {
  readonly adapterId: string;
  readonly mintId: string;
  readonly seed: string;
}

export type LifecycleRestartControllerFactory = (
  input: LifecycleRestartControllerInput,
) => LifecycleRestartController;

export interface LifecycleAdapterResolution {
  readonly client: LifecycleAdapterClient;
  readonly componentVersion: string;
}

export interface HttpLifecycleLabRuntimeOptions {
  readonly adapter: (adapterId: string) => Promise<LifecycleAdapterResolution>;
  readonly faultController: LifecycleFaultController;
  readonly restartController?: LifecycleRestartControllerFactory;
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
  readonly #intentHashes = new Map<string, string>();
  readonly #quoteVersions = new Map<string, number>();
  readonly #evidenceKeys = new Set<string>();
  #wallet: LifecycleWalletView | undefined;
  #openingRecorded = false;

  constructor(
    readonly client: LifecycleAdapterClient,
    readonly faults: LifecycleFaultController,
    readonly restarts: LifecycleRestartController | undefined,
  ) {}

  async reset(seed: string): Promise<void> {
    this.#phases.clear();
    this.#inputs.clear();
    this.#intentHashes.clear();
    this.#quoteVersions.clear();
    this.#evidenceKeys.clear();
    this.#openingRecorded = false;
    await this.faults.configure(undefined);
    await this.client.reset(seed);
    this.#wallet = await this.client.wallet();
  }

  configureFault(rule: LifecycleFaultRule | undefined): Promise<void> {
    return this.faults.configure(rule);
  }

  async start(input: LifecycleOperationInput): Promise<LifecycleDriverStep> {
    this.#inputs.set(input.operationId, structuredClone(input));
    let view: LifecycleOperationView;
    try {
      view = await this.client.start(input);
    } catch {
      view = await this.client.operation(input.operationId);
    }
    return this.#step(input, view);
  }

  async resume(operationId: string): Promise<LifecycleDriverStep> {
    const input = this.#inputs.get(operationId);
    if (input === undefined) throw new Error('Lifecycle resume input is unavailable');
    let view: LifecycleOperationView;
    try {
      view = await this.client.resume(operationId);
    } catch {
      view = await this.client.operation(operationId);
    }
    return this.#step(input, view);
  }

  async restart(component: 'adapter' | 'mint'): Promise<LifecycleDriverStep> {
    if (this.restarts === undefined) throw new Error('Lifecycle restart controller is unavailable');
    await this.restarts.restart(component);
    return { observations: [] };
  }

  async #step(
    input: LifecycleOperationInput,
    view: LifecycleOperationView,
  ): Promise<LifecycleDriverStep> {
    const before = this.#wallet ?? (await this.client.wallet());
    const after = await this.client.wallet();
    const observations = [...this.#observations(input, view)];
    const opening = this.#openingObservations(view.operationId, before);
    if (opening.length > 0) observations.splice(1, 0, ...opening);
    observations.push(...this.#walletObservations(input, view, before, after));
    observations.push(...(await this.#evidenceObservations()));
    this.#wallet = structuredClone(after);
    return { observations };
  }

  #effectId(operationId: string, event: string): string {
    return `e${createHash('sha256')
      .update('cashu-fault-lab/lifecycle-effect/v1\0')
      .update(operationId)
      .update('\0')
      .update(event)
      .digest('hex')
      .slice(0, 48)}`;
  }

  #openingObservations(
    operationId: string,
    wallet: LifecycleWalletView,
  ): readonly LifecycleObservation[] {
    if (this.#openingRecorded) return [];
    this.#openingRecorded = true;
    return (['available', 'reserved', 'recoverable'] as const).flatMap((bucket) => {
      const amount = wallet.balances[bucket];
      return amount === 0
        ? []
        : [
            {
              type: 'value_moved' as const,
              operationId,
              effectId: this.#effectId(operationId, `opening-${bucket}`),
              unit: wallet.unit,
              amount,
              from: 'external:opening',
              to: `wallet:${wallet.walletId}:${bucket}`,
              provenance: 'adapter_claimed',
            },
          ];
    });
  }

  #walletObservations(
    input: LifecycleOperationInput,
    view: LifecycleOperationView,
    before: LifecycleWalletView,
    after: LifecycleWalletView,
  ): readonly LifecycleObservation[] {
    if (
      before.walletId !== after.walletId ||
      before.mint !== after.mint ||
      before.unit !== after.unit ||
      after.unit !== view.unit
    ) {
      throw new Error('Lifecycle wallet identity changed');
    }
    const observations: LifecycleObservation[] = after.proofs.map((proof) => ({
      type: 'proof_state_observed',
      operationId: view.operationId,
      proofId: proof.proofId,
      owner: `wallet:${after.walletId}`,
      state: proof.state,
      provenance: 'adapter_claimed',
    }));

    if (view.kind === 'mint' && view.quoteHash !== undefined && view.amount !== undefined) {
      const previous = this.#quoteVersions.get(view.quoteHash) ?? 0;
      const updatedAt = previous + 1;
      this.#quoteVersions.set(view.quoteHash, updatedAt);
      const succeeded = view.phase === 'succeeded';
      observations.push({
        type: 'mint_quote_observed',
        operationId: view.operationId,
        quoteHash: view.quoteHash,
        amountPaid: succeeded ? view.amount : 0,
        amountIssued: succeeded ? view.amount : 0,
        updatedAt,
        provenance: 'adapter_claimed',
      });
    }

    if (view.phase !== 'succeeded') return observations;
    const beforeTotal =
      before.balances.available + before.balances.reserved + before.balances.recoverable;
    const afterTotal =
      after.balances.available + after.balances.reserved + after.balances.recoverable;
    const delta = afterTotal - beforeTotal;
    if (delta > 0) {
      observations.push({
        type: 'value_moved',
        operationId: view.operationId,
        effectId: this.#effectId(view.operationId, 'wallet-credit'),
        unit: view.unit,
        amount: delta,
        from: 'external:fixture',
        to: `wallet:${after.walletId}:available`,
        provenance: 'adapter_claimed',
      });
    } else if (delta < 0) {
      const destination =
        view.kind === 'send'
          ? `transfer:${view.operationId.slice(0, 16).toLowerCase()}`
          : view.kind === 'melt'
            ? `lightning:${view.operationId.slice(0, 16).toLowerCase()}`
            : `fee:mint:${view.operationId.slice(0, 16).toLowerCase()}`;
      observations.push({
        type: 'value_moved',
        operationId: view.operationId,
        effectId: this.#effectId(view.operationId, 'wallet-debit'),
        unit: view.unit,
        amount: -delta,
        from: `wallet:${after.walletId}:available`,
        to: destination,
        provenance: 'adapter_claimed',
      });
    } else if (view.kind === 'swap' && view.amount !== undefined) {
      observations.push(
        {
          type: 'value_moved',
          operationId: view.operationId,
          effectId: this.#effectId(view.operationId, 'swap-reserve'),
          unit: view.unit,
          amount: view.amount,
          from: `wallet:${after.walletId}:available`,
          to: `wallet:${after.walletId}:reserved`,
          provenance: 'adapter_claimed',
        },
        {
          type: 'value_moved',
          operationId: view.operationId,
          effectId: this.#effectId(view.operationId, 'swap-release'),
          unit: view.unit,
          amount: view.amount,
          from: `wallet:${after.walletId}:reserved`,
          to: `wallet:${after.walletId}:available`,
          provenance: 'adapter_claimed',
        },
      );
    }
    return observations;
  }

  async #evidenceObservations(): Promise<readonly LifecycleObservation[]> {
    const evidence = await this.client.evidence();
    const observations: LifecycleObservation[] = [];
    for (const item of evidence) {
      const key = `${item.sequence}\0${item.operationId}\0${item.source}\0${item.event}\0${item.dataHash}`;
      if (this.#evidenceKeys.has(key)) continue;
      this.#evidenceKeys.add(key);
      if (!this.#inputs.has(item.operationId)) continue;
      if (
        item.source === 'lightning' &&
        (item.event === 'settlement_verified' ||
          item.event === 'melt_settlement_verified' ||
          item.event === 'melt_settlement_verified_legacy')
      ) {
        observations.push({
          type: 'lightning_settlement_observed',
          operationId: item.operationId,
          evidenceHash: item.dataHash,
          provenance: 'lightning',
        });
      }
    }
    return observations;
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
    const firstIntentHash = this.#intentHashes.get(view.operationId);
    if (firstIntentHash !== undefined && view.intentHash !== firstIntentHash) {
      throw new Error('Lifecycle adapter changed operation identity');
    }
    this.#intentHashes.set(view.operationId, view.intentHash);
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
        provenance: 'adapter_claimed',
      });
    }
    for (const phase of phasePath(previous, view.phase)) {
      const acceptsEvidenceCode =
        phase === view.phase &&
        (phase === 'failed_definitive' || phase === 'recovery_blocked') &&
        view.evidenceCode !== undefined;
      observations.push({
        type: 'phase_observed',
        operationId: view.operationId,
        phase,
        ...(acceptsEvidenceCode ? { evidenceCode: view.evidenceCode } : {}),
        provenance: 'adapter_claimed',
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
        provenance: 'adapter_claimed',
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
        provenance: 'adapter_claimed',
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
      this.options.restartController?.({
        adapterId: input.adapterId,
        mintId: input.mintId,
        seed: input.seed,
      }),
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
      this.options.restartController?.({
        adapterId: input.adapterId,
        mintId: input.mintId,
        seed: input.seed,
      }),
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

const SERVICE_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

interface EnvironmentLifecycleMatrixLane {
  readonly id: string;
  readonly adapterId: 'cashu-ts' | 'cdk';
  readonly mintId: 'nutshell' | 'mintd';
}

const ENVIRONMENT_LIFECYCLE_MATRIX_LANES: readonly EnvironmentLifecycleMatrixLane[] = [
  { id: 'cashu-ts-nutshell', adapterId: 'cashu-ts', mintId: 'nutshell' },
  { id: 'cashu-ts-mintd', adapterId: 'cashu-ts', mintId: 'mintd' },
  { id: 'cdk-nutshell', adapterId: 'cdk', mintId: 'nutshell' },
  { id: 'cdk-mintd', adapterId: 'cdk', mintId: 'mintd' },
] as const;

const LIFECYCLE_MATRIX_SCENARIOS = [
  'mint-response-lost',
  'swap-response-lost',
  'melt-pending-restart',
  'melt-paid-response-lost',
  'receive-crash-before-save',
  'restore-duplicate',
  'concurrent-resume',
  'stale-quote',
  'security-quote-redaction',
] as const;

function laneEnvironmentKey(lane: EnvironmentLifecycleMatrixLane, suffix: 'URL'): string {
  return `CFL_LIFECYCLE_${lane.adapterId.toUpperCase().replaceAll('-', '_')}_${lane.mintId.toUpperCase()}_${suffix}`;
}

function laneConfigurationMissing(
  env: Readonly<Record<string, string | undefined>>,
  lane: EnvironmentLifecycleMatrixLane,
): boolean {
  const url = env[laneEnvironmentKey(lane, 'URL')];
  const token = env[environmentKey(lane.adapterId, 'TOKEN')];
  const gatewayUrl = env[`CFL_LIFECYCLE_${lane.mintId.toUpperCase()}_GATEWAY_URL`];
  const gatewayToken = env.CFL_HTTP_FAULT_GATEWAY_TOKEN;
  const mintUrl = env[`CFL_LIFECYCLE_${lane.mintId.toUpperCase()}_MINT_URL`];
  const publicMintUrl = env[`CFL_LIFECYCLE_${lane.mintId.toUpperCase()}_PUBLIC_MINT_URL`];
  return [url, token, gatewayUrl, gatewayToken, mintUrl, publicMintUrl].some(
    (value) => value === undefined || value.length === 0 || /[\r\n]/u.test(value),
  );
}

async function lifecycleMatrixScenario(
  id: (typeof LIFECYCLE_MATRIX_SCENARIOS)[number],
  seed: string,
  mint: string,
  lane: EnvironmentLifecycleMatrixLane,
  publicMint: string,
): Promise<LifecycleScenarioSpec> {
  const scenarioSeed = lifecycleMatrixScenarioSeed(seed, lane.id, id);
  const path = runtimeAssetPath('scenarios', 'wallet-lifecycle', `${id}.json`);
  const raw = await readFile(path, { encoding: 'utf8' });
  if (Buffer.byteLength(raw, 'utf8') > 512 * 1_024) {
    throw new Error('Lifecycle matrix scenario exceeds the size limit');
  }
  const value = JSON.parse(raw) as unknown;
  const validation = validateLifecycleScenarioSpec(value);
  if (!validation.ok) throw new Error('Lifecycle matrix scenario is invalid');
  const scenario = value as LifecycleScenarioSpec;
  let commands = scenario.commands.map((command) =>
    command.type === 'start'
      ? { ...command, input: { ...command.input, mint } as LifecycleOperationInput }
      : command,
  );
  if (id === 'receive-crash-before-save') {
    const token = await lifecycleReceiveFixture(lane, scenarioSeed, publicMint, mint, 16);
    commands = commands.map((command) =>
      command.type === 'start' && command.input.kind === 'receive'
        ? { ...command, input: { ...command.input, token } }
        : command,
    );
  }
  if (['swap-response-lost', 'concurrent-resume'].includes(id)) {
    const fundingOperationId = deterministicOperationId(scenarioSeed, lane.id, `${id}-funding`);
    const fundingToken = await lifecycleReceiveFixture(lane, scenarioSeed, publicMint, mint, 256);
    commands = [
      ...lifecycleMatrixFundingCommands(fundingOperationId, mint, fundingToken),
      ...commands,
    ];
  }
  return {
    ...scenario,
    seed: scenarioSeed,
    commands,
  };
}

export function lifecycleMatrixScenarioSeed(
  seed: string,
  laneId: string,
  scenarioId: string,
): string {
  return `matrix-v1:${createHash('sha256')
    .update('cashu-fault-lab/lifecycle-matrix-scenario-seed/v1\0')
    .update(seed)
    .update('\0')
    .update(laneId)
    .update('\0')
    .update(scenarioId)
    .digest('base64url')}`;
}

export function lifecycleMatrixRestoreSetupScenario(
  seed: string,
  laneId: string,
  mint: string,
): LifecycleScenarioSpec {
  const operationId = deterministicOperationId(seed, laneId, 'restore-duplicate-setup');
  return {
    id: 'restore-duplicate-setup',
    seed,
    requireQuiescence: true,
    commands: [
      {
        type: 'start',
        input: {
          operationId,
          kind: 'mint',
          mint,
          unit: 'sat',
          amount: 64,
          method: 'bolt11',
        },
      },
      { type: 'resume', operationId },
    ],
  };
}

export function lifecycleMatrixFundingCommands(
  operationId: string,
  mint: string,
  token: string,
): LifecycleScenarioSpec['commands'] {
  return [
    {
      type: 'start',
      input: { operationId, kind: 'receive', mint, unit: 'sat', token },
    },
    { type: 'resume', operationId },
  ];
}

function deterministicOperationId(seed: string, lane: string, purpose: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/lifecycle-matrix-operation/v1\0')
    .update(seed)
    .update('\0')
    .update(lane)
    .update('\0')
    .update(purpose)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

async function lifecycleReceiveFixture(
  lane: EnvironmentLifecycleMatrixLane,
  seed: string,
  publicMint: string,
  lifecycleMint: string,
  amount: number,
): Promise<string> {
  gatewayOrigin(publicMint);
  const walletSeed = createHash('sha512')
    .update('cashu-fault-lab/lifecycle-matrix-receive/v1\0')
    .update(seed)
    .update('\0')
    .update(lane.id)
    .digest();
  const wallet = new Wallet(publicMint, { unit: 'sat', bip39seed: walletSeed });
  await wallet.loadMint();
  let quote = await wallet.createMintQuoteBolt11(amount, 'cashu-fault-lab lifecycle fixture');
  for (let attempt = 0; quote.state !== MintQuoteState.PAID && attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    quote = await wallet.checkMintQuoteBolt11(quote);
  }
  if (quote.state !== MintQuoteState.PAID) {
    throw new Error('Lifecycle receive fixture funding did not converge');
  }
  const proofs = await wallet.mintProofsBolt11(amount, quote, undefined, { type: 'random' });
  return getEncodedToken({ mint: lifecycleMint, unit: 'sat', proofs });
}

function matrixFailure(
  lane: EnvironmentLifecycleMatrixLane,
  code: string,
  reason: string,
): LifecycleMatrixCliResult {
  return {
    id: lane.id,
    implementationId: lane.adapterId,
    mintId: lane.mintId,
    status: 'failed',
    code,
    reason,
  };
}

function observedIntentHashes(
  observations: readonly LifecycleObservation[],
): ReadonlyMap<string, string> {
  return new Map(
    observations.flatMap((observation) =>
      observation.type === 'operation_observed'
        ? [[observation.operation.operationId, observation.operation.intentHash] as const]
        : [],
    ),
  );
}

export function lifecycleMatrixEvidenceSummary(
  observations: readonly LifecycleObservation[],
): LifecycleMatrixEvidenceSummary {
  const provenances = [
    ...new Set(observations.map((observation) => observation.provenance ?? 'runner_derived')),
  ];
  return {
    confidence: provenances.includes('adapter_claimed')
      ? 'adapter_claimed'
      : provenances.some((provenance) => provenance === 'runner_derived')
        ? 'derived'
        : 'observed',
    observationCount: observations.length,
    provenances,
  };
}

function lifecycleMatrixInitializationRetryable(error: unknown): boolean {
  if (!(error instanceof LifecycleAdapterClientError)) return false;
  return error.code !== 'LIFECYCLE_ADAPTER_UNAVAILABLE';
}

export async function initializeLifecycleMatrixLane(
  client: LifecycleAdapterClient,
  faults: LifecycleFaultController,
  seed: string,
): Promise<LifecycleCapabilities> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await faults.configure(undefined);
      await client.reset(seed);
      return await client.capabilities();
    } catch (error) {
      lastError = error;
      if (attempt === 7 || !lifecycleMatrixInitializationRetryable(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function verifyLifecycleScenarioSuccess(
  client: LifecycleAdapterClient,
  scenario: LifecycleScenarioSpec,
  expectedIntentHashes: ReadonlyMap<string, string> = new Map(),
): Promise<
  { readonly operationId: string; readonly phase: LifecycleOperationView['phase'] } | undefined
> {
  const inputs = new Map(
    scenario.commands.flatMap((command) =>
      command.type === 'start' ? [[command.input.operationId, command.input] as const] : [],
    ),
  );
  for (const [operationId, input] of inputs) {
    const operation = await client.operation(operationId);
    if (
      operation.operationId !== input.operationId ||
      operation.kind !== input.kind ||
      operation.mint !== input.mint ||
      operation.unit !== input.unit ||
      (expectedIntentHashes.has(operationId) &&
        operation.intentHash !== expectedIntentHashes.get(operationId))
    ) {
      throw new Error('Lifecycle operation identity changed during terminal verification');
    }
    if (operation.phase !== 'succeeded') return { operationId, phase: operation.phase };
  }
  return undefined;
}

async function executeEnvironmentLifecycleLane(
  env: Readonly<Record<string, string | undefined>>,
  lane: EnvironmentLifecycleMatrixLane,
  seed: string,
): Promise<readonly LifecycleMatrixCliResult[]> {
  const adapterUrl = requiredEnvironment(env, laneEnvironmentKey(lane, 'URL'));
  const adapterToken = requiredEnvironment(env, environmentKey(lane.adapterId, 'TOKEN'));
  const gatewayUrlKey = `CFL_LIFECYCLE_${lane.mintId.toUpperCase()}_GATEWAY_URL`;
  const mintUrlKey = `CFL_LIFECYCLE_${lane.mintId.toUpperCase()}_MINT_URL`;
  const publicMintUrlKey = `CFL_LIFECYCLE_${lane.mintId.toUpperCase()}_PUBLIC_MINT_URL`;
  const gatewayUrl = requiredEnvironment(env, gatewayUrlKey);
  const mintUrl = requiredEnvironment(env, mintUrlKey);
  const publicMintUrl = requiredEnvironment(env, publicMintUrlKey);
  const client = new HttpLifecycleAdapterClient({
    baseUrl: adapterUrl,
    token: adapterToken,
    timeoutMs: 15_000,
  });
  const faultController = new HttpLifecycleFaultController({
    ...env,
    CFL_HTTP_FAULT_GATEWAY_URL: gatewayUrl,
  });
  let capabilities;
  try {
    capabilities = await initializeLifecycleMatrixLane(client, faultController, seed);
  } catch {
    return [
      matrixFailure(
        lane,
        'LIFECYCLE_MATRIX_EXECUTION',
        `Lifecycle matrix lane ${lane.id} capability discovery failed`,
      ),
    ];
  }
  if (capabilities.implementation.id !== lane.adapterId) {
    return [
      matrixFailure(
        lane,
        'LIFECYCLE_IDENTITY_MISMATCH',
        `Lifecycle matrix lane ${lane.id} returned a different implementation identity`,
      ),
    ];
  }

  const laneRuntime = new HttpLifecycleLabRuntime({
    adapter: async () => ({ client, componentVersion: capabilities.implementation.version }),
    faultController,
    restartController: (input) => new DockerComposeLifecycleRestartController(env, input),
  });
  const results: LifecycleMatrixCliResult[] = [];
  for (const scenarioId of LIFECYCLE_MATRIX_SCENARIOS) {
    let scenario: LifecycleScenarioSpec;
    try {
      scenario = await lifecycleMatrixScenario(scenarioId, seed, mintUrl, lane, publicMintUrl);
    } catch {
      return [
        matrixFailure(
          lane,
          'LIFECYCLE_SCENARIO_INVALID',
          `Lifecycle matrix lane ${lane.id} could not load the checked-in scenario corpus`,
        ),
      ];
    }
    const required = [
      ...new Set(
        scenario.commands.flatMap((command) =>
          command.type === 'start' ? [command.input.kind] : [],
        ),
      ),
    ];
    if (scenarioId === 'restore-duplicate' && !required.includes('mint')) required.push('mint');
    const missing = required.filter((operation) => !capabilities.operations.includes(operation));
    const resultId = `${lane.id}.${scenarioId}`;
    if (missing.length > 0) {
      results.push({
        id: resultId,
        implementationId: lane.adapterId,
        mintId: lane.mintId,
        scenarioId,
        seedHash: lifecycleSeedHash(scenario.seed),
        componentVersion: capabilities.implementation.version,
        status: 'not_applicable',
        reason: `Missing lifecycle operations: ${missing.join(', ')}`,
      });
      continue;
    }
    if (scenarioId === 'restore-duplicate') {
      const setup = lifecycleMatrixRestoreSetupScenario(scenario.seed, lane.id, mintUrl);
      const setupExecution = await laneRuntime.run({
        scenario: setup,
        seed: setup.seed,
        adapterId: lane.adapterId,
        mintId: lane.mintId,
        mintUrl,
      });
      const setupCommand = setup.commands[0];
      if (setupCommand?.type !== 'start') throw new Error('Lifecycle restore setup is invalid');
      const setupOperation = await client.operation(setupCommand.input.operationId);
      if (!setupExecution.result.ok || setupOperation.phase !== 'succeeded') {
        results.push({
          id: resultId,
          implementationId: lane.adapterId,
          mintId: lane.mintId,
          scenarioId,
          seedHash: lifecycleSeedHash(scenario.seed),
          componentVersion: capabilities.implementation.version,
          status: 'failed',
          code: setupExecution.result.ok
            ? 'LIFECYCLE_RESTORE_SETUP'
            : setupExecution.result.artifact.failure.code,
          reason: `Lifecycle matrix restore setup failed on ${lane.id}`,
        });
        continue;
      }
    }
    const execution = await laneRuntime.run({
      scenario,
      seed: scenario.seed,
      adapterId: lane.adapterId,
      mintId: lane.mintId,
      mintUrl,
    });
    if (!execution.result.ok) {
      results.push({
        id: resultId,
        implementationId: lane.adapterId,
        mintId: lane.mintId,
        scenarioId,
        seedHash: lifecycleSeedHash(scenario.seed),
        componentVersion: capabilities.implementation.version,
        status: 'failed',
        code: execution.result.artifact.failure.code,
        reason: `Lifecycle matrix scenario ${scenarioId} failed; use lifecycle run for replay evidence`,
      });
      continue;
    }
    let terminalFailure;
    try {
      terminalFailure = await verifyLifecycleScenarioSuccess(
        client,
        scenario,
        observedIntentHashes(execution.result.model.observations),
      );
    } catch {
      results.push({
        id: resultId,
        implementationId: lane.adapterId,
        mintId: lane.mintId,
        scenarioId,
        seedHash: lifecycleSeedHash(scenario.seed),
        componentVersion: capabilities.implementation.version,
        status: 'failed',
        code: 'LIFECYCLE_OPERATION_EVIDENCE',
        reason: `Lifecycle matrix scenario ${scenarioId} could not verify terminal operation evidence`,
      });
      continue;
    }
    if (terminalFailure !== undefined) {
      results.push({
        id: resultId,
        implementationId: lane.adapterId,
        mintId: lane.mintId,
        scenarioId,
        seedHash: lifecycleSeedHash(scenario.seed),
        componentVersion: capabilities.implementation.version,
        status: 'failed',
        code: 'LIFECYCLE_UNEXPECTED_TERMINAL_PHASE',
        reason: `Lifecycle matrix scenario ${scenarioId} did not recover successfully`,
      });
      continue;
    }
    results.push({
      id: resultId,
      implementationId: lane.adapterId,
      mintId: lane.mintId,
      scenarioId,
      seedHash: lifecycleSeedHash(scenario.seed),
      componentVersion: capabilities.implementation.version,
      evidence: lifecycleMatrixEvidenceSummary(execution.result.model.observations),
      status: 'passed',
    });
  }
  return results;
}

async function environmentLifecycleMatrix(
  env: Readonly<Record<string, string | undefined>>,
  input: { readonly profile: string; readonly seed: string },
): Promise<readonly LifecycleMatrixCliResult[]> {
  if (input.profile !== 'wallet-lifecycle-v1') {
    throw new Error('Lifecycle matrix profile is unsupported');
  }
  const results: LifecycleMatrixCliResult[] = [];
  for (const lane of ENVIRONMENT_LIFECYCLE_MATRIX_LANES) {
    if (laneConfigurationMissing(env, lane)) {
      results.push(
        matrixFailure(
          lane,
          'LIFECYCLE_CONFIGURATION_MISSING',
          `Lifecycle matrix lane ${lane.id} is missing endpoint or control-token configuration`,
        ),
      );
      continue;
    }
    results.push(...(await executeEnvironmentLifecycleLane(env, lane, input.seed)));
  }
  return results;
}

function mintFamily(mintId: string): 'nutshell' | 'mintd' {
  if (!SERVICE_ID.test(mintId)) throw new Error('Lifecycle mint identity is invalid');
  if (mintId.includes('nutshell')) return 'nutshell';
  if (mintId.includes('mintd')) return 'mintd';
  throw new Error(`Lifecycle mint service is unknown: ${mintId}`);
}

function mintService(mintId: string): string {
  if (mintId.includes('regtest')) return 'nutshell-regtest';
  return mintFamily(mintId);
}

function adapterService(adapterId: string, mintId: string): string {
  if (!SERVICE_ID.test(adapterId)) throw new Error('Lifecycle adapter identity is invalid');
  if (mintId.includes('regtest')) {
    if (adapterId !== 'cashu-ts' && adapterId !== 'cdk') {
      throw new Error(`Lifecycle regtest adapter service is unknown: ${adapterId}`);
    }
    return `${adapterId}-regtest`;
  }
  if (adapterId !== 'cashu-ts' && adapterId !== 'cdk') {
    throw new Error(`Lifecycle adapter service is unknown: ${adapterId}`);
  }
  return `${adapterId}-${mintFamily(mintId)}`;
}

function lifecycleComposeFile(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.CFL_LIFECYCLE_COMPOSE_FILE;
  if (configured !== undefined && configured.length > 0 && !/[\r\n]/u.test(configured)) {
    return configured;
  }
  return env.CFL_WALLET_LIFECYCLE_REGTEST === '1'
    ? 'infra/compose/lightning-regtest.compose.yml'
    : 'infra/compose/wallet-lifecycle.compose.yml';
}

class DockerComposeLifecycleRestartController implements LifecycleRestartController {
  constructor(
    readonly env: Readonly<Record<string, string | undefined>>,
    readonly lane: LifecycleRestartControllerInput,
  ) {}

  async restart(component: 'adapter' | 'mint'): Promise<void> {
    const service =
      component === 'mint'
        ? mintService(this.lane.mintId)
        : adapterService(this.lane.adapterId, this.lane.mintId);
    const docker = this.env.CFL_DOCKER_BIN ?? 'docker';
    const composeFile = lifecycleComposeFile(this.env);
    const environment = {
      ...process.env,
      ...this.env,
      CFL_LIFECYCLE_CDK_SEED: this.lane.seed,
    };
    if (component === 'adapter' && this.lane.adapterId === 'cdk') {
      await execFileAsync(
        docker,
        ['compose', '-f', composeFile, 'up', '-d', '--force-recreate', '--wait', service],
        { env: environment, timeout: 120_000 },
      );
      return;
    }
    await execFileAsync(docker, ['compose', '-f', composeFile, 'restart', service], {
      env: environment,
      timeout: 120_000,
    });
    await execFileAsync(docker, ['compose', '-f', composeFile, 'up', '-d', '--wait', service], {
      env: environment,
      timeout: 120_000,
    });
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
    restartController: (input) => new DockerComposeLifecycleRestartController(env, input),
    matrix: (input) => environmentLifecycleMatrix(env, input),
  });
}
