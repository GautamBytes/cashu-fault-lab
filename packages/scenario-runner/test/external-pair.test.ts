import {
  AdapterClientError,
  AdapterNotApplicableError,
  type AdapterCapabilities,
  type AdapterClient,
  type CreateRequestInput,
  type DeliveryReceiptView,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
  type SendPaymentInput,
} from '@cashu-fault-lab/adapter-contract';
import { describe, expect, it } from 'vitest';
import { runExternalDeliveryPair } from '../src/external-pair.js';
import { seededProtocolId } from '../src/seeded-fixture.js';

const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = seededProtocolId('pair-seed', `external-delivery:sender:${requestId}`);
const payloadHash = 'a'.repeat(64);
const proofSetHash = 'b'.repeat(64);

const request: PaymentRequestView = {
  id: requestId,
  raw: 'creqAexample',
  amount: 8,
  unit: 'sat',
  singleUse: true,
  expiresAt: 1_784_400_300,
  transports: [{ type: 'post', target: 'http://127.0.0.1:8080/pay' }],
};

const receipt: DeliveryReceiptView = {
  profile: 'cashu-delivery-v1',
  request_id: requestId,
  delivery_id: deliveryId,
  payload_hash: payloadHash,
  status: 'settled',
  status_version: 2,
  mint: 'https://mint.example',
  unit: 'sat',
  amount: 8,
  detail_code: 'settled',
};

const credit: LedgerCreditView = {
  requestId,
  deliveryId,
  amount: 8,
  unit: 'sat',
  creditCount: 1,
  createdAt: 1_784_399_401,
};

const proof: ProofEvidenceView = {
  deliveryId,
  proofSetHash,
  inputYs: [`02${'01'.repeat(32)}`],
  state: 'spent',
};

function capabilities(implementation: string, role: 'sender' | 'receiver'): AdapterCapabilities {
  return {
    implementation,
    version: '1.0.0',
    nuts: [3, 7, 18],
    transports: ['http'],
    evidenceTier: role === 'sender' ? 'T1' : 'T3',
    encodings: ['creqA'],
    profiles: [{ name: 'delivery-v1', roles: [role], status: 'supported' }],
  };
}

interface FakeOptions {
  readonly role: 'sender' | 'receiver';
  readonly calls: string[];
  readonly sendReceipt?: DeliveryReceiptView;
  readonly deliveryReceipt?: DeliveryReceiptView;
  readonly credits?: readonly LedgerCreditView[];
  readonly proofEvidence?: readonly ProofEvidenceView[];
  readonly sendError?: Error;
  readonly sendErrors?: Error[];
}

class FakeAdapter implements AdapterClient {
  constructor(private readonly options: FakeOptions) {}

  async capabilities(): Promise<AdapterCapabilities> {
    this.options.calls.push(`${this.options.role}.capabilities`);
    return capabilities(this.options.role, this.options.role);
  }

  async reset(): Promise<void> {
    this.options.calls.push(`${this.options.role}.reset`);
  }

  async createRequest(_input: CreateRequestInput): Promise<PaymentRequestView> {
    this.options.calls.push(`${this.options.role}.request`);
    return request;
  }

  async send(_input: SendPaymentInput): Promise<DeliveryReceiptView> {
    this.options.calls.push(`${this.options.role}.send`);
    const nextError = this.options.sendErrors?.shift();
    if (nextError) throw nextError;
    if (this.options.sendError) throw this.options.sendError;
    return this.options.sendReceipt ?? receipt;
  }

  async delivery(): Promise<DeliveryReceiptView> {
    this.options.calls.push(`${this.options.role}.delivery`);
    return this.options.deliveryReceipt ?? receipt;
  }

  async ledger(): Promise<readonly LedgerCreditView[]> {
    this.options.calls.push(`${this.options.role}.ledger`);
    return this.options.credits ?? [credit];
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    this.options.calls.push(`${this.options.role}.proofs`);
    return this.options.proofEvidence ?? [proof];
  }
}

function pair(
  overrides: {
    readonly sender?: Partial<FakeOptions>;
    readonly receiver?: Partial<FakeOptions>;
  } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    sender: new FakeAdapter({ role: 'sender', calls, ...overrides.sender }),
    receiver: new FakeAdapter({ role: 'receiver', calls, ...overrides.receiver }),
  };
}

describe('runExternalDeliveryPair', () => {
  it('proves a settled delivery has one matching credit and spent input evidence', async () => {
    const fixture = pair();

    const result = await runExternalDeliveryPair({
      profile: 'delivery-v1',
      seed: 'pair-seed',
      sender: fixture.sender,
      receiver: fixture.receiver,
      amount: 8,
      unit: 'sat',
    });

    expect(result).toEqual({
      ok: true,
      evidence: {
        tier: 'T1',
        requestId,
        deliveryId,
        payloadHash,
        receiptVersion: 2,
        credits: 1,
        proofSetHash,
        proofState: 'spent',
        transports: ['http'],
        seed: 'pair-seed',
      },
    });
    expect(fixture.calls).toEqual([
      'receiver.reset',
      'sender.reset',
      'sender.capabilities',
      'receiver.request',
      'sender.send',
      'receiver.delivery',
      'receiver.ledger',
      'receiver.proofs',
    ]);
  });

  it('retries transient sender failures with one deterministic delivery id', async () => {
    const fixture = pair({
      sender: {
        sendErrors: [
          new AdapterClientError('ADAPTER_TIMEOUT', 'Adapter request timed out'),
          new AdapterClientError('ADAPTER_UNAVAILABLE', 'Adapter request failed'),
        ],
      },
    });
    const waits: number[] = [];

    const result = await runExternalDeliveryPair({
      profile: 'delivery-v1',
      seed: 'pair-seed',
      sender: fixture.sender,
      receiver: fixture.receiver,
      amount: 8,
      unit: 'sat',
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result).toMatchObject({ ok: true, evidence: { deliveryId } });
    expect(fixture.calls.filter((call) => call === 'sender.send')).toHaveLength(3);
    expect(waits).toEqual([100, 200]);
  });

  it('reports an unsupported funded operation as not applicable', async () => {
    const fixture = pair({
      sender: { sendError: new AdapterNotApplicableError('Wallet has no funded proofs') },
    });

    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: fixture.sender,
        receiver: fixture.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toEqual({ ok: null, reason: 'Wallet has no funded proofs' });
  });

  it('fails receipt identity conflicts without collecting misleading evidence', async () => {
    const fixture = pair({
      sender: { sendReceipt: { ...receipt, request_id: 'EBESExQVFhcYGRobHB0eHw' } },
    });

    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: fixture.sender,
        receiver: fixture.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'ADAPTER_RECEIPT_IDENTITY' });
    expect(fixture.calls).not.toContain('receiver.ledger');
  });

  it('fails duplicate credit or missing proof evidence', async () => {
    const duplicate = pair({ receiver: { credits: [credit, { ...credit, amount: 9 }] } });
    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: duplicate.sender,
        receiver: duplicate.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'ADAPTER_LEDGER_EVIDENCE' });

    const missingProof = pair({ receiver: { proofEvidence: [] } });
    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: missingProof.sender,
        receiver: missingProof.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'ADAPTER_PROOF_EVIDENCE' });

    const conflictingProof = pair({
      receiver: { proofEvidence: [proof, { ...proof, state: 'pending' }] },
    });
    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: conflictingProof.sender,
        receiver: conflictingProof.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'ADAPTER_PROOF_EVIDENCE' });
  });

  it('fails inconsistent receipt status transitions', async () => {
    const fixture = pair({
      sender: {
        sendReceipt: {
          ...receipt,
          status: 'processing',
          status_version: 2,
          detail_code: 'redeeming',
        },
      },
    });

    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: fixture.sender,
        receiver: fixture.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toMatchObject({ ok: false, code: 'ADAPTER_RECEIPT_TRANSITION' });
  });

  it('keeps adapter client execution failures diagnostic but sanitized', async () => {
    const fixture = pair({
      sender: {
        sendError: new AdapterClientError(
          'ADAPTER_HTTP_STATUS',
          'Adapter returned HTTP status 422 (SEND_FAILED)',
        ),
      },
    });
    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: fixture.sender,
        receiver: fixture.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'ADAPTER_PAIR_EXECUTION',
      reason:
        'External adapter pair execution failed during sender send: ADAPTER_HTTP_STATUS Adapter returned HTTP status 422 (SEND_FAILED)',
    });
  });

  it('maps unexpected adapter errors to a stable execution failure', async () => {
    const fixture = pair({ sender: { sendError: new Error('raw wallet proof secret') } });
    await expect(
      runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: 'pair-seed',
        sender: fixture.sender,
        receiver: fixture.receiver,
        amount: 8,
        unit: 'sat',
      }),
    ).resolves.toEqual({
      ok: false,
      code: 'ADAPTER_PAIR_EXECUTION',
      reason: 'External adapter pair execution failed',
    });
  });
});
