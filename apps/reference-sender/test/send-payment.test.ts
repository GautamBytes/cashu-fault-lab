import type { CashuProof, DeliveryReceiptWire, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { computePayloadHash } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  InMemorySenderState,
  resumePayment,
  sendPayment,
  type PaymentTransport,
  type ReservedProofSet,
  type SenderPaymentRequest,
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
  readonly statuses = new Map<string, string>();

  async reserveExact(): Promise<ReservedProofSet> {
    this.createdProofSets += 1;
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs };
  }

  async markSettled(selectedDeliveryId: string): Promise<void> {
    this.statuses.set(selectedDeliveryId, 'released-settled');
  }

  async releaseRejected(selectedDeliveryId: string): Promise<void> {
    this.statuses.set(selectedDeliveryId, 'released-rejected');
  }

  async markRecoveryRequired(selectedDeliveryId: string): Promise<void> {
    this.statuses.set(selectedDeliveryId, 'recovery-required');
  }

  reservation(selectedDeliveryId: string): string | undefined {
    return this.statuses.get(selectedDeliveryId);
  }
}

class FakeTransport implements PaymentTransport {
  readonly payloads: Uint8Array[] = [];
  readonly targets: string[] = [];
  readonly results: Array<TransportResult | Error> = [];

  async send(payload: Uint8Array, target: { readonly target: string }): Promise<TransportResult> {
    this.payloads.push(Uint8Array.from(payload));
    this.targets.push(target.target);
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return result ?? { kind: 'no_response' };
  }
}

function deps(wallet = new FakeWallet(), transport = new FakeTransport()) {
  const delays: number[] = [];
  return {
    wallet,
    transport,
    state: new InMemorySenderState(),
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
