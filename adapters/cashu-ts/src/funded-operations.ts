import {
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestTransport,
} from '@cashu/cashu-ts';
import {
  AdapterNotApplicableError,
  currentAdapterContract,
  developmentIdentity,
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
  noopCrashCheckpoint,
  normalizeMintUrl,
  parseDeliveryNegotiation,
  parseDeliveryReceipt,
  parseProtocolId,
  serializeDeliveryPayload,
  type CrashCheckpoint,
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
  readonly proofEvidence?: ProofEvidenceView;
  readonly settledMarked: boolean;
}

export interface CashuTsStoredReservation {
  readonly deliveryId: string;
  readonly requestFingerprint: string;
  readonly reserved: ReservedCashuTsProofs;
  readonly proofEvidence: ProofEvidenceView;
}

export type CashuTsDeliveryStoreDurability = 'process-local' | 'persistent';

export interface CashuTsDeliveryStore {
  readonly durability?: CashuTsDeliveryStoreDurability;
  reset(seed: string): Promise<void>;
  get(deliveryId: string): Promise<CashuTsStoredDelivery | undefined>;
  put(record: CashuTsStoredDelivery): Promise<void>;
  list(): Promise<readonly CashuTsStoredDelivery[]>;
  getReservation?(deliveryId: string): Promise<CashuTsStoredReservation | undefined>;
  putReservation?(reservation: CashuTsStoredReservation): Promise<void>;
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
    ...(record.proofEvidence === undefined
      ? {}
      : {
          proofEvidence: {
            ...record.proofEvidence,
            inputYs: [...record.proofEvidence.inputYs],
          },
        }),
  };
}

export class MemoryCashuTsDeliveryStore implements CashuTsDeliveryStore {
  readonly durability = 'process-local' as const;
  readonly #records = new Map<string, CashuTsStoredDelivery>();
  readonly #reservations = new Map<string, CashuTsStoredReservation>();

  async reset(): Promise<void> {
    this.#records.clear();
    this.#reservations.clear();
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

  async getReservation(deliveryId: string): Promise<CashuTsStoredReservation | undefined> {
    const value = this.#reservations.get(deliveryId);
    return value === undefined ? undefined : structuredClone(value);
  }

  async putReservation(reservation: CashuTsStoredReservation): Promise<void> {
    const previous = this.#reservations.get(reservation.deliveryId);
    if (previous !== undefined && previous.requestFingerprint !== reservation.requestFingerprint) {
      throw new Error('Cashu delivery reservation identity conflicts');
    }
    this.#reservations.set(reservation.deliveryId, structuredClone(previous ?? reservation));
  }
}

export interface FundedCashuTsOperationsOptions {
  readonly wallet: CashuTsWalletPort;
  readonly transport: CashuTsTransportPort;
  readonly store?: CashuTsDeliveryStore;
  readonly now: () => number;
  readonly crashCheckpoint?: CrashCheckpoint;
  readonly supportedTransports?: readonly AdapterTransport[];
}

interface ParsedRequest {
  readonly id: string;
  readonly amount: number;
  readonly unit: string;
  readonly mints: readonly string[];
  readonly transports: readonly CashuTsTransportTarget[];
  readonly expiresAt: number;
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

function parseRequest(encoded: string, now: number): ParsedRequest {
  let request: PaymentRequest;
  try {
    request = PaymentRequest.fromEncodedRequest(encoded);
  } catch {
    throw new Error('Cashu payment request is invalid');
  }
  const negotiated = (request.transport ?? []).flatMap((transport) => {
    const target = transportTarget(transport);
    if (target === undefined) return [];
    const negotiation = parseDeliveryNegotiation(transport.tags ?? [], now);
    return negotiation === undefined ? [] : [{ target, negotiation }];
  });
  if (
    request.id === undefined ||
    request.amount === undefined ||
    request.unit === undefined ||
    request.mints === undefined ||
    request.mints.length === 0 ||
    !request.singleUse ||
    negotiated.length === 0
  ) {
    throw new Error('Cashu payment request is incomplete');
  }
  const amount = request.amount.toNumber();
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error('Cashu payment request amount is invalid');
  }
  parseProtocolId(request.id);
  const expiresAt = negotiated[0]!.negotiation.expiresAt;
  if (negotiated.some((entry) => entry.negotiation.expiresAt !== expiresAt)) {
    throw new Error('Cashu payment request transport expiries conflict');
  }
  return {
    id: request.id,
    amount,
    unit: request.unit,
    mints: request.mints.map(normalizeMintUrl),
    transports: negotiated.map((entry) => entry.target),
    expiresAt,
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
  readonly #crashCheckpoint: CrashCheckpoint;
  readonly #supportedTransports: readonly AdapterTransport[];
  readonly #inflight = new Map<string, InflightSend>();
  #seed = '';
  #ordinal = 0;

  constructor(options: FundedCashuTsOperationsOptions) {
    this.#wallet = options.wallet;
    this.#transport = options.transport;
    this.#store = options.store ?? new MemoryCashuTsDeliveryStore();
    this.#now = options.now;
    this.#crashCheckpoint = options.crashCheckpoint ?? noopCrashCheckpoint;
    this.#supportedTransports = supportedTransports(options.supportedTransports);
  }

  async capabilities(): Promise<AdapterCapabilities> {
    const persistent = this.#store.durability === 'persistent';
    return {
      schemaVersion: 2,
      contract: currentAdapterContract(),
      implementation: developmentIdentity({
        id: 'cashu-ts',
        version: '4.7.2',
        language: 'typescript',
        runtime: 'node-24',
      }),
      roles: {
        sender: {
          transports: this.#supportedTransports,
          profiles: ['delivery-v1'],
          durability: persistent ? 'restart_safe' : 'process',
          evidence: {
            tier: 'T1',
            sources: persistent
              ? ['adapter', 'runner', 'transport', 'durable_state']
              : ['adapter', 'runner', 'transport'],
          },
        },
      },
      nuts: [3, 7, 18],
      encodings: ['creqA', 'creqB'],
      mints: [],
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

  async resume(seed: string): Promise<void> {
    if (seed.length === 0) throw new Error('Cashu funded adapter seed is required');
    this.#seed = seed;
    this.#ordinal = 0;
    this.#inflight.clear();
    await this.#wallet.reset(seed);
  }

  async send(input: SendPaymentInput): Promise<DeliveryReceiptView> {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Cashu adapter time is invalid');
    const parsed = parseRequest(input.request, now);
    const transports = parsed.transports.filter((transport) =>
      this.#supportedTransports.includes(adapterTransport(transport)),
    );
    if (transports.length === 0) {
      throw new Error('Cashu payment request does not contain a supported transport');
    }
    const request: ParsedRequest = { ...parsed, transports };
    const requestFingerprint = fingerprint(input.request, input.memo);
    const deliveryId =
      input.deliveryId === undefined
        ? this.#nextDeliveryId(request.id)
        : parseProtocolId(input.deliveryId);
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

  #nextDeliveryId(requestId: string): string {
    if (this.#seed.length === 0) {
      throw new Error('Cashu funded adapter must be reset first');
    }
    return protocolId(this.#seed, requestId, this.#ordinal++);
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
      await this.#crashCheckpoint.hit('sender_before_proof_reservation', deliveryId);
      let reservation = await this.#store.getReservation?.(deliveryId);
      if (reservation !== undefined && reservation.requestFingerprint !== requestFingerprint) {
        throw new Error('Delivery ID is already bound to another payment request');
      }
      if (reservation === undefined) {
        if (this.#seed.length === 0) throw new Error('Cashu funded adapter must be reset first');
        const reserved = await this.#wallet.reserve(
          request.amount,
          request.unit,
          request.mints,
          deliveryId,
        );
        reservation = {
          deliveryId,
          requestFingerprint,
          reserved,
          proofEvidence: await this.#wallet.evidence(deliveryId),
        };
        await this.#store.putReservation?.(reservation);
      }
      await this.#crashCheckpoint.hit(
        'sender_after_reservation_before_payload_persistence',
        deliveryId,
      );
      const reserved = reservation.reserved;
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
          expiresAt: request.expiresAt,
        },
      };
      const payloadBytes = serializeDeliveryPayload(payload);
      const proofEvidence = reservation.proofEvidence;
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
        proofEvidence,
        settledMarked: false,
      };
      // Persist the proof-bearing exact bytes before the first network attempt.
      await this.#store.put(record);
      await this.#crashCheckpoint.hit(
        'sender_after_payload_persistence_before_network_send',
        deliveryId,
      );
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
    } catch (error) {
      throw new Error('Cashu payment delivery failed', { cause: error });
    }
    await this.#crashCheckpoint.hit('sender_after_send_before_response', deliveryId);
    assertReceiptIdentity(receipt, record);
    const parsedReceipt = parseDeliveryReceipt(receipt);
    if (record.receipt !== undefined) {
      assertReceiptTransition(parseDeliveryReceipt(record.receipt), parsedReceipt);
    }
    let settledMarked = record.settledMarked;
    let proofEvidence = record.proofEvidence;
    if (parsedReceipt.status === 'settled' && !settledMarked) {
      try {
        await this.#wallet.markSettled(deliveryId);
      } catch (error) {
        if (proofEvidence === undefined) throw error;
      }
      settledMarked = true;
      if (proofEvidence !== undefined) {
        proofEvidence = { ...proofEvidence, inputYs: [...proofEvidence.inputYs], state: 'spent' };
      }
    }
    const updated: CashuTsStoredDelivery = {
      ...record,
      receipt,
      ...(proofEvidence === undefined ? {} : { proofEvidence }),
      settledMarked,
    };
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
    return Promise.all(
      records.map((record) =>
        record.proofEvidence === undefined
          ? this.#wallet.evidence(record.deliveryId)
          : {
              ...record.proofEvidence,
              inputYs: [...record.proofEvidence.inputYs],
            },
      ),
    );
  }
}
