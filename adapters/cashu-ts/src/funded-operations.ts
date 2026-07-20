import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import {
  AdapterNotApplicableError,
  type AdapterCapabilities,
  type DeliveryReceiptView,
  type LedgerCreditView,
  type ProofEvidenceView,
  type SendPaymentInput,
} from '@cashu-fault-lab/adapter-contract';
import {
  assertReceiptTransition,
  computePayloadHash,
  normalizeMintUrl,
  parseDeliveryReceipt,
  parseProtocolId,
  serializeDeliveryPayload,
  type CashuProof,
  type DeliveryPayload,
} from '@cashu-fault-lab/delivery-core';
import { createHash } from 'node:crypto';
import type { CashuTsAdapterOperations } from './server.js';

export interface ReservedCashuTsProofs {
  readonly mint: string;
  readonly proofs: readonly CashuProof[];
}

export interface CashuTsWalletPort {
  reset(seed: string): Promise<void>;
  reserve(
    amount: number,
    unit: string,
    mints: readonly string[],
    deliveryId: string,
  ): Promise<ReservedCashuTsProofs>;
  markSettled(deliveryId: string): Promise<void>;
  evidence(deliveryId: string): Promise<ProofEvidenceView>;
}

export interface CashuTsTransportPort {
  post(target: string, body: Uint8Array): Promise<DeliveryReceiptView>;
}

export interface CashuTsStoredDelivery {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly target: string;
  readonly payloadBytes: Uint8Array;
  readonly payloadHash: string;
  readonly mint: string;
  readonly unit: string;
  readonly amount: number;
  readonly receipt?: DeliveryReceiptView;
  readonly settledMarked: boolean;
}

export interface CashuTsDeliveryStore {
  reset(seed: string): Promise<void>;
  get(deliveryId: string): Promise<CashuTsStoredDelivery | undefined>;
  put(record: CashuTsStoredDelivery): Promise<void>;
  list(): Promise<readonly CashuTsStoredDelivery[]>;
}

function cloneRecord(record: CashuTsStoredDelivery): CashuTsStoredDelivery {
  return {
    ...record,
    payloadBytes: Uint8Array.from(record.payloadBytes),
    ...(record.receipt === undefined ? {} : { receipt: structuredClone(record.receipt) }),
  };
}

export class MemoryCashuTsDeliveryStore implements CashuTsDeliveryStore {
  readonly #records = new Map<string, CashuTsStoredDelivery>();

  async reset(): Promise<void> {
    this.#records.clear();
  }

  async get(deliveryId: string): Promise<CashuTsStoredDelivery | undefined> {
    const record = this.#records.get(deliveryId);
    return record === undefined ? undefined : cloneRecord(record);
  }

  async put(record: CashuTsStoredDelivery): Promise<void> {
    this.#records.set(record.deliveryId, cloneRecord(record));
  }

  async list(): Promise<readonly CashuTsStoredDelivery[]> {
    return [...this.#records.values()].map(cloneRecord);
  }
}

export interface FundedCashuTsOperationsOptions {
  readonly wallet: CashuTsWalletPort;
  readonly transport: CashuTsTransportPort;
  readonly store?: CashuTsDeliveryStore;
  readonly now: () => number;
}

interface ParsedRequest {
  readonly id: string;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
  readonly target: string;
}

interface InflightSend {
  readonly requestFingerprint: string;
  readonly result: Promise<DeliveryReceiptView>;
}

function protocolId(seed: string, requestId: string, ordinal: number): string {
  return parseProtocolId(
    createHash('sha256')
      .update('cashu-fault-lab/cashu-ts-funded-delivery-v1\0')
      .update(seed)
      .update('\0')
      .update(requestId)
      .update('\0')
      .update(String(ordinal))
      .digest()
      .subarray(0, 16)
      .toString('base64url'),
  );
}

function fingerprint(request: string, memo: string | null | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify([request, memo ?? null]))
    .digest('hex');
}

function parseRequest(encoded: string): ParsedRequest {
  let request: PaymentRequest;
  try {
    request = PaymentRequest.fromEncodedRequest(encoded);
  } catch {
    throw new Error('Cashu payment request is invalid');
  }
  const transport = request.getTransport(PaymentRequestTransportType.POST);
  if (
    request.id === undefined ||
    request.amount === undefined ||
    request.unit === undefined ||
    request.mints === undefined ||
    request.mints.length === 0 ||
    !request.singleUse ||
    transport === undefined
  ) {
    throw new Error('Cashu payment request is incomplete');
  }
  const amount = request.amount.toNumber();
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Cashu payment request amount is invalid');
  }
  parseProtocolId(request.id);
  return {
    id: request.id,
    amount,
    unit: request.unit,
    mints: request.mints.map(normalizeMintUrl),
    target: transport.target,
  };
}

function assertReceiptIdentity(receipt: DeliveryReceiptView, record: CashuTsStoredDelivery): void {
  const parsed = parseDeliveryReceipt(receipt);
  if (
    parsed.requestId !== record.requestId ||
    parsed.deliveryId !== record.deliveryId ||
    parsed.payloadHash !== record.payloadHash ||
    parsed.mint !== record.mint ||
    parsed.unit !== record.unit ||
    parsed.amount !== record.amount
  ) {
    throw new Error('Cashu receiver receipt does not match the persisted payment');
  }
}

export class FundedCashuTsOperations implements CashuTsAdapterOperations {
  readonly #wallet: CashuTsWalletPort;
  readonly #transport: CashuTsTransportPort;
  readonly #store: CashuTsDeliveryStore;
  readonly #now: () => number;
  readonly #inflight = new Map<string, InflightSend>();
  #seed = '';
  #ordinal = 0;

  constructor(options: FundedCashuTsOperationsOptions) {
    this.#wallet = options.wallet;
    this.#transport = options.transport;
    this.#store = options.store ?? new MemoryCashuTsDeliveryStore();
    this.#now = options.now;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'cashu-ts',
      version: '4.7.2',
      nuts: [3, 7, 18],
      transports: ['http'],
      evidenceTier: 'T1',
      encodings: ['creqA', 'creqB'],
      profiles: [
        {
          name: 'legacy-nut18',
          roles: ['sender'],
          status: 'unsupported',
          reason: 'Funded operations require the delivery-v1 idempotency extension',
        },
        { name: 'delivery-v1', roles: ['sender'], status: 'supported' },
        {
          name: 'nut26-nostr',
          roles: ['sender'],
          status: 'unsupported',
          reason: 'Funded operations currently implement HTTP delivery only',
        },
      ],
    };
  }

  async reset(seed: string): Promise<void> {
    if (seed.length === 0) throw new Error('Cashu funded adapter seed is required');
    this.#seed = seed;
    this.#ordinal = 0;
    this.#inflight.clear();
    await this.#store.reset(seed);
    await this.#wallet.reset(seed);
  }

  async send(input: SendPaymentInput): Promise<DeliveryReceiptView> {
    if (this.#seed.length === 0) throw new Error('Cashu funded adapter must be reset first');
    const request = parseRequest(input.request);
    const requestFingerprint = fingerprint(input.request, input.memo);
    const deliveryId = input.deliveryId ?? protocolId(this.#seed, request.id, this.#ordinal++);
    parseProtocolId(deliveryId);
    const inflight = this.#inflight.get(deliveryId);
    if (inflight !== undefined) {
      if (inflight.requestFingerprint !== requestFingerprint) {
        throw new Error('Delivery ID is already bound to another payment request');
      }
      return inflight.result;
    }
    const result = this.#sendOnce(input, request, requestFingerprint, deliveryId);
    this.#inflight.set(deliveryId, { requestFingerprint, result });
    try {
      return await result;
    } finally {
      this.#inflight.delete(deliveryId);
    }
  }

  async #sendOnce(
    input: SendPaymentInput,
    request: ParsedRequest,
    requestFingerprint: string,
    deliveryId: string,
  ): Promise<DeliveryReceiptView> {
    let record = await this.#store.get(deliveryId);
    if (record !== undefined && record.requestFingerprint !== requestFingerprint) {
      throw new Error('Delivery ID is already bound to another payment request');
    }
    if (record === undefined) {
      const now = this.#now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Cashu adapter time is invalid');
      const reserved = await this.#wallet.reserve(
        request.amount,
        request.unit,
        request.mints,
        deliveryId,
      );
      const mint = normalizeMintUrl(reserved.mint);
      if (!request.mints.includes(mint)) {
        throw new Error('Cashu wallet reserved proofs from an unrequested mint');
      }
      const payload: DeliveryPayload = {
        id: parseProtocolId(request.id),
        memo: input.memo ?? null,
        mint,
        unit: request.unit,
        proofs: reserved.proofs,
        delivery: {
          version: 1,
          id: parseProtocolId(deliveryId),
          createdAt: now,
          expiresAt: now + 900,
        },
      };
      const payloadBytes = serializeDeliveryPayload(payload);
      record = {
        deliveryId,
        requestId: request.id,
        requestFingerprint,
        target: request.target,
        payloadBytes,
        payloadHash: computePayloadHash({
          requestId: payload.id,
          memo: payload.memo,
          mint: payload.mint,
          unit: payload.unit,
          proofs: payload.proofs,
          createdAt: payload.delivery.createdAt,
          expiresAt: payload.delivery.expiresAt,
        }),
        mint: payload.mint,
        unit: payload.unit,
        amount: request.amount,
        settledMarked: false,
      };
      // Persist the proof-bearing exact bytes before the first network attempt.
      await this.#store.put(record);
    }

    let receipt: DeliveryReceiptView;
    try {
      receipt = await this.#transport.post(record.target, record.payloadBytes);
    } catch {
      throw new Error('Cashu payment delivery failed');
    }
    assertReceiptIdentity(receipt, record);
    const parsedReceipt = parseDeliveryReceipt(receipt);
    if (record.receipt !== undefined) {
      assertReceiptTransition(parseDeliveryReceipt(record.receipt), parsedReceipt);
    }
    let settledMarked = record.settledMarked;
    if (parsedReceipt.status === 'settled' && !settledMarked) {
      await this.#wallet.markSettled(deliveryId);
      settledMarked = true;
    }
    const updated: CashuTsStoredDelivery = { ...record, receipt, settledMarked };
    await this.#store.put(updated);
    return receipt;
  }

  async delivery(deliveryId: string): Promise<DeliveryReceiptView> {
    parseProtocolId(deliveryId);
    const record = await this.#store.get(deliveryId);
    if (record?.receipt === undefined) {
      throw new AdapterNotApplicableError('No delivery receipt has been observed');
    }
    return record.receipt;
  }

  async ledger(): Promise<readonly LedgerCreditView[]> {
    throw new AdapterNotApplicableError('Sender-only cashu-ts adapter has no merchant ledger');
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    const records = await this.#store.list();
    return Promise.all(records.map((record) => this.#wallet.evidence(record.deliveryId)));
  }
}
