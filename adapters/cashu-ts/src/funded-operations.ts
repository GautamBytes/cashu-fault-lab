import {
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestTransport,
} from '@cashu/cashu-ts';
import {
  AdapterNotApplicableError,
  type AdapterCapabilities,
  type AdapterTransport,
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
  send(target: CashuTsTransportTarget, body: Uint8Array): Promise<DeliveryReceiptView>;
}

export interface CashuTsTransportTarget {
  readonly type: 'post' | 'nostr';
  readonly target: string;
  readonly tags?: readonly (readonly string[])[];
}

export interface CashuTsStoredDelivery {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly target: string;
  readonly transports: readonly CashuTsTransportTarget[];
  readonly attempts: number;
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
    transports: record.transports.map((transport) => ({
      ...transport,
      ...(transport.tags === undefined ? {} : { tags: transport.tags.map((tag) => [...tag]) }),
    })),
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
  readonly supportedTransports?: readonly AdapterTransport[];
}

interface ParsedRequest {
  readonly id: string;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
  readonly transports: readonly CashuTsTransportTarget[];
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

function transportTarget(transport: PaymentRequestTransport): CashuTsTransportTarget | undefined {
  if (transport.type === PaymentRequestTransportType.POST) {
    return { type: 'post', target: transport.target };
  }
  if (transport.type === PaymentRequestTransportType.NOSTR) {
    return {
      type: 'nostr',
      target: transport.target,
      ...(transport.tags === undefined ? {} : { tags: transport.tags.map((tag) => [...tag]) }),
    };
  }
  return undefined;
}

function adapterTransport(transport: CashuTsTransportTarget): AdapterTransport {
  return transport.type === 'post' ? 'http' : 'nostr';
}

function parseRequest(encoded: string): ParsedRequest {
  let request: PaymentRequest;
  try {
    request = PaymentRequest.fromEncodedRequest(encoded);
  } catch {
    throw new Error('Cashu payment request is invalid');
  }
  const transports = (request.transport ?? []).flatMap((transport) => {
    const target = transportTarget(transport);
    return target === undefined ? [] : [target];
  });
  if (
    request.id === undefined ||
    request.amount === undefined ||
    request.unit === undefined ||
    request.mints === undefined ||
    request.mints.length === 0 ||
    !request.singleUse ||
    transports.length === 0
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
    transports,
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

function supportedTransports(
  values: readonly AdapterTransport[] | undefined,
): readonly AdapterTransport[] {
  const transports: AdapterTransport[] = [...new Set(values ?? (['http'] as const))];
  if (
    transports.length < 1 ||
    transports.some((transport) => transport !== 'http' && transport !== 'nostr')
  ) {
    throw new Error('Cashu funded adapter supported transports are invalid');
  }
  return transports;
}

export class FundedCashuTsOperations implements CashuTsAdapterOperations {
  readonly #wallet: CashuTsWalletPort;
  readonly #transport: CashuTsTransportPort;
  readonly #store: CashuTsDeliveryStore;
  readonly #now: () => number;
  readonly #supportedTransports: readonly AdapterTransport[];
  readonly #inflight = new Map<string, InflightSend>();
  #seed = '';
  #ordinal = 0;

  constructor(options: FundedCashuTsOperationsOptions) {
    this.#wallet = options.wallet;
    this.#transport = options.transport;
    this.#store = options.store ?? new MemoryCashuTsDeliveryStore();
    this.#now = options.now;
    this.#supportedTransports = supportedTransports(options.supportedTransports);
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'cashu-ts',
      version: '4.7.2',
      nuts: [3, 7, 18],
      transports: this.#supportedTransports,
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
          reason: 'Funded operations use NUT-18 NIP-17 delivery-v1, not upstream NUT-26',
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
    const parsed = parseRequest(input.request);
    const transports = parsed.transports.filter((transport) =>
      this.#supportedTransports.includes(adapterTransport(transport)),
    );
    if (transports.length === 0) {
      throw new Error('Cashu payment request does not contain a supported transport');
    }
    const request: ParsedRequest = { ...parsed, transports };
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
        target: request.transports[0]!.target,
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
        transports: request.transports,
        attempts: 0,
        settledMarked: false,
      };
      // Persist the proof-bearing exact bytes before the first network attempt.
      await this.#store.put(record);
    }

    const selectedTarget =
      record.transports[Math.min(record.attempts, record.transports.length - 1)]!;
    record = {
      ...record,
      target: selectedTarget.target,
      attempts: record.attempts + 1,
    };
    await this.#store.put(record);

    let receipt: DeliveryReceiptView;
    try {
      receipt = await this.#transport.send(selectedTarget, record.payloadBytes);
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
