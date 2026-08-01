import type {
  LifecycleCapabilities,
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
  test('reserves monotonic counter ranges for a seed and never reuses them after reset', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    await store.reset('counter-seed');

    await expect(store.reserveCounterRange('00aa', 'op-a', 64)).resolves.toEqual({
      start: 0,
      count: 64,
    });
    await expect(store.reserveCounterRange('00aa', 'op-a', 64)).resolves.toEqual({
      start: 0,
      count: 64,
    });
    await expect(store.reserveCounterRange('00aa', 'op-b', 64)).resolves.toEqual({
      start: 64,
      count: 64,
    });

    await store.reset('counter-seed');
    await expect(store.reserveCounterRange('00aa', 'op-a', 64)).resolves.toEqual({
      start: 128,
      count: 64,
    });
    await expect(store.counterHighWatermark('00aa')).resolves.toBe(192);

    await store.reset('other-counter-seed');
    await expect(store.reserveCounterRange('00aa', 'op-a', 64)).resolves.toEqual({
      start: 0,
      count: 64,
    });
    await store.reset('counter-seed');
    await expect(store.reserveCounterRange('00aa', 'op-c', 64)).resolves.toEqual({
      start: 192,
      count: 64,
    });
  });

  test('offers send outbox entries to one trusted worker until acknowledged', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    await store.reset('send-outbox-seed');
    await store.create({
      input: inputs[2]!,
      view: {
        operationId: inputs[2]!.operationId,
        kind: 'send',
        mint,
        unit: 'sat',
        intentHash: 'a'.repeat(64),
        phase: 'created',
      },
      attemptCount: 0,
    });
    const tokenHash = await store.putSendHandoff(inputs[2]!.operationId, 'bob', 'cashuB-token');

    await expect(store.claimSendHandoff('worker-a')).resolves.toEqual({
      operationId: inputs[2]!.operationId,
      recipient: 'bob',
      token: 'cashuB-token',
      tokenHash,
    });
    await expect(store.claimSendHandoff('worker-b')).resolves.toBeUndefined();
    await expect(
      store.ackSendHandoff(inputs[2]!.operationId, tokenHash, 'worker-b'),
    ).rejects.toThrow('Lifecycle send handoff claim conflicts');
    await store.ackSendHandoff(inputs[2]!.operationId, tokenHash, 'worker-a');
    await expect(store.claimSendHandoff('worker-a')).resolves.toBeUndefined();
  });

  test('does not execute operations absent from advertised capabilities', async () => {
    const capabilities: LifecycleCapabilities = {
      schemaVersion: 1,
      implementation: {
        id: 'cashu-ts',
        version: '4.7.2',
        language: 'typescript',
        runtime: 'node-24',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        buildDigest: `sha256:${'b'.repeat(64)}`,
      },
      operations: ['mint'],
      nuts: [4, 13],
      durability: 'restart_safe',
      recovery: ['quote_state', 'nut13_seed'],
      mints: [{ id: 'configured-mint', implementation: 'configured' }],
    };
    const wallet = new RecordingWalletPort();
    const operations = new CashuTsLifecycleOperations({
      store: new MemoryCashuTsLifecycleStore(),
      wallet,
      capabilities,
    });

    await expect(operations.start(inputs[1]!)).rejects.toThrow(
      'Lifecycle operation is not advertised',
    );
    expect(wallet.calls).toEqual([]);
  });

  test('does not advertise melt unless the mint supports NUT-05 and NUT-08', async () => {
    const capabilities: LifecycleCapabilities = {
      schemaVersion: 1,
      implementation: {
        id: 'cashu-ts',
        version: '4.7.2',
        language: 'typescript',
        runtime: 'node-24',
        sourceDigest: `sha256:${'a'.repeat(64)}`,
        buildDigest: `sha256:${'b'.repeat(64)}`,
      },
      operations: ['mint', 'melt'],
      nuts: [4, 5, 8],
      durability: 'restart_safe',
      recovery: ['quote_state'],
      mints: [{ id: 'configured-mint', implementation: 'configured' }],
    };
    const wallet = new RecordingWalletPort();
    wallet.discoverSupportedNuts = async () => [4, 5];
    const operations = new CashuTsLifecycleOperations({
      store: new MemoryCashuTsLifecycleStore(),
      wallet,
      capabilities,
    });

    await expect(operations.capabilities()).resolves.toMatchObject({
      operations: ['mint'],
      nuts: [4, 5],
    });
    await expect(operations.start(inputs[4]!)).rejects.toThrow(
      'Lifecycle operation is not advertised',
    );
  });

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
    await expect(operations.evidence()).resolves.toEqual(
      expect.arrayContaining([
        {
          sequence: expect.any(Number),
          operationId: inputs[0]!.operationId,
          source: 'adapter',
          event: 'submission_succeeded',
          dataHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        {
          sequence: expect.any(Number),
          operationId: inputs[0]!.operationId,
          source: 'durable_state',
          event: 'proofs_persisted',
          dataHash: 'd'.repeat(64),
        },
      ]),
    );
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

  test('atomically persists prepared material and proof reservations before submission', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    const operations = new CashuTsLifecycleOperations({ store, wallet });
    await operations.reset('atomic-proof-reservation');
    await operations.start(inputs[0]!);
    await store.applyProofChanges({
      operationId: inputs[0]!.operationId,
      add: [
        {
          proofId: 'e'.repeat(64),
          mint,
          unit: 'sat',
          amount: 8,
          state: 'UNSPENT',
          bucket: 'available',
          material: { secret: 'reserved-proof-secret' },
        },
      ],
      update: [],
    });
    wallet.prepare = async () => ({
      requestMaterial: { kind: 'swap', exact: 'prepared-request' },
      requestHash: 'c'.repeat(64),
      outputPlanHash: 'd'.repeat(64),
      proofChanges: {
        add: [],
        update: [{ proofId: 'e'.repeat(64), state: 'PENDING', bucket: 'reserved' }],
      },
    });
    wallet.submit = async () => {
      expect(await store.listProofs(mint, 'sat')).toEqual([
        expect.objectContaining({
          proofId: 'e'.repeat(64),
          state: 'PENDING',
          bucket: 'reserved',
        }),
      ]);
      return { status: 'succeeded', amount: 4 };
    };

    await expect(operations.start(inputs[1]!)).resolves.toMatchObject({
      phase: 'succeeded',
    });
  });

  test('does not allow two operations to reserve the same proof', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    const operations = new CashuTsLifecycleOperations({ store, wallet });
    await operations.reset('exclusive-proof-reservation');
    await operations.start(inputs[0]!);
    await store.applyProofChanges({
      operationId: inputs[0]!.operationId,
      add: [
        {
          proofId: 'f'.repeat(64),
          mint,
          unit: 'sat',
          amount: 8,
          state: 'UNSPENT',
          bucket: 'available',
          material: { secret: 'one-owner-only' },
        },
      ],
      update: [],
    });
    wallet.prepare = async (input) => ({
      requestMaterial: { kind: input.kind, exact: 'prepared-request' },
      proofChanges: {
        add: [],
        update: [{ proofId: 'f'.repeat(64), state: 'PENDING', bucket: 'reserved' }],
      },
    });
    wallet.nextResult = { status: 'ambiguous' };

    await expect(operations.start(inputs[1]!)).resolves.toMatchObject({ phase: 'ambiguous' });
    await expect(operations.start(inputs[2]!)).rejects.toThrow(
      'Lifecycle proof is reserved by another operation',
    );
  });

  test('rolls back terminal state and proof changes when evidence cannot commit', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    wallet.nextResult = {
      status: 'succeeded',
      amount: 8,
      proofChanges: {
        add: [
          {
            proofId: '9'.repeat(64),
            mint,
            unit: 'sat',
            amount: 8,
            state: 'UNSPENT',
            bucket: 'available',
            material: { secret: 'must-roll-back' },
          },
        ],
        update: [],
      },
      evidence: [
        {
          effectId: 'invalid-evidence',
          operationId: inputs[0]!.operationId,
          source: 'durable_state',
          event: 'proofs_persisted',
          dataHash: 'invalid',
        },
      ],
    } as CashuTsLifecycleResult;
    const operations = new CashuTsLifecycleOperations({ store, wallet });
    await operations.reset('atomic-result-evidence');

    await expect(operations.start(inputs[0]!)).rejects.toThrow(
      'Lifecycle evidence hash is invalid',
    );
    await expect(operations.operation(inputs[0]!.operationId)).resolves.toMatchObject({
      phase: 'submitted',
    });
    await expect(store.listProofs(mint, 'sat')).resolves.toEqual([]);
    await expect(operations.evidence()).resolves.toEqual([]);
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

  test('journals attempt count and the successful recovery mechanism', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    wallet.nextResult = { status: 'ambiguous' };
    const operations = new CashuTsLifecycleOperations({ store, wallet });
    await operations.start(inputs[0]!);
    wallet.nextResult = {
      status: 'succeeded',
      amount: 8,
      recoveryMechanism: 'nut09_restore',
    } as CashuTsLifecycleResult;

    await operations.resume(inputs[0]!.operationId);

    await expect(store.get(inputs[0]!.operationId)).resolves.toMatchObject({
      attemptCount: 2,
      recoveryMechanism: 'nut09_restore',
    });
  });

  test('blocks recovery on quote-state regression across attempts', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    wallet.nextResult = { status: 'ambiguous' };
    const operations = new CashuTsLifecycleOperations({ store, wallet });
    await operations.start(inputs[4]!);
    wallet.nextResult = {
      status: 'ambiguous',
      recoveryMechanism: 'quote_state',
      quoteObservations: [{ kind: 'melt', state: 'PENDING', dataHash: '1'.repeat(64) }],
    } as CashuTsLifecycleResult;
    await operations.resume(inputs[4]!.operationId);
    wallet.nextResult = {
      status: 'ambiguous',
      recoveryMechanism: 'quote_state',
      quoteObservations: [{ kind: 'melt', state: 'UNPAID', dataHash: '2'.repeat(64) }],
    } as CashuTsLifecycleResult;

    await expect(operations.resume(inputs[4]!.operationId)).resolves.toMatchObject({
      phase: 'recovery_blocked',
      evidenceCode: 'quote_state_regressed',
    });
  });

  test('keeps submitted terminal failures ambiguous until recovery evidence is collected', async () => {
    const store = new MemoryCashuTsLifecycleStore();
    const wallet = new RecordingWalletPort();
    const operations = new CashuTsLifecycleOperations({ store, wallet });

    wallet.nextResult = { status: 'failed_definitive', evidenceCode: 'quote_expired' };
    await expect(operations.start(inputs[1]!)).resolves.toMatchObject({
      phase: 'ambiguous',
    });
    await expect(store.get(inputs[1]!.operationId)).resolves.toMatchObject({
      view: { phase: 'ambiguous' },
    });
    wallet.nextResult = { status: 'failed_definitive', evidenceCode: 'quote_expired' };
    await expect(operations.resume(inputs[1]!.operationId)).resolves.toMatchObject({
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
