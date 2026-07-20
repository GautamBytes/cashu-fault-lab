import {
  AdapterNotApplicableError,
  type AdapterCapabilities,
  type AdapterClient,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import {
  assertReceiptTransition,
  parseDeliveryReceipt,
  type DeliveryReceipt,
} from '@cashu-fault-lab/delivery-core';
import type { Observation } from '@cashu-fault-lab/oracle';
import { createHash } from 'node:crypto';
import type { DriverSendResult, FaultRule, ScenarioDriver } from './runner.js';
import { seededProtocolId } from './seeded-fixture.js';

export interface ExternalFaultEvidence {
  readonly inbound: number;
  readonly forwarded: number;
}

export interface ExternalFaultController {
  reset(): Promise<void>;
  configure(target: string, rule: FaultRule): Promise<void>;
  clear(target?: string): Promise<void>;
  evidence(): Promise<ExternalFaultEvidence>;
  restart?(component: string): Promise<void>;
}

export interface ExternalAdapterScenarioDriverOptions {
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly faults: ExternalFaultController;
  readonly amount: number;
  readonly unit: string;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly senderAlias?: string;
  readonly requestAlias?: string;
}

export class DirectExternalFaultController implements ExternalFaultController {
  async reset(): Promise<void> {}

  async configure(_target: string, _rule: FaultRule): Promise<void> {
    // Direct mode applies no transport faults. Fault configuration is accepted
    // as a no-op so that scenario scripts remain valid for both direct and
    // HTTP-gateway adapter runs.
  }

  async clear(): Promise<void> {}

  async evidence(): Promise<ExternalFaultEvidence> {
    return { inbound: 1, forwarded: 1 };
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function publicHash(label: string, values: readonly (string | number)[]): string {
  const hash = createHash('sha256').update(`cashu-fault-lab/${label}-v1\0`);
  for (const value of values) hash.update(String(value)).update('\0');
  return hash.digest('hex');
}

function sameIdentity(left: DeliveryReceipt, right: DeliveryReceipt): boolean {
  return (
    left.profile === right.profile &&
    left.requestId === right.requestId &&
    left.deliveryId === right.deliveryId &&
    left.payloadHash === right.payloadHash &&
    left.mint === right.mint &&
    left.unit === right.unit &&
    left.amount === right.amount
  );
}

function exactCredit(
  values: readonly LedgerCreditView[],
  receipt: DeliveryReceipt,
): LedgerCreditView {
  const related = values.filter(
    (value) => value.requestId === receipt.requestId || value.deliveryId === receipt.deliveryId,
  );
  const credit = related[0];
  if (
    related.length !== 1 ||
    credit === undefined ||
    credit.requestId !== receipt.requestId ||
    credit.deliveryId !== receipt.deliveryId ||
    credit.amount !== receipt.amount ||
    credit.unit !== receipt.unit ||
    credit.creditCount !== 1
  ) {
    throw new Error('External receiver did not report exactly one matching merchant credit');
  }
  return credit;
}

function exactProof(values: readonly ProofEvidenceView[], deliveryId: string): ProofEvidenceView {
  const related = values.filter((value) => value.deliveryId === deliveryId);
  const proof = related[0];
  if (
    related.length !== 1 ||
    proof === undefined ||
    proof.state !== 'spent' ||
    proof.inputYs.length === 0
  ) {
    throw new Error('External receiver did not report one spent input proof set');
  }
  return proof;
}

async function adapterCall<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AdapterNotApplicableError) throw error;
    throw new Error(`External adapter ${label} failed`);
  }
}

export class ExternalAdapterScenarioDriver implements ScenarioDriver {
  readonly #sender: AdapterClient;
  readonly #receiver: AdapterClient;
  readonly #faults: ExternalFaultController;
  readonly #amount: number;
  readonly #unit: string;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #senderAlias: string | undefined;
  readonly #requestAlias: string | undefined;
  #seed = '';
  #request: PaymentRequestView | undefined;
  #senderCapabilities: AdapterCapabilities | undefined;
  #receiverCapabilities: AdapterCapabilities | undefined;

  constructor(options: ExternalAdapterScenarioDriverOptions) {
    this.#sender = options.sender;
    this.#receiver = options.receiver;
    this.#faults = options.faults;
    this.#amount = positiveSafeInteger(options.amount, 'amount');
    if (options.unit.length === 0) throw new Error('unit is required');
    this.#unit = options.unit;
    this.#maxAttempts = positiveSafeInteger(options.maxAttempts ?? 3, 'maxAttempts');
    this.#retryDelayMs = positiveSafeInteger(options.retryDelayMs ?? 100, 'retryDelayMs');
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#senderAlias = options.senderAlias;
    this.#requestAlias = options.requestAlias;
  }

  async reset(seed: string): Promise<void> {
    this.#seed = seed;
    this.#request = undefined;
    this.#senderCapabilities = undefined;
    this.#receiverCapabilities = undefined;
    await this.#faults.reset();
    await adapterCall('receiver reset', () => this.#receiver.reset(seed));
    await adapterCall('sender reset', () => this.#sender.reset(seed));
    const request = await adapterCall('receiver request creation', () =>
      this.#receiver.createRequest({
        amount: this.#amount,
        unit: this.#unit,
        transports: ['http'],
        singleUse: true,
        expiresIn: 900,
      }),
    );
    if (
      request.amount !== this.#amount ||
      request.unit !== this.#unit ||
      !request.singleUse ||
      !request.transports.some((transport) => transport.type === 'post')
    ) {
      throw new Error('External receiver request does not match the scenario payment');
    }
    this.#request = request;
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    this.#senderCapabilities = await adapterCall('sender capability discovery', () =>
      this.#sender.capabilities(),
    );
    this.#receiverCapabilities = await adapterCall('receiver capability discovery', () =>
      this.#receiver.capabilities(),
    );
    return {
      sender: {
        implementation: this.#senderCapabilities.implementation,
        version: this.#senderCapabilities.version,
      },
      receiver: {
        implementation: this.#receiverCapabilities.implementation,
        version: this.#receiverCapabilities.version,
      },
      transport: 'http',
      evidenceTier: 'T1',
    };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    try {
      await this.#faults.configure(target, rule);
    } catch {
      throw new Error('External fault configuration failed');
    }
  }

  async send(sender: string, requestId: string): Promise<DriverSendResult> {
    const request = this.#request;
    const senderCapabilities = this.#senderCapabilities;
    if (request === undefined || senderCapabilities === undefined) {
      throw new Error('External scenario driver is not initialized');
    }
    if (
      sender !== (this.#senderAlias ?? senderCapabilities.implementation) ||
      requestId !== (this.#requestAlias ?? request.id)
    ) {
      throw new Error('Scenario sender or request does not match the selected adapter pair');
    }

    const deliveryId = seededProtocolId(
      this.#seed,
      `external-delivery:${senderCapabilities.implementation}:${request.id}`,
    );
    let sent: DeliveryReceipt | undefined;
    let sendAttempts = 0;
    for (; sendAttempts < this.#maxAttempts; sendAttempts += 1) {
      try {
        sent = parseDeliveryReceipt(await this.#sender.send({ request: request.raw, deliveryId }));
        sendAttempts += 1;
        break;
      } catch (error) {
        if (error instanceof AdapterNotApplicableError) throw error;
        if (sendAttempts + 1 === this.#maxAttempts) {
          throw new Error('External sender did not return a receipt after retry attempts');
        }
        await this.#sleep(Math.min(this.#retryDelayMs * 2 ** sendAttempts, 5_000));
      }
    }
    if (sent === undefined) throw new Error('External sender did not return a receipt');
    if (
      sent.requestId !== request.id ||
      sent.deliveryId !== deliveryId ||
      sent.amount !== request.amount ||
      sent.unit !== request.unit
    ) {
      throw new Error('External sender receipt does not match the scenario payment');
    }

    const observed = parseDeliveryReceipt(
      await adapterCall('receiver delivery lookup', () => this.#receiver.delivery(deliveryId)),
    );
    if (!sameIdentity(sent, observed)) {
      throw new Error('External sender and receiver receipt identities conflict');
    }
    try {
      assertReceiptTransition(sent, observed);
    } catch {
      throw new Error('External receiver receipt transition is invalid');
    }
    if (observed.status !== 'settled') {
      throw new Error('External receiver did not reach a settled state');
    }

    const credit = exactCredit(
      await adapterCall('receiver ledger evidence', () => this.#receiver.ledger()),
      observed,
    );
    const proof = exactProof(
      await adapterCall('receiver proof evidence', () => this.#receiver.proofs()),
      observed.deliveryId,
    );
    let faultEvidence: ExternalFaultEvidence;
    try {
      faultEvidence = await this.#faults.evidence();
    } catch {
      throw new Error('External fault evidence collection failed');
    }
    const transportAttempts = positiveSafeInteger(
      Math.max(faultEvidence.inbound, faultEvidence.forwarded),
      'transport attempts',
    );
    const deliveryObservation = {
      type: 'delivery_attempted',
      requestId: observed.requestId,
      deliveryId: observed.deliveryId,
      payloadHash: observed.payloadHash,
      proofSetHash: proof.proofSetHash,
      transport: 'http',
    } as const;
    const creditId = publicHash('external-credit', [
      credit.requestId,
      credit.deliveryId,
      credit.createdAt,
    ]);
    // T1 cannot prove possession of replacement proofs. This opaque witness only binds
    // the oracle's settlement identity to the one adapter-reported credit and proof set.
    const settlementWitness = publicHash('external-settlement-witness', [
      creditId,
      proof.proofSetHash,
    ]);
    const observations: Observation[] = [
      { type: 'request_observed', requestId: request.id, singleUse: request.singleUse },
      ...Array.from({ length: transportAttempts }, () => deliveryObservation),
      {
        type: 'redemption_started',
        deliveryId: observed.deliveryId,
        proofSetHash: proof.proofSetHash,
      },
      { type: 'mint_proofs_state', proofSetHash: proof.proofSetHash, state: 'SPENT' },
      {
        type: 'receiver_settled',
        deliveryId: observed.deliveryId,
        replacementPlanHash: settlementWitness,
      },
      {
        type: 'merchant_credited',
        creditId,
        requestId: credit.requestId,
        deliveryId: credit.deliveryId,
        amount: credit.amount,
        unit: credit.unit,
      },
      {
        type: 'receipt_observed',
        requestId: observed.requestId,
        deliveryId: observed.deliveryId,
        payloadHash: observed.payloadHash,
        status: observed.status,
        detailCode: observed.detailCode,
        version: observed.statusVersion,
        amount: observed.amount,
        unit: observed.unit,
      },
    ];
    return {
      value: {
        status: observed.status,
        deliveryId: observed.deliveryId,
        controlAttempts: sendAttempts,
        transportAttempts,
        creditCount: credit.creditCount,
        proofSetHash: proof.proofSetHash,
      },
      observations,
    };
  }

  async restart(_component: string): Promise<void> {
    if (this.#faults.restart !== undefined) {
      await this.#faults.restart(_component);
    }
  }

  async clearFaults(target?: string): Promise<void> {
    try {
      await this.#faults.clear(target);
    } catch {
      throw new Error('External fault cleanup failed');
    }
  }
}
