import type {
  LifecycleOperationInput,
  LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  CashuTsLifecycleOperations,
  type CashuTsLifecyclePreparedRequest,
  type CashuTsLifecycleResult,
  type CashuTsLifecycleWalletPort,
} from '../src/lifecycle/operations.js';
import {
  PostgresCashuTsLifecycleStore,
  migratePostgresCashuTsLifecycleStore,
} from '../src/lifecycle/postgres-store.js';

const input: LifecycleOperationInput = {
  operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'receive',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  token: 'cashuB-super-secret-receive-token',
};

class RecoveringWallet implements CashuTsLifecycleWalletPort {
  recoverCalls = 0;
  result: CashuTsLifecycleResult = { status: 'ambiguous' };
  submitError: Error | undefined;

  constructor(readonly fixedOutputPlanHash?: string) {}

  async reset(): Promise<void> {}

  async prepare(operation: LifecycleOperationInput): Promise<CashuTsLifecyclePreparedRequest> {
    return {
      requestMaterial: { token: operation.kind === 'receive' ? operation.token : '' },
      requestHash: 'a'.repeat(64),
      outputPlanHash:
        this.fixedOutputPlanHash ??
        createHash('sha256').update(operation.operationId).digest('hex'),
    };
  }

  async submit(): Promise<CashuTsLifecycleResult> {
    if (this.submitError !== undefined) throw this.submitError;
    return this.result;
  }

  async recover(
    _operation: LifecycleOperationInput,
    _view: LifecycleOperationView,
  ): Promise<CashuTsLifecycleResult> {
    this.recoverCalls += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return this.result;
  }
}

describe.skipIf(process.env.CFL_POSTGRES_E2E !== '1')('PostgresCashuTsLifecycleStore', () => {
  let container: StartedPostgreSqlContainer | undefined;
  let pool: Pool | undefined;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withDatabase('cashu_fault_lab')
      .withUsername('cashu')
      .withPassword('cashu-test-password')
      .start();
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
    await migratePostgresCashuTsLifecycleStore(pool);
  }, 120_000);

  afterAll(async () => {
    pool?.on('error', () => {});
    await pool?.end();
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await container?.stop();
  }, 30_000);

  test('encrypts exact request material and resumes once after process replacement', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const key = Buffer.alloc(32, 42);
    const options = {
      pool,
      key,
      tenantId: 'cashu-ts-lifecycle-test',
      runId: 'restart-recovery',
    } as const;
    const firstWallet = new RecoveringWallet();
    const firstStore = new PostgresCashuTsLifecycleStore(options);
    const first = new CashuTsLifecycleOperations({ store: firstStore, wallet: firstWallet });
    await first.reset('postgres-lifecycle-seed');

    await expect(first.start(input)).resolves.toMatchObject({ phase: 'ambiguous' });
    const raw = await pool.query<{ record_ciphertext: Buffer }>(
      `SELECT record_ciphertext FROM cashu_lifecycle_operations
       WHERE tenant_id = $1 AND run_id = $2 AND operation_id = $3`,
      [options.tenantId, options.runId, input.operationId],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows[0]!.record_ciphertext.includes(Buffer.from(input.token))).toBe(false);

    const replacementWallet = new RecoveringWallet();
    replacementWallet.result = { status: 'succeeded', amount: 8 };
    const left = new CashuTsLifecycleOperations({
      store: new PostgresCashuTsLifecycleStore(options),
      wallet: replacementWallet,
    });
    const right = new CashuTsLifecycleOperations({
      store: new PostgresCashuTsLifecycleStore(options),
      wallet: replacementWallet,
    });

    const [leftView, rightView] = await Promise.all([
      left.resume(input.operationId),
      right.resume(input.operationId),
    ]);
    expect(leftView.phase).toBe('succeeded');
    expect(rightView).toEqual(leftView);
    expect(replacementWallet.recoverCalls).toBe(1);
  });

  test('rejects ciphertext copied to another operation identity', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const options = {
      pool,
      key: Buffer.alloc(32, 43),
      tenantId: 'cashu-ts-lifecycle-test',
      runId: 'aad-binding',
    } as const;
    const store = new PostgresCashuTsLifecycleStore(options);
    await store.reset('aad-seed');
    const operations = new CashuTsLifecycleOperations({ store, wallet: new RecoveringWallet() });
    await operations.start(input);
    const copiedOperationId = 'AAAAAAAAAAAAAAAAAAAAAQ';
    await operations.start({ ...input, operationId: copiedOperationId });

    await pool.query(
      `UPDATE cashu_lifecycle_operations AS target
       SET record_ciphertext = source.record_ciphertext,
           record_nonce = source.record_nonce,
           record_tag = source.record_tag
       FROM cashu_lifecycle_operations AS source
       WHERE target.tenant_id = $1 AND target.run_id = $2 AND target.operation_id = $3
         AND source.tenant_id = $1 AND source.run_id = $2 AND source.operation_id = $4`,
      [options.tenantId, options.runId, copiedOperationId, input.operationId],
    );
    await expect(store.get(copiedOperationId)).rejects.toThrow(
      'Unable to decrypt or authenticate lifecycle state',
    );
  });

  test('rejects output-plan reuse across operation identities', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const options = {
      pool,
      key: Buffer.alloc(32, 44),
      tenantId: 'cashu-ts-lifecycle-test',
      runId: 'output-plan-identity',
    } as const;
    const store = new PostgresCashuTsLifecycleStore(options);
    await store.reset('output-plan-seed');
    const operations = new CashuTsLifecycleOperations({
      store,
      wallet: new RecoveringWallet('b'.repeat(64)),
    });
    await operations.start(input);

    await expect(
      operations.start({ ...input, operationId: 'AAAAAAAAAAAAAAAAAAAAAQ' }),
    ).rejects.toThrow('Lifecycle output plan identity conflicts');
  });

  test('keeps the exact submitted request durable when the dependency response is lost', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const options = {
      pool,
      key: Buffer.alloc(32, 45),
      tenantId: 'cashu-ts-lifecycle-test',
      runId: 'lost-response-durability',
    } as const;
    const store = new PostgresCashuTsLifecycleStore(options);
    const wallet = new RecoveringWallet();
    wallet.submitError = new Error('mint committed and response was lost');
    const operations = new CashuTsLifecycleOperations({ store, wallet });
    await operations.reset('lost-response-seed');

    await expect(operations.start(input)).rejects.toThrow('mint committed and response was lost');

    const replacement = new PostgresCashuTsLifecycleStore(options);
    await expect(replacement.get(input.operationId)).resolves.toMatchObject({
      input,
      view: {
        phase: 'submitted',
        requestHash: 'a'.repeat(64),
      },
      prepared: {
        requestMaterial: { token: input.token },
      },
    });
  });

  test('reloads the seed and encrypted proof material after process replacement', async () => {
    if (pool === undefined) throw new Error('PostgreSQL pool did not start');
    const options = {
      pool,
      key: Buffer.alloc(32, 46),
      tenantId: 'cashu-ts-lifecycle-test',
      runId: 'wallet-proof-durability',
    } as const;
    const store = new PostgresCashuTsLifecycleStore(options);
    const operations = new CashuTsLifecycleOperations({ store, wallet: new RecoveringWallet() });
    await operations.reset('restart-wallet-seed');
    await operations.start(input);
    const proofSecret = 'postgres-encrypted-proof-secret';
    await store.applyProofChanges({
      operationId: input.operationId,
      add: [
        {
          proofId: 'e'.repeat(64),
          mint: input.mint,
          unit: input.unit,
          amount: 8,
          state: 'UNSPENT',
          bucket: 'available',
          material: { id: '00aa', secret: proofSecret, C: `02${'11'.repeat(32)}` },
        },
      ],
      update: [],
    });

    const raw = await pool.query<{ proof_ciphertext: Buffer }>(
      `SELECT proof_ciphertext FROM cashu_lifecycle_proofs
       WHERE tenant_id = $1 AND run_id = $2 AND proof_id = $3`,
      [options.tenantId, options.runId, 'e'.repeat(64)],
    );
    expect(raw.rows[0]!.proof_ciphertext.includes(Buffer.from(proofSecret))).toBe(false);

    const replacement = new PostgresCashuTsLifecycleStore(options);
    await expect(replacement.loadSeed()).resolves.toBe('restart-wallet-seed');
    await expect(replacement.listProofs(input.mint, input.unit)).resolves.toEqual([
      expect.objectContaining({
        proofId: 'e'.repeat(64),
        amount: 8,
        state: 'UNSPENT',
        bucket: 'available',
        material: expect.objectContaining({ secret: proofSecret }),
      }),
    ]);

    await replacement.applyProofChanges({
      operationId: input.operationId,
      add: [],
      update: [{ proofId: 'e'.repeat(64), state: 'PENDING', bucket: 'reserved' }],
    });
    await expect(replacement.walletView('cashu-ts', input.mint, input.unit)).resolves.toMatchObject(
      {
        balances: { available: 0, reserved: 8, recoverable: 0 },
        proofs: [{ proofId: 'e'.repeat(64), state: 'PENDING' }],
      },
    );
  });
});
