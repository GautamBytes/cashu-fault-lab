import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import type {
  AdapterCapabilities,
  CreateRequestInput,
  LedgerCreditView,
  PaymentRequestView,
  ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import {
  normalizeMintUrl,
  parseProtocolId,
  serializeDeliveryReceipt,
  type DeliveryReceiptWire,
} from '@cashu-fault-lab/delivery-core';
import { createHash } from 'node:crypto';
import type { ReceiverAdapterControl } from './http/adapter-routes.js';
import { MemoryReceiverStore } from './adapters/memory-store.js';

export interface FundedReceiverAdapterControlOptions {
  readonly store: MemoryReceiverStore;
  readonly mintUrl: string;
  readonly paymentTarget: string;
  readonly now: () => number;
}

function protocolId(seed: string, ordinal: number): string {
  return parseProtocolId(
    createHash('sha256')
      .update('cashu-fault-lab/reference-receiver-request-v1\0')
      .update(seed)
      .update('\0')
      .update(String(ordinal))
      .digest()
      .subarray(0, 16)
      .toString('base64url'),
  );
}

function paymentTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Reference receiver payment target is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Reference receiver payment target is invalid');
  }
  return url.toString();
}

function toUrlSafeCreqA(value: string): string {
  const prefix = 'creqA';
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new Error('cashu-ts produced an invalid NUT-18 payment request');
  }
  return `${prefix}${Buffer.from(value.slice(prefix.length), 'base64').toString('base64url')}`;
}

export class FundedReceiverAdapterControl implements ReceiverAdapterControl {
  readonly #store: MemoryReceiverStore;
  readonly #mintUrl: string;
  readonly #paymentTarget: string;
  readonly #now: () => number;
  #seed = '';
  #ordinal = 0;

  constructor(options: FundedReceiverAdapterControlOptions) {
    this.#store = options.store;
    this.#mintUrl = normalizeMintUrl(options.mintUrl);
    this.#paymentTarget = paymentTarget(options.paymentTarget);
    this.#now = options.now;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'reference-receiver',
      version: '0.0.0',
      nuts: [2, 3, 7, 9, 12, 18, 19],
      transports: ['http'],
      evidenceTier: 'T1',
      encodings: ['creqA'],
      profiles: [
        { name: 'delivery-v1', roles: ['receiver'], status: 'supported' },
        {
          name: 'legacy-nut18',
          roles: ['receiver'],
          status: 'unsupported',
          reason: 'Funded receiver operations require the delivery-v1 idempotency extension',
        },
        {
          name: 'nut26-nostr',
          roles: ['receiver'],
          status: 'unsupported',
          reason: 'Funded receiver operations currently implement HTTP delivery only',
        },
      ],
    };
  }

  async reset(seed: string): Promise<void> {
    if (seed.length === 0) throw new Error('Reference receiver seed is required');
    await this.#store.reset();
    this.#seed = seed;
    this.#ordinal = 0;
  }

  async createRequest(input: CreateRequestInput): Promise<PaymentRequestView> {
    if (this.#seed.length === 0) throw new Error('Reference receiver must be reset first');
    if (
      input.amount < 1 ||
      input.unit.length === 0 ||
      !input.singleUse ||
      input.transports.length !== 1 ||
      input.transports[0] !== 'http'
    ) {
      throw new Error('Reference receiver request is unsupported');
    }
    const now = this.#now();
    const expiresAt = now + input.expiresIn;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)) {
      throw new Error('Reference receiver time is invalid');
    }
    const id = protocolId(this.#seed, this.#ordinal++);
    await this.#store.createRequest({
      id,
      amount: input.amount,
      unit: input.unit,
      mints: [this.#mintUrl],
      singleUse: true,
      expiresAt,
    });
    const request = new PaymentRequest(
      [{ type: PaymentRequestTransportType.POST, target: this.#paymentTarget, tags: [] }],
      id,
      input.amount,
      input.unit,
      [this.#mintUrl],
      input.description,
      true,
    );
    return {
      id,
      raw: toUrlSafeCreqA(request.toEncodedCreqA()),
      amount: input.amount,
      unit: input.unit,
      singleUse: true,
      expiresAt,
      transports: [{ type: 'post', target: this.#paymentTarget }],
    };
  }

  async delivery(deliveryId: string): Promise<DeliveryReceiptWire> {
    parseProtocolId(deliveryId);
    const record = await this.#store.current(deliveryId);
    if (!record) throw new Error('Reference receiver delivery was not found');
    return serializeDeliveryReceipt(record.receipt);
  }

  async ledger(): Promise<readonly LedgerCreditView[]> {
    return (await this.#store.credits()).map((credit) => ({
      requestId: credit.requestId,
      deliveryId: credit.deliveryId,
      amount: credit.amount,
      unit: credit.unit,
      creditCount: 1,
      createdAt: credit.createdAt,
    }));
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    const plans = await this.#store.settlementPlans();
    const records = await Promise.all(plans.map((plan) => this.#store.current(plan.deliveryId)));
    return records.flatMap((record): readonly ProofEvidenceView[] =>
      record === undefined
        ? []
        : [
            {
              deliveryId: record.deliveryId,
              proofSetHash: record.proofSetHash,
              inputYs: [...record.plan.proofYs],
              state:
                record.phase === 'settled'
                  ? 'spent'
                  : record.phase === 'rejected'
                    ? 'unknown'
                    : 'pending',
            },
          ],
    );
  }
}
