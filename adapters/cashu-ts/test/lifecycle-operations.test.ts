import type {
  LifecycleOperationInput,
  LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { describe, expect, test } from 'vitest';
import {
  CashuTsLifecycleOperations,
  MemoryCashuTsLifecycleStore,
  type CashuTsLifecyclePreparedRequest,
  type CashuTsLifecycleResult,
  type CashuTsLifecycleWalletPort,
} from '../src/lifecycle/operations.js';

const operationIds = {
  mint: 'AAAAAAAAAAAAAAAAAAAAAA',
  swap: 'AAAAAAAAAAAAAAAAAAAAAQ',
  send: 'AAAAAAAAAAAAAAAAAAAABA',
  receive: 'AAAAAAAAAAAAAAAAAAAABQ',
  melt: 'AAAAAAAAAAAAAAAAAAAACA',
  restore: 'AAAAAAAAAAAAAAAAAAAACQ',
  reconcile: 'AAAAAAAAAAAAAAAAAAAADA',
} as const;

const mint = 'http://127.0.0.1:3338';

const inputs: readonly LifecycleOperationInput[] = [
  { operationId: operationIds.mint, kind: 'mint', mint, unit: 'sat', amount: 8, method: 'bolt11' },
  { operationId: operationIds.swap, kind: 'swap', mint, unit: 'sat', amount: 4 },
  {
    operationId: operationIds.send,
    kind: 'send',
    mint,
    unit: 'sat',
    amount: 2,
    recipient: 'bob',
  },
  {
    operationId: operationIds.receive,
    kind: 'receive',
    mint,
    unit: 'sat',
    token: 'cashuB-secret-token',
  },
  {
    operationId: operationIds.melt,
    kind: 'melt',
    mint,
    unit: 'sat',
    invoice: 'lnbc-secret-invoice',
    preferAsync: true,
  },
  { operationId: operationIds.restore, kind: 'restore', mint, unit: 'sat' },
  {
    operationId: operationIds.reconcile,
    kind: 'reconcile',
    mint,
    unit: 'sat',
    targetOperationId: operationIds.melt,
  },
];

class RecordingWalletPort implements CashuTsLifecycleWalletPort {
  readonly calls: string[] = [];
  nextResult: CashuTsLifecycleResult = { status: 'succeeded', amount: 1 };

  async reset(seed: string): Promise<void> {
    this.calls.push(`reset:${seed}`);
  }

  async prepare(input: LifecycleOperationInput): Promise<CashuTsLifecyclePreparedRequest> {
    this.calls.push(`prepare:${input.kind}`);
    return {
      requestMaterial: { kind: input.kind, secret: `${input.kind}-request-secret` },
      requestHash: 'a'.repeat(64),
      outputPlanHash: 'b'.repeat(64),
    };
  }

  async submit(prepared: CashuTsLifecyclePreparedRequest): Promise<CashuTsLifecycleResult> {
    this.calls.push(`submit:${String((prepared.requestMaterial as { kind: string }).kind)}`);
    return this.nextResult;
  }

  async recover(
    input: LifecycleOperationInput,
    _view: LifecycleOperationView,
  ): Promise<CashuTsLifecycleResult> {
    this.calls.push(`recover:${input.kind}`);
    return this.nextResult;
  }
}

describe('CashuTsLifecycleOperations', () => {
  test('projects encrypted-store proof state into wallet and evidence views', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const operations = new CashuTsLifecycleOperations({
      store,
      wallet: new RecordingWalletPort(),
      mint,
      unit: 'sat',
    });
    await operations.reset('wallet-view-seed');
    await operations.start(inputs[0]!);
    await store.applyProofChanges({
      operationId: inputs[0]!.operationId,
      add: [
        {
          proofId: 'c'.repeat(64),
          mint,
          unit: 'sat',
          amount: 8,
          state: 'UNSPENT',
          bucket: 'available',
          material: { secret: 'never-return-this-proof-secret' },
        },
      ],
      update: [],
    });
    await store.appendEvidence({
      effectId: 'proofs-created',
      operationId: inputs[0]!.operationId,
      source: 'durable_state',
      event: 'proofs_persisted',
      dataHash: 'd'.repeat(64),
    });

    await expect(operations.wallet()).resolves.toEqual({
      walletId: 'cashu-ts',
      mint,
      unit: 'sat',
      balances: { available: 8, reserved: 0, recoverable: 0 },
      proofs: [{ proofId: 'c'.repeat(64), state: 'UNSPENT' }],
    });
    await expect(operations.evidence()).resolves.toEqual([
      {
        sequence: 1,
        operationId: inputs[0]!.operationId,
        source: 'durable_state',
        event: 'proofs_persisted',
        dataHash: 'd'.repeat(64),
      },
    ]);
    expect(JSON.stringify(await operations.wallet())).not.toContain('never-return-this');
  });

  test('persists the run before initializing wallet state', async () => {
    const calls: string[] = [];
    class OrderedStore extends MemoryCashuTsLifecycleStore {
      override async reset(seed: string): Promise<void> {
        calls.push(`store:${seed}`);
        await super.reset(seed);
      }
    }
    const wallet = new RecordingWalletPort();
    wallet.reset = async (seed) => {
      calls.push(`wallet:${seed}`);
    };
    const operations = new CashuTsLifecycleOperations({ store: new OrderedStore(), wallet });

    await operations.reset('durable-first');

    expect(calls).toEqual(['store:durable-first', 'wallet:durable-first']);
  });

  test.each(inputs)('persists and completes $kind through the typed wallet port', async (input) => {
    const events: string[] = [];
    const store = new MemoryCashuTsLifecycleStore({
      onWrite: (phase) => events.push(`store:${phase}`),
    });
    const wallet = new RecordingWalletPort();
    const operations = new CashuTsLifecycleOperations({ store, wallet });

    const result = await operations.start(input);

    expect(result).toMatchObject({
      operationId: input.operationId,
      kind: input.kind,
      mint,
      unit: 'sat',
      phase: 'succeeded',
      requestHash: 'a'.repeat(64),
      outputPlanHash: 'b'.repeat(64),
    });
    expect(events).toEqual([
      'store:created',
      'store:prepared',
      'store:submitted',
      'store:succeeded',
    ]);
    expect(wallet.calls).toEqual([`prepare:${input.kind}`, `submit:${input.kind}`]);
  });

  test('journals identity before invoking the wallet and makes start idempotent', async () => {
    const events: string[] = [];
    const store = new MemoryCashuTsLifecycleStore({
      onWrite: (phase) => events.push(`store:${phase}`),
    });
    const wallet = new RecordingWalletPort();
    const originalPrepare = wallet.prepare.bind(wallet);
    wallet.prepare = async (input) => {
      expect((await store.get(input.operationId))?.view.phase).toBe('created');
      return originalPrepare(input);
    };
    const operations = new CashuTsLifecycleOperations({ store, wallet });

    const first = await operations.start(inputs[0]!);
    const replay = await operations.start(structuredClone(inputs[0]!));

    expect(replay).toEqual(first);
    expect(wallet.calls).toEqual(['prepare:mint', 'submit:mint']);
    await expect(
      operations.start({ ...inputs[0]!, amount: 9 } as LifecycleOperationInput),
    ).rejects.toThrow('Lifecycle operation identity conflicts');
    expect(events[0]).toBe('store:created');
  });

  test('resumes an ambiguous operation under one exclusive claim', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    wallet.nextResult = { status: 'ambiguous' };
    const operations = new CashuTsLifecycleOperations({ store, wallet });

    const ambiguous = await operations.start(inputs[0]!);
    expect(ambiguous.phase).toBe('ambiguous');

    wallet.nextResult = { status: 'succeeded', amount: 8 };
    const [left, right] = await Promise.all([
      operations.resume(inputs[0]!.operationId),
      operations.resume(inputs[0]!.operationId),
    ]);

    expect(left.phase).toBe('succeeded');
    expect(right).toEqual(left);
    expect(wallet.calls.filter((call) => call === 'recover:mint')).toHaveLength(1);
  });

  test('maps definitive and blocked outcomes to evidence-bearing terminal phases', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    const operations = new CashuTsLifecycleOperations({ store, wallet });

    wallet.nextResult = { status: 'failed_definitive', evidenceCode: 'quote_expired' };
    await expect(operations.start(inputs[1]!)).resolves.toMatchObject({
      phase: 'failed_definitive',
      evidenceCode: 'quote_expired',
    });

    wallet.nextResult = { status: 'ambiguous' };
    await operations.start(inputs[4]!);
    wallet.nextResult = { status: 'recovery_blocked', evidenceCode: 'mint_unreachable' };
    await expect(operations.resume(inputs[4]!.operationId)).resolves.toMatchObject({
      phase: 'recovery_blocked',
      evidenceCode: 'mint_unreachable',
    });
  });
});
