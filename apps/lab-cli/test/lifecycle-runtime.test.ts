import type {
  LifecycleAdapterClient,
  LifecycleCapabilities,
  LifecycleEvidenceView,
  LifecycleOperationInput,
  LifecycleOperationView,
  LifecycleWalletView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { LifecycleAdapterClientError } from '@cashu-fault-lab/wallet-lifecycle-contract';
import { describe, expect, it } from 'vitest';
import {
  createEnvironmentLifecycleRuntime,
  HttpLifecycleLabRuntime,
  initializeLifecycleMatrixLane,
  lifecycleComposeServiceRestartPlan,
  lifecycleComposeServicesRecreatePlan,
  lifecycleComposeServicesRestartPlan,
  lifecycleMatrixEvidenceSummary,
  lifecycleMatrixRestoreSetupScenario,
  lifecycleMatrixScenarioSeed,
  lifecycleMatrixFundingCommands,
  lifecycleMatrixNeedsCdkHostRehydration,
  verifyLifecycleScenarioSuccess,
  waitForLifecycleMatrixAdapter,
} from '../src/lifecycle-runtime.js';
import type {
  LifecycleFaultRule,
  LifecycleScenarioSpec,
} from '@cashu-fault-lab/wallet-lifecycle-runner';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const mint = 'http://127.0.0.1:3338';
const requestHash = 'b'.repeat(64);
const outputPlanHash = 'c'.repeat(64);
const quoteHash = 'd'.repeat(64);

class FakeClient implements LifecycleAdapterClient {
  input: LifecycleOperationInput | undefined;
  succeeded = false;
  intentHash = 'a'.repeat(64);
  evidenceLog: readonly LifecycleEvidenceView[] = [];
  readonly events: string[] = [];

  async capabilities(): Promise<LifecycleCapabilities> {
    this.events.push('capabilities');
    return {
      schemaVersion: 1,
      implementation: {
        id: 'cashu-ts',
        version: '1.0.0',
        language: 'typescript',
        runtime: 'node-24',
        sourceDigest: `sha256:${'a1'.repeat(32)}`,
        buildDigest: `sha256:${'b2'.repeat(32)}`,
      },
      operations: ['mint'],
      nuts: [4, 7, 9, 19],
      durability: 'restart_safe',
      recovery: ['quote_state', 'proof_state', 'nut09_restore', 'nut19_replay'],
      mints: [{ id: 'nutshell-local', implementation: 'nutshell' }],
    };
  }

  async reset(): Promise<void> {
    this.events.push('reset');
    this.input = undefined;
    this.succeeded = false;
  }

  async start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    this.input = input;
    return {
      operationId,
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: this.intentHash,
      phase: 'ambiguous',
      evidenceCode: 'mint_quote_pending',
      amount: 8,
      requestHash,
      quoteHash,
      outputPlanHash,
    };
  }

  async resume(): Promise<LifecycleOperationView> {
    this.succeeded = true;
    return {
      operationId,
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: this.intentHash,
      phase: 'succeeded',
      amount: 8,
      requestHash,
      quoteHash,
      outputPlanHash,
    };
  }

  operation(): Promise<LifecycleOperationView> {
    throw new Error('not used');
  }

  wallet(): Promise<LifecycleWalletView> {
    return Promise.resolve({
      walletId: 'cashu-ts',
      mint,
      unit: 'sat',
      balances: { available: this.succeeded ? 8 : 0, reserved: 0, recoverable: 0 },
      proofs: [],
    });
  }

  evidence() {
    return Promise.resolve(this.evidenceLog);
  }
}

class MeltClient extends FakeClient {
  override async capabilities(): Promise<LifecycleCapabilities> {
    return {
      ...(await super.capabilities()),
      operations: ['melt'],
    };
  }

  override async start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    this.input = input;
    this.succeeded = true;
    return {
      operationId,
      kind: 'melt',
      mint,
      unit: 'sat',
      intentHash: this.intentHash,
      phase: 'succeeded',
      amount: 6,
      requestHash,
    };
  }

  override resume(): Promise<LifecycleOperationView> {
    throw new Error('not used');
  }

  override wallet(): Promise<LifecycleWalletView> {
    return Promise.resolve({
      walletId: 'cashu-ts',
      mint,
      unit: 'sat',
      balances: { available: this.succeeded ? 4 : 10, reserved: 0, recoverable: 0 },
      proofs: [{ proofId: '1'.repeat(64), state: 'SPENT' as const }],
    });
  }
}

describe('HTTP lifecycle lab runtime', () => {
  it('isolates deterministic wallet seeds by matrix lane and scenario', () => {
    const first = lifecycleMatrixScenarioSeed('matrix-seed', 'cdk-nutshell', 'mint-response-lost');
    const replay = lifecycleMatrixScenarioSeed('matrix-seed', 'cdk-nutshell', 'mint-response-lost');
    const nextScenario = lifecycleMatrixScenarioSeed(
      'matrix-seed',
      'cdk-nutshell',
      'swap-response-lost',
    );
    const nextLane = lifecycleMatrixScenarioSeed('matrix-seed', 'cdk-mintd', 'mint-response-lost');

    expect(first).toBe(replay);
    expect(first).not.toBe(nextScenario);
    expect(first).not.toBe(nextLane);
    expect(first.length).toBeLessThanOrEqual(256);
  });

  it('pre-funds matrix scenarios through an idempotent receive operation', () => {
    expect(
      lifecycleMatrixFundingCommands(
        'BBBBBBBBBBBBBBBBBBBBBA',
        'http://127.0.0.1:4300',
        'cashuB-external-funding-token',
      ),
    ).toEqual([
      {
        type: 'start',
        input: {
          operationId: 'BBBBBBBBBBBBBBBBBBBBBA',
          kind: 'receive',
          mint: 'http://127.0.0.1:4300',
          unit: 'sat',
          token: 'cashuB-external-funding-token',
        },
      },
      { type: 'resume', operationId: 'BBBBBBBBBBBBBBBBBBBBBA' },
    ]);
  });

  it('creates restorable deterministic outputs before the restore fault scenario', () => {
    expect(
      lifecycleMatrixRestoreSetupScenario(
        'cell-specific-seed',
        'cashu-ts-nutshell',
        'http://127.0.0.1:4300',
      ),
    ).toEqual({
      id: 'restore-duplicate-setup',
      seed: 'cell-specific-seed',
      requireQuiescence: true,
      commands: [
        {
          type: 'start',
          input: {
            operationId: expect.any(String),
            kind: 'mint',
            mint: 'http://127.0.0.1:4300',
            unit: 'sat',
            amount: 64,
            method: 'bolt11',
          },
        },
        { type: 'resume', operationId: expect.any(String) },
      ],
    });
  });

  it('clears faults and resets a matrix lane before capability discovery', async () => {
    const client = new FakeClient();

    await initializeLifecycleMatrixLane(
      client,
      {
        configure: async (rule) => {
          client.events.push(rule === undefined ? 'clear-faults' : 'configure-fault');
        },
      },
      'matrix-seed',
    );

    expect(client.events).toEqual(['clear-faults', 'reset', 'capabilities']);
  });

  it('retries full matrix lane initialization after transient reset failures', async () => {
    const client = new FakeClient();
    let resets = 0;
    client.reset = async () => {
      client.events.push('reset');
      resets += 1;
      if (resets === 1) {
        throw new LifecycleAdapterClientError(
          'LIFECYCLE_ADAPTER_HTTP_STATUS',
          'transient reset failure',
        );
      }
    };

    await initializeLifecycleMatrixLane(
      client,
      {
        configure: async (rule) => {
          client.events.push(rule === undefined ? 'clear-faults' : 'configure-fault');
        },
      },
      'matrix-seed',
    );

    expect(client.events).toEqual([
      'clear-faults',
      'reset',
      'clear-faults',
      'reset',
      'capabilities',
    ]);
  });

  it('retries full matrix lane initialization after transient adapter unavailability', async () => {
    const client = new FakeClient();
    const capabilities = client.capabilities.bind(client);
    let discoveries = 0;
    client.capabilities = async () => {
      discoveries += 1;
      if (discoveries === 1) {
        client.events.push('capabilities');
        throw new LifecycleAdapterClientError(
          'LIFECYCLE_ADAPTER_UNAVAILABLE',
          'transient adapter restart',
        );
      }
      return capabilities();
    };

    await initializeLifecycleMatrixLane(
      client,
      {
        configure: async (rule) => {
          client.events.push(rule === undefined ? 'clear-faults' : 'configure-fault');
        },
      },
      'matrix-seed',
    );

    expect(client.events).toEqual([
      'clear-faults',
      'reset',
      'capabilities',
      'clear-faults',
      'reset',
      'capabilities',
    ]);
  });

  it('does not retry matrix lane initialization after adapter contract failures', async () => {
    const client = new FakeClient();
    client.capabilities = async () => {
      client.events.push('capabilities');
      throw new LifecycleAdapterClientError('LIFECYCLE_ADAPTER_CONTRACT', 'invalid capabilities');
    };

    await expect(
      initializeLifecycleMatrixLane(
        client,
        {
          configure: async (rule) => {
            client.events.push(rule === undefined ? 'clear-faults' : 'configure-fault');
          },
        },
        'matrix-seed',
      ),
    ).rejects.toMatchObject({ code: 'LIFECYCLE_ADAPTER_CONTRACT' });

    expect(client.events).toEqual(['clear-faults', 'reset', 'capabilities']);
  });

  it('rehydrates only CDK host adapters during funded E2E matrix runs', () => {
    expect(lifecycleMatrixNeedsCdkHostRehydration({ CFL_WALLET_LIFECYCLE_E2E: '1' }, 'cdk')).toBe(
      true,
    );
    expect(
      lifecycleMatrixNeedsCdkHostRehydration({ CFL_WALLET_LIFECYCLE_E2E: '1' }, 'cashu-ts'),
    ).toBe(false);
    expect(lifecycleMatrixNeedsCdkHostRehydration({}, 'cdk')).toBe(false);
  });

  it('waits for a restarted compose service without recreating the host adapter', () => {
    expect(
      lifecycleComposeServiceRestartPlan(
        'docker',
        'infra/compose/wallet-lifecycle.compose.yml',
        'cdk-nutshell',
      ),
    ).toEqual([
      {
        executable: 'docker',
        args: [
          'compose',
          '-f',
          'infra/compose/wallet-lifecycle.compose.yml',
          'restart',
          'cdk-nutshell',
        ],
      },
      {
        executable: 'docker',
        args: [
          'compose',
          '-f',
          'infra/compose/wallet-lifecycle.compose.yml',
          'up',
          '-d',
          '--wait',
          'cdk-nutshell',
        ],
      },
    ]);
  });

  it('recreates CDK host adapters before endpoint probing', () => {
    expect(
      lifecycleComposeServicesRecreatePlan('docker', 'infra/compose/wallet-lifecycle.compose.yml', [
        'cdk-nutshell',
        'cdk-mintd',
      ]),
    ).toEqual([
      {
        executable: 'docker',
        args: [
          'compose',
          '-f',
          'infra/compose/wallet-lifecycle.compose.yml',
          'up',
          '-d',
          '--force-recreate',
          '--wait',
          'cdk-nutshell',
          'cdk-mintd',
        ],
      },
    ]);
  });

  it('waits for transient lifecycle adapter availability before matrix initialization', async () => {
    const client = new FakeClient();
    const capabilities = client.capabilities.bind(client);
    let probes = 0;
    client.capabilities = async () => {
      probes += 1;
      if (probes === 1) {
        throw new LifecycleAdapterClientError(
          'LIFECYCLE_ADAPTER_UNAVAILABLE',
          'adapter is restarting',
        );
      }
      return capabilities();
    };

    await waitForLifecycleMatrixAdapter(client, 2_000);

    expect(probes).toBe(2);
  });

  it('rejects a safe but unsuccessful matrix terminal phase', async () => {
    const client = new FakeClient();
    client.operation = async () => ({
      operationId,
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: 'a'.repeat(64),
      phase: 'failed_definitive',
      evidenceCode: 'mint_quote_unpaid',
      amount: 8,
      requestHash,
      quoteHash,
      outputPlanHash,
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'safe-failure-is-not-recovery',
      seed: 'matrix-seed',
      commands: [
        {
          type: 'start',
          input: { operationId, kind: 'mint', mint, unit: 'sat', amount: 8, method: 'bolt11' },
        },
      ],
    };

    await expect(verifyLifecycleScenarioSuccess(client, scenario)).resolves.toEqual({
      operationId,
      phase: 'failed_definitive',
    });
  });

  it('rejects terminal evidence rebound to a different operation identity', async () => {
    const client = new FakeClient();
    client.operation = async () => ({
      operationId: 'BBBBBBBBBBBBBBBBBBBBBA',
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: 'a'.repeat(64),
      phase: 'succeeded',
      amount: 8,
      requestHash,
      quoteHash,
      outputPlanHash,
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'terminal-identity-binding',
      seed: 'matrix-seed',
      commands: [
        {
          type: 'start',
          input: { operationId, kind: 'mint', mint, unit: 'sat', amount: 8, method: 'bolt11' },
        },
      ],
    };

    await expect(verifyLifecycleScenarioSuccess(client, scenario)).rejects.toThrow(
      'Lifecycle operation identity changed during terminal verification',
    );
  });

  it('rejects terminal evidence rebound to a different intent hash', async () => {
    const client = new FakeClient();
    const firstIntentHash = 'a'.repeat(64);
    client.operation = async () => ({
      operationId,
      kind: 'mint',
      mint,
      unit: 'sat',
      intentHash: 'b'.repeat(64),
      phase: 'succeeded',
      amount: 8,
      requestHash,
      quoteHash,
      outputPlanHash,
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'terminal-intent-binding',
      seed: 'matrix-seed',
      commands: [
        {
          type: 'start',
          input: { operationId, kind: 'mint', mint, unit: 'sat', amount: 8, method: 'bolt11' },
        },
      ],
    };

    await expect(
      verifyLifecycleScenarioSuccess(client, scenario, new Map([[operationId, firstIntentHash]])),
    ).rejects.toThrow('Lifecycle operation identity changed during terminal verification');
  });

  it('configures packaged restart scenarios with a compose restart controller', () => {
    const runtime = createEnvironmentLifecycleRuntime({});

    expect(runtime.options.restartController).toEqual(expect.any(Function));
  });

  it('binds adapter restarts to the exact scenario seed', async () => {
    const client = new FakeClient();
    let restartInput: unknown;
    const runtime = new HttpLifecycleLabRuntime({
      adapter: async () => ({ client, componentVersion: '1.0.0' }),
      faultController: { configure: async () => undefined },
      restartController: (input) => {
        restartInput = input;
        return { restart: async () => undefined };
      },
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'restart-seed-binding',
      seed: 'cell-specific-seed',
      commands: [{ type: 'restart', component: 'adapter' }],
    };

    await runtime.run({
      scenario,
      seed: scenario.seed,
      adapterId: 'cdk',
      mintId: 'nutshell',
    });

    expect(restartInput).toEqual({
      adapterId: 'cdk',
      mintId: 'nutshell',
      seed: 'cell-specific-seed',
    });
  });

  it('provides the four funded matrix lanes and fails missing configuration closed', async () => {
    const runtime = createEnvironmentLifecycleRuntime({});

    expect(runtime.options.matrix).toEqual(expect.any(Function));
    const results = await runtime.matrix({
      profile: 'wallet-lifecycle-v1',
      seed: 'matrix-seed',
    });

    expect(results).toEqual([
      expect.objectContaining({
        id: 'cashu-ts-nutshell',
        implementationId: 'cashu-ts',
        mintId: 'nutshell',
        status: 'failed',
        code: 'LIFECYCLE_CONFIGURATION_MISSING',
      }),
      expect.objectContaining({
        id: 'cashu-ts-mintd',
        implementationId: 'cashu-ts',
        mintId: 'mintd',
        status: 'failed',
        code: 'LIFECYCLE_CONFIGURATION_MISSING',
      }),
      expect.objectContaining({
        id: 'cdk-nutshell',
        implementationId: 'cdk',
        mintId: 'nutshell',
        status: 'failed',
        code: 'LIFECYCLE_CONFIGURATION_MISSING',
      }),
      expect.objectContaining({
        id: 'cdk-mintd',
        implementationId: 'cdk',
        mintId: 'mintd',
        status: 'failed',
        code: 'LIFECYCLE_CONFIGURATION_MISSING',
      }),
    ]);
  });

  it('attempts configured matrix lanes instead of returning placeholder results', async () => {
    const env = {
      CFL_LIFECYCLE_CASHU_TS_TOKEN: 'cashu-ts-token',
      CFL_LIFECYCLE_CDK_TOKEN: 'cdk-token',
      CFL_HTTP_FAULT_GATEWAY_TOKEN: 'gateway-token',
      CFL_LIFECYCLE_NUTSHELL_GATEWAY_URL: 'http://127.0.0.1:1',
      CFL_LIFECYCLE_MINTD_GATEWAY_URL: 'http://127.0.0.1:1',
      CFL_LIFECYCLE_NUTSHELL_MINT_URL: 'http://127.0.0.1:4300',
      CFL_LIFECYCLE_MINTD_MINT_URL: 'http://127.0.0.1:4300',
      CFL_LIFECYCLE_NUTSHELL_PUBLIC_MINT_URL: 'http://127.0.0.1:3338',
      CFL_LIFECYCLE_MINTD_PUBLIC_MINT_URL: 'http://127.0.0.1:8085',
      CFL_LIFECYCLE_CASHU_TS_NUTSHELL_URL: 'http://127.0.0.1:1',
      CFL_LIFECYCLE_CASHU_TS_MINTD_URL: 'http://127.0.0.1:1',
      CFL_LIFECYCLE_CDK_NUTSHELL_URL: 'http://127.0.0.1:1',
      CFL_LIFECYCLE_CDK_MINTD_URL: 'http://127.0.0.1:1',
    };

    const results = await createEnvironmentLifecycleRuntime(env).matrix({
      profile: 'wallet-lifecycle-v1',
      seed: 'matrix-seed',
    });

    expect(results).toHaveLength(4);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'cashu-ts-nutshell',
          status: 'failed',
          code: 'LIFECYCLE_MATRIX_EXECUTION',
        }),
      ]),
    );
    expect(results).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'LIFECYCLE_MATRIX_NOT_EXECUTED' })]),
    );
  });

  it('maps semantic faults and normalizes an ambiguous recovery into oracle observations', async () => {
    const client = new FakeClient();
    const faults: Array<LifecycleFaultRule | undefined> = [];
    const faultRule: LifecycleFaultRule = {
      action: 'drop_response',
      endpoint: 'mint',
      occurrence: 1,
    };
    const runtime = new HttpLifecycleLabRuntime({
      adapter: async () => ({ client, componentVersion: '1.0.0' }),
      faultController: {
        configure: async (rule) => {
          faults.push(rule);
        },
      },
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'mint-response-lost',
      seed: 'seed-42',
      requireQuiescence: true,
      commands: [
        { type: 'fault', rule: faultRule },
        {
          type: 'start',
          input: { operationId, kind: 'mint', mint, unit: 'sat', amount: 8, method: 'bolt11' },
        },
        { type: 'clear_faults' },
        { type: 'resume', operationId },
      ],
    };

    const execution = await runtime.run({
      scenario,
      seed: scenario.seed,
      adapterId: 'cashu-ts',
      mintId: 'nutshell-local',
    });

    expect(execution.result.ok).toBe(true);
    expect(faults).toEqual([undefined, faultRule, undefined]);
    if (!execution.result.ok) throw new Error(execution.result.artifact.failure.message);
    expect(execution.result.model.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'request_dispatched', bodyHash: requestHash }),
        expect.objectContaining({ type: 'mint_quote_observed', quoteHash }),
        expect.objectContaining({ type: 'value_moved', amount: 8 }),
        expect.objectContaining({ type: 'outputs_persisted', outputPlanHash }),
        expect.objectContaining({ type: 'phase_observed', phase: 'succeeded' }),
      ]),
    );
  });

  it('maps authenticated Lightning settlement evidence into melt quiescence', async () => {
    const client = new MeltClient();
    client.evidenceLog = [
      {
        sequence: 1,
        operationId,
        source: 'lightning',
        event: 'settlement_verified',
        dataHash: 'f'.repeat(64),
      },
    ];
    const runtime = new HttpLifecycleLabRuntime({
      adapter: async () => ({ client, componentVersion: '1.0.0' }),
      faultController: { configure: async () => undefined },
    });
    const scenario: LifecycleScenarioSpec = {
      id: 'melt-settlement-evidence',
      seed: 'seed-42',
      requireQuiescence: true,
      commands: [
        {
          type: 'start',
          input: {
            operationId,
            kind: 'melt',
            mint,
            unit: 'sat',
            invoice: 'lnbc1redacted',
          },
        },
      ],
    };

    const execution = await runtime.run({
      scenario,
      seed: scenario.seed,
      adapterId: 'cashu-ts',
      mintId: 'nutshell-local',
    });

    if (!execution.result.ok) {
      throw new Error(JSON.stringify(execution.result.artifact.observations));
    }
    expect(execution.result.ok).toBe(true);
    expect(execution.result.model.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'lightning_settlement_observed',
          operationId,
          evidenceHash: 'f'.repeat(64),
          provenance: 'lightning',
        }),
      ]),
    );
  });

  it('summarizes passed matrix evidence provenance without upgrading adapter claims', () => {
    expect(
      lifecycleMatrixEvidenceSummary([
        {
          type: 'operation_observed',
          operation: {
            operationId,
            kind: 'mint',
            mint,
            unit: 'sat',
            intentHash: 'a'.repeat(64),
            phase: 'created',
          },
          provenance: 'adapter_claimed',
        },
        { type: 'phase_observed', operationId, phase: 'succeeded', provenance: 'adapter_claimed' },
        {
          type: 'lightning_settlement_observed',
          operationId,
          evidenceHash: 'f'.repeat(64),
          provenance: 'lightning',
        },
      ]),
    ).toEqual({
      confidence: 'adapter_claimed',
      observationCount: 3,
      provenances: ['adapter_claimed', 'lightning'],
    });
  });
});
