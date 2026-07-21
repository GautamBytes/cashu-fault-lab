import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import {
  AdapterNotApplicableError,
  type AdapterCapabilities,
  type CreateRequestInput,
  type DeliveryReceiptView,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import {
  normalizeMintUrl,
  parseProtocolId,
  serializeDeliveryReceipt,
  type DeliveryReceiptWire,
} from '@cashu-fault-lab/delivery-core';
import {
  acceptPayloadBytes,
  CashuTsMintGateway,
  CashuTsProofVerifier,
  MemoryReceiverStore,
  type AcceptDeliveryDependencies,
  type MintFetch,
  type MintGateway,
  type ProofVerifier,
  type ReceiverStore,
} from '@cashu-fault-lab/reference-receiver';
import { createHash } from 'node:crypto';
import {
  FundedCashuTsOperations,
  type FundedCashuTsOperationsOptions,
} from './funded-operations.js';
import type { CashuTsAdapterOperations } from './server.js';

const CASHU_TS_VERSION = '4.7.2';

type ResettableReceiverStore = ReceiverStore & { reset(): Promise<void> };

export interface FundedCashuTsReceiverOperationsOptions {
  readonly mintUrl: string;
  readonly paymentTarget: string;
  readonly now: () => number;
  readonly proofClaimKey?: Uint8Array;
  readonly fetch?: MintFetch;
  readonly store?: ResettableReceiverStore;
  readonly mint?: MintGateway;
  readonly verifier?: ProofVerifier;
}

export interface FundedCashuTsDualRoleOperationsOptions {
  readonly sender: FundedCashuTsOperations | FundedCashuTsOperationsOptions;
  readonly receiver: FundedCashuTsReceiverOperations;
}

function protocolId(seed: string, ordinal: number): string {
  return parseProtocolId(
    createHash('sha256')
      .update('cashu-fault-lab/cashu-ts-receiver-request-v1\0')
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
    throw new Error('cashu-ts receiver payment target is invalid');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('cashu-ts receiver payment target is invalid');
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

function proofVerifier(options: FundedCashuTsReceiverOperationsOptions): ProofVerifier {
  if (options.verifier !== undefined) return options.verifier;
  if (options.proofClaimKey === undefined) {
    throw new Error('cashu-ts receiver proof claim key is required');
  }
  return new CashuTsProofVerifier({
    proofClaimKey: options.proofClaimKey,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export class FundedCashuTsReceiverOperations {
  readonly #store: ResettableReceiverStore;
  readonly #mintUrl: string;
  readonly #paymentTarget: string;
  readonly #now: () => number;
  readonly #accept: AcceptDeliveryDependencies;
  #seed = '';
  #ordinal = 0;

  constructor(options: FundedCashuTsReceiverOperationsOptions) {
    this.#store = options.store ?? new MemoryReceiverStore();
    this.#mintUrl = normalizeMintUrl(options.mintUrl);
    this.#paymentTarget = paymentTarget(options.paymentTarget);
    this.#now = options.now;
    this.#accept = {
      store: this.#store,
      mint:
        options.mint ??
        new CashuTsMintGateway({
          now: options.now,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      verifier: proofVerifier(options),
      now: options.now,
    };
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'cashu-ts',
      version: CASHU_TS_VERSION,
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
    if (seed.length === 0) throw new Error('cashu-ts receiver seed is required');
    await this.#store.reset();
    this.#seed = seed;
    this.#ordinal = 0;
  }

  async createRequest(input: CreateRequestInput): Promise<PaymentRequestView> {
    if (this.#seed.length === 0) throw new Error('cashu-ts receiver must be reset first');
    if (
      input.amount < 1 ||
      input.unit.length === 0 ||
      !input.singleUse ||
      input.transports.length !== 1 ||
      input.transports[0] !== 'http'
    ) {
      throw new Error('cashu-ts receiver request is unsupported');
    }
    const now = this.#now();
    const expiresAt = now + input.expiresIn;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt)) {
      throw new Error('cashu-ts receiver time is invalid');
    }
    const id = protocolId(this.#seed, this.#ordinal);
    this.#ordinal += 1;
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

  async receive(payloadBytes: Uint8Array): Promise<DeliveryReceiptWire> {
    return serializeDeliveryReceipt(await acceptPayloadBytes(payloadBytes, this.#accept));
  }

  async delivery(deliveryId: string): Promise<DeliveryReceiptView> {
    parseProtocolId(deliveryId);
    const record = await this.#store.current(deliveryId);
    if (record === undefined) {
      throw new AdapterNotApplicableError('No receiver delivery has been observed');
    }
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

export class FundedCashuTsDualRoleOperations implements CashuTsAdapterOperations {
  readonly #sender: FundedCashuTsOperations;
  readonly #receiver: FundedCashuTsReceiverOperations;

  constructor(options: FundedCashuTsDualRoleOperationsOptions) {
    this.#sender =
      options.sender instanceof FundedCashuTsOperations
        ? options.sender
        : new FundedCashuTsOperations(options.sender);
    this.#receiver = options.receiver;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    return {
      implementation: 'cashu-ts',
      version: CASHU_TS_VERSION,
      nuts: [2, 3, 7, 9, 12, 18, 19],
      transports: ['http'],
      evidenceTier: 'T1',
      encodings: ['creqA', 'creqB'],
      profiles: [
        { name: 'delivery-v1', roles: ['sender', 'receiver'], status: 'supported' },
        {
          name: 'legacy-nut18',
          roles: ['sender', 'receiver'],
          status: 'unsupported',
          reason: 'Funded operations require the delivery-v1 idempotency extension',
        },
        {
          name: 'nut26-nostr',
          roles: ['sender', 'receiver'],
          status: 'unsupported',
          reason: 'Funded operations currently implement HTTP delivery only',
        },
      ],
    };
  }

  async reset(seed: string): Promise<void> {
    await this.#receiver.reset(seed);
    await this.#sender.reset(seed);
  }

  createRequest(input: CreateRequestInput): Promise<PaymentRequestView> {
    return this.#receiver.createRequest(input);
  }

  send(input: Parameters<FundedCashuTsOperations['send']>[0]): Promise<DeliveryReceiptView> {
    return this.#sender.send(input);
  }

  receive(payloadBytes: Uint8Array): Promise<DeliveryReceiptView> {
    return this.#receiver.receive(payloadBytes);
  }

  async delivery(deliveryId: string): Promise<DeliveryReceiptView> {
    try {
      return await this.#receiver.delivery(deliveryId);
    } catch (error) {
      if (!(error instanceof AdapterNotApplicableError)) throw error;
      return this.#sender.delivery(deliveryId);
    }
  }

  ledger(): Promise<readonly LedgerCreditView[]> {
    return this.#receiver.ledger();
  }

  async proofs(): Promise<readonly ProofEvidenceView[]> {
    const receiverProofs = await this.#receiver.proofs();
    const receiverDeliveryIds = new Set(receiverProofs.map((proof) => proof.deliveryId));
    const senderProofs = await this.#sender.proofs();
    return [
      ...receiverProofs,
      ...senderProofs.filter((proof) => !receiverDeliveryIds.has(proof.deliveryId)),
    ];
  }
}
