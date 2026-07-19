import type { CashuProof, DeliveryReceiptWire, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { computePayloadHash } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  InMemorySenderState,
  resumePayment,
  sendPayment,
  type PaymentTransport,
  type ReservedProofSet,
  type SenderDeliveryRecord,
  type SenderPaymentRequest,
  type SenderState,
  type SenderStateOperations,
  type SenderWallet,
  type TransportResult,
} from '../src/index.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const proofs: readonly CashuProof[] = [{ amount: 8, id: '00aa', secret: 'secret-a', C: '02aa' }];

function request(overrides: Partial<SenderPaymentRequest> = {}): SenderPaymentRequest {
  return {
    id: requestId as ProtocolId,
    amount: 8,
    unit: 'sat',
    mints: ['https://mint.example'],
    expiresAt: now + 900,
    transports: [{ type: 'post', target: 'https://merchant.example/v1/pay' }],
    ...overrides,
  };
}

function receipt(
  status: 'processing' | 'settled' | 'rejected',
  version: number,
  detailCode: string,
): DeliveryReceiptWire {
  const payloadHash = computePayloadHash({
    requestId: requestId as ProtocolId,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs,
    createdAt: now,
    expiresAt: now + 900,
  });
  return {
    profile: 'cashu-delivery-v1',
    request_id: requestId,
    delivery_id: deliveryId,
    payload_hash: payloadHash,
    status,
    status_version: version,
    mint: 'https://mint.example',
    unit: 'sat',
    amount: 8,
    detail_code: detailCode,
  };
}

class FakeWallet implements SenderWallet {
  createdProofSets = 0;
  recoveryRequiredCalls = 0;
  readonly statuses = new Map<string, string>();
  terminalFailure: Error | undefined;

  async reserveExact(): Promise<ReservedProofSet> {
    this.createdProofSets += 1;
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs };
  }

  async markSettled(selectedDeliveryId: string): Promise<void> {
    if (this.terminalFailure) throw this.terminalFailure;
    this.statuses.set(selectedDeliveryId, 'released-settled');
  }

  async releaseRejected(selectedDeliveryId: string): Promise<void> {
    if (this.terminalFailure) throw this.terminalFailure;
    this.statuses.set(selectedDeliveryId, 'released-rejected');
  }

  async markRecoveryRequired(selectedDeliveryId: string): Promise<void> {
    this.recoveryRequiredCalls += 1;
    this.statuses.set(selectedDeliveryId, 'recovery-required');
  }

  reservation(selectedDeliveryId: string): string | undefined {
    return this.statuses.get(selectedDeliveryId);
  }
}

class FakeTransport implements PaymentTransport {
  readonly payloads: Uint8Array[] = [];
  readonly targets: string[] = [];
  readonly results: Array<TransportResult | Error | Promise<TransportResult>> = [];
  onSend: (() => void) | undefined;

  async send(payload: Uint8Array, target: { readonly target: string }): Promise<TransportResult> {
    this.payloads.push(Uint8Array.from(payload));
    this.targets.push(target.target);
    this.onSend?.();
    const result = await this.results.shift();
    if (result instanceof Error) throw result;
    return result ?? { kind: 'no_response' };
  }
}

function stateView(state: SenderState): SenderState {
  return {
    withDeliveryLock: <T>(
      selectedDeliveryId: string,
      operation: (lockedState: SenderStateOperations) => Promise<T>,
    ) => state.withDeliveryLock(selectedDeliveryId, operation),
    create: (record: SenderDeliveryRecord) => state.create(record),
    get: (selectedDeliveryId: string) => state.get(selectedDeliveryId),
    save: (record: SenderDeliveryRecord) => state.save(record),
  };
}

function deps(
  wallet = new FakeWallet(),
  transport = new FakeTransport(),
  state: SenderState = new InMemorySenderState(),
) {
  const delays: number[] = [];
  return {
    wallet,
    transport,
    state,
    now: () => now,
    generateDeliveryId: () => deliveryId as ProtocolId,
    sleep: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
    delays,
  };
}

describe('sendPayment', () => {
  it('reserves once and retries byte-identical payloads until settled', async () => {
    const setup = deps();
    setup.transport.results.push(
      new Error('response lost'),
      { kind: 'no_response' },
      { kind: 'receipt', receipt: receipt('settled', 1, 'settled') },
    );

    const outcome = await sendPayment(request(), setup, {
      seed: 'retry-seed',
      maxAttempts: 3,
    });

    expect(outcome).toMatchObject({ status: 'settled', deliveryId });
    expect(setup.transport.payloads).toHaveLength(3);
    expect(
      new Set(setup.transport.payloads.map((value) => Buffer.from(value).toString('hex'))).size,
    ).toBe(1);
    expect(setup.wallet.createdProofSets).toBe(1);
    expect(setup.wallet.reservation(deliveryId)).toBe('released-settled');
    expect(setup.delays).toHaveLength(2);
  });

  it('falls back through ordered transports without changing logical payload bytes', async () => {
    const setup = deps();
    setup.transport.results.push(
      { kind: 'no_response' },
      { kind: 'receipt', receipt: receipt('settled', 1, 'settled') },
    );
    const outcome = await sendPayment(
      request({
        transports: [
          { type: 'post', target: 'https://merchant.example/v1/pay' },
          { type: 'nostr', target: 'nprofile1-receiver' },
        ],
      }),
      setup,
      { seed: 'transport-fallback', maxAttempts: 2 },
    );

    expect(outcome.status).toBe('settled');
    expect(setup.transport.targets).toEqual([
      'https://merchant.example/v1/pay',
      'nprofile1-receiver',
    ]);
    expect(Buffer.from(setup.transport.payloads[0]!).equals(setup.transport.payloads[1]!)).toBe(
      true,
    );
  });

  it('merges processing receipts and releases only on terminal settlement', async () => {
    const setup = deps();
    setup.transport.results.push(
      { kind: 'receipt', receipt: receipt('processing', 1, 'accepted') },
      { kind: 'receipt', receipt: receipt('processing', 2, 'redeeming') },
      { kind: 'receipt', receipt: receipt('settled', 3, 'settled') },
    );
    const outcome = await sendPayment(request(), setup, { seed: 'receipt-seed', maxAttempts: 3 });
    expect(outcome).toMatchObject({ status: 'settled', receipt: { statusVersion: 3 } });
    expect(setup.wallet.reservation(deliveryId)).toBe('released-settled');
  });

  it('releases on explicit rejection but holds proofs after ambiguous exhaustion', async () => {
    const rejectedSetup = deps();
    rejectedSetup.transport.results.push({
      kind: 'receipt',
      receipt: receipt('rejected', 1, 'invalid'),
    });
    expect(
      await sendPayment(request(), rejectedSetup, { seed: 'reject-seed', maxAttempts: 3 }),
    ).toMatchObject({ status: 'rejected' });
    expect(rejectedSetup.wallet.reservation(deliveryId)).toBe('released-rejected');

    const unknownSetup = deps();
    unknownSetup.transport.results.push(new Error('lost'), new Error('lost'));
    expect(
      await sendPayment(request(), unknownSetup, { seed: 'lost-seed', maxAttempts: 2 }),
    ).toMatchObject({ status: 'recovery_required' });
    expect(unknownSetup.wallet.reservation(deliveryId)).toBe('recovery-required');
  });

  it('stops on recovery-blocked without releasing proofs', async () => {
    const setup = deps();
    setup.transport.results.push({
      kind: 'receipt',
      receipt: receipt('processing', 3, 'recovery_blocked'),
    });
    const outcome = await sendPayment(request(), setup, { seed: 'blocked-seed', maxAttempts: 5 });
    expect(outcome).toMatchObject({ status: 'recovery_required' });
    expect(setup.transport.payloads).toHaveLength(1);
    expect(setup.wallet.reservation(deliveryId)).toBe('recovery-required');
  });

  it('stops retrying permanent HTTP failures without releasing proofs', async () => {
    const setup = deps();
    setup.transport.results.push({
      kind: 'permanent_failure',
      status: 409,
      code: 'DELIVERY_CONFLICT',
    });
    const outcome = await sendPayment(request(), setup, {
      seed: 'permanent-failure',
      maxAttempts: 5,
    });

    expect(outcome).toMatchObject({ status: 'recovery_required' });
    expect(setup.transport.payloads).toHaveLength(1);
    expect(setup.wallet.reservation(deliveryId)).toBe('recovery-required');
  });

  it('resumes persisted bytes without reserving another proof set', async () => {
    const setup = deps();
    setup.transport.results.push(new Error('lost'));
    await sendPayment(request(), setup, { seed: 'resume-seed', maxAttempts: 1 });
    setup.transport.results.push({ kind: 'receipt', receipt: receipt('settled', 1, 'settled') });

    const outcome = await resumePayment(deliveryId, setup, {
      seed: 'resume-seed',
      maxAttempts: 1,
    });
    expect(outcome).toMatchObject({ status: 'settled' });
    expect(setup.wallet.createdProofSets).toBe(1);
    expect(setup.transport.payloads).toHaveLength(2);
    expect(Buffer.from(setup.transport.payloads[0]!).equals(setup.transport.payloads[1]!)).toBe(
      true,
    );
  });

  it.each([
    ['settled', 'released-settled'],
    ['rejected', 'released-rejected'],
  ] as const)(
    'reconciles a persisted %s state with the wallet on resume',
    async (status, walletStatus) => {
      const setup = deps();
      setup.transport.results.push({
        kind: 'receipt',
        receipt: receipt(status, 1, status),
      });
      await sendPayment(request(), setup, { seed: `terminal-${status}`, maxAttempts: 1 });
      setup.wallet.statuses.delete(deliveryId);

      const outcome = await resumePayment(deliveryId, setup, {
        seed: `terminal-${status}`,
        maxAttempts: 1,
      });

      expect(outcome.status).toBe(status);
      expect(setup.wallet.reservation(deliveryId)).toBe(walletStatus);
      expect(setup.transport.payloads).toHaveLength(1);
      expect(setup.wallet.createdProofSets).toBe(1);
    },
  );

  it('serializes concurrent resumes so a no-response cannot regress settlement', async () => {
    const wallet = new FakeWallet();
    const transport = new FakeTransport();
    const sharedState = new InMemorySenderState();
    const setup = deps(wallet, transport, stateView(sharedState));
    transport.results.push({ kind: 'no_response' });
    await sendPayment(request(), setup, { seed: 'concurrent-resume', maxAttempts: 1 });
    transport.results.push(
      { kind: 'receipt', receipt: receipt('settled', 1, 'settled') },
      { kind: 'no_response' },
    );
    const otherProcess = deps(wallet, transport, stateView(sharedState));

    const outcomes = await Promise.all([
      resumePayment(deliveryId, setup, { seed: 'concurrent-resume-a', maxAttempts: 1 }),
      resumePayment(deliveryId, otherProcess, { seed: 'concurrent-resume-b', maxAttempts: 1 }),
    ]);

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['settled', 'settled']);
    expect((await setup.state.get(deliveryId))?.status).toBe('settled');
    expect(setup.wallet.reservation(deliveryId)).toBe('released-settled');
    expect(transport.payloads).toHaveLength(2);
  });

  it('serializes an initial send and a concurrent resume through shared sender state', async () => {
    const wallet = new FakeWallet();
    const sharedState = new InMemorySenderState();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst!: (result: TransportResult) => void;
    const firstBlocked = new Promise<TransportResult>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = new FakeTransport();
    transport.onSend = markStarted;
    transport.results.push(firstBlocked, { kind: 'no_response' });
    const sender = deps(wallet, transport, stateView(sharedState));
    const recoveringProcess = deps(wallet, transport, stateView(sharedState));

    const sending = sendPayment(request(), sender, { seed: 'concurrent-send', maxAttempts: 1 });
    await started;
    const resuming = resumePayment(deliveryId, recoveringProcess, {
      seed: 'concurrent-resume',
      maxAttempts: 1,
    });
    await Promise.resolve();
    releaseFirst({ kind: 'receipt', receipt: receipt('settled', 1, 'settled') });

    const outcomes = await Promise.all([sending, resuming]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['settled', 'settled']);
    expect((await sharedState.get(deliveryId))?.status).toBe('settled');
    expect(wallet.reservation(deliveryId)).toBe('released-settled');
    expect(transport.payloads).toHaveLength(1);
  });

  it('rejects a generated delivery-ID collision before reserving another proof set', async () => {
    const setup = deps();
    setup.transport.results.push({
      kind: 'receipt',
      receipt: receipt('settled', 1, 'settled'),
    });
    await sendPayment(request(), setup, { seed: 'first-delivery', maxAttempts: 1 });

    await expect(
      sendPayment(request(), setup, { seed: 'colliding-delivery', maxAttempts: 1 }),
    ).rejects.toThrowError(/delivery ID already exists/i);

    expect(setup.wallet.createdProofSets).toBe(1);
    expect(setup.wallet.recoveryRequiredCalls).toBe(0);
    expect(setup.wallet.reservation(deliveryId)).toBe('released-settled');
    expect(setup.transport.payloads).toHaveLength(1);
  });

  it.each(['settled', 'rejected'] as const)(
    'keeps a persisted %s receipt terminal when wallet reconciliation fails',
    async (status) => {
      const wallet = new FakeWallet();
      wallet.terminalFailure = new Error('wallet transition failed');
      const transport = new FakeTransport();
      transport.results.push({ kind: 'receipt', receipt: receipt(status, 1, status) });
      const setup = deps(wallet, transport);

      await expect(
        sendPayment(request(), setup, { seed: `wallet-failure-${status}`, maxAttempts: 1 }),
      ).rejects.toThrowError(/wallet transition failed/i);

      const persisted = await setup.state.get(deliveryId);
      expect(persisted?.status).toBe(status);
      expect(persisted?.receipt?.status).toBe(status);
      expect(wallet.recoveryRequiredCalls).toBe(0);

      wallet.terminalFailure = undefined;
      const outcome = await resumePayment(deliveryId, setup, {
        seed: `wallet-reconcile-${status}`,
        maxAttempts: 1,
      });
      expect(outcome.status).toBe(status);
      expect(transport.payloads).toHaveLength(1);
      expect(wallet.reservation(deliveryId)).toBe(
        status === 'settled' ? 'released-settled' : 'released-rejected',
      );
    },
  );

  it('marks the wallet recovery-required when a nonterminal attempt fails unexpectedly', async () => {
    const setup = deps();
    setup.transport.results.push({ kind: 'no_response' });
    setup.sleep = async () => {
      throw new Error('retry scheduler failed');
    };

    await expect(
      sendPayment(request(), setup, { seed: 'retry-failure', maxAttempts: 2 }),
    ).rejects.toThrowError(/retry scheduler failed/i);

    expect((await setup.state.get(deliveryId))?.status).toBe('sending');
    expect(setup.wallet.recoveryRequiredCalls).toBe(1);
    expect(setup.wallet.reservation(deliveryId)).toBe('recovery-required');
  });

  it('counts a malformed receipt transport invocation exactly once', async () => {
    const setup = deps();
    setup.transport.results.push({
      kind: 'receipt',
      receipt: { ...receipt('settled', 1, 'settled'), payload_hash: 'f'.repeat(64) },
    });
    expect(
      await sendPayment(request(), setup, { seed: 'invalid-receipt', maxAttempts: 1 }),
    ).toMatchObject({ status: 'recovery_required' });
    expect((await setup.state.get(deliveryId))?.attempts).toBe(1);
    expect(setup.wallet.reservation(deliveryId)).toBe('recovery-required');
  });

  it('rejects expired requests before reserving proofs', async () => {
    const setup = deps();
    await expect(
      sendPayment(request({ expiresAt: now }), setup, { seed: 'expired-seed', maxAttempts: 1 }),
    ).rejects.toThrowError(/expired/i);
    expect(setup.wallet.createdProofSets).toBe(0);
  });

  it('marks recovery required if post-reservation validation fails', async () => {
    const wallet = new FakeWallet();
    wallet.reserveExact = async () => {
      wallet.createdProofSets += 1;
      return { mint: 'https://mint.example', unit: 'sat', netAmount: 7, proofs };
    };
    const setup = deps(wallet);
    await expect(
      sendPayment(request(), setup, { seed: 'bad-reservation', maxAttempts: 1 }),
    ).rejects.toThrowError(/exact/i);
    expect(wallet.reservation(deliveryId)).toBe('recovery-required');
  });
});
