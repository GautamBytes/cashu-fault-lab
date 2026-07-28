import {
  AdapterClientError,
  AdapterNotApplicableError,
  validateAdapterCompatibility,
  type AdapterCapabilities,
  type CrashArmInput,
  type CrashArmStatus,
  type AdapterTransport,
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
  readonly controller: 'direct' | 'http-gateway';
  readonly observedTarget?: string;
  readonly appliedFaults?: number;
}

export interface ExternalFaultController {
  reset(): Promise<void>;
  configure(target: string, rule: FaultRule): Promise<void>;
  clear(target?: string): Promise<void>;
  evidence(): Promise<ExternalFaultEvidence>;
  restart?(component: string): Promise<void>;
  armCrash?(input: CrashArmInput): Promise<void>;
  crashStatus?(): Promise<readonly CrashArmStatus[]>;
}

export interface ExternalAdapterScenarioDriverOptions {
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly faults: ExternalFaultController;
  readonly amount: number;
  readonly unit: string;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly restartReadinessAttempts?: number;
  readonly restartReadinessDelayMs?: number;
  readonly transports?: readonly AdapterTransport[];
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
    return { inbound: 0, forwarded: 0, controller: 'direct' };
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

function transportViewTypes(request: PaymentRequestView): ReadonlySet<AdapterTransport> {
  return new Set(
    request.transports.map((transport) => (transport.type === 'post' ? 'http' : 'nostr')),
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
    if (error instanceof AdapterClientError) {
      throw new Error(`External adapter ${label} failed: ${error.code} ${error.message}`);
    }
    throw new Error(`External adapter ${label} failed`);
  }
}

function adapterErrorHint(error: unknown): string {
  return error instanceof AdapterClientError ? `: ${error.code} ${error.message}` : '';
}

export class ExternalAdapterScenarioDriver implements ScenarioDriver {
  readonly observationConfidence = 'adapter_claimed' as const;
  readonly #sender: AdapterClient;
  readonly #receiver: AdapterClient;
  readonly #faults: ExternalFaultController;
  readonly #amount: number;
  readonly #unit: string;
  readonly #transports: readonly AdapterTransport[];
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #restartReadinessAttempts: number;
  readonly #restartReadinessDelayMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #senderAlias: string | undefined;
  readonly #requestAlias: string | undefined;
  #seed = '';
  #request: PaymentRequestView | undefined;
  #senderCapabilities: AdapterCapabilities | undefined;
  #receiverCapabilities: AdapterCapabilities | undefined;
  readonly #redeemedDeliveries = new Set<string>();
  readonly #configuredTransportFaults = new Set<string>();
  readonly #armedCrashes: CrashArmInput[] = [];

  constructor(options: ExternalAdapterScenarioDriverOptions) {
    this.#sender = options.sender;
    this.#receiver = options.receiver;
    this.#faults = options.faults;
    this.#amount = positiveSafeInteger(options.amount, 'amount');
    if (options.unit.length === 0) throw new Error('unit is required');
    this.#unit = options.unit;
    this.#transports = [...new Set(options.transports ?? (['http'] as const))];
    if (
      this.#transports.length < 1 ||
      this.#transports.some((transport) => transport !== 'http' && transport !== 'nostr')
    ) {
      throw new Error('External scenario transports are invalid');
    }
    this.#maxAttempts = positiveSafeInteger(options.maxAttempts ?? 3, 'maxAttempts');
    this.#retryDelayMs = positiveSafeInteger(options.retryDelayMs ?? 100, 'retryDelayMs');
    this.#restartReadinessAttempts = positiveSafeInteger(
      options.restartReadinessAttempts ?? 20,
      'restartReadinessAttempts',
    );
    this.#restartReadinessDelayMs = positiveSafeInteger(
      options.restartReadinessDelayMs ?? 500,
      'restartReadinessDelayMs',
    );
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
    this.#redeemedDeliveries.clear();
    this.#configuredTransportFaults.clear();
    this.#armedCrashes.length = 0;
    this.#senderCapabilities = await adapterCall('sender capability discovery', () =>
      this.#sender.capabilities(),
    );
    this.#receiverCapabilities = await adapterCall('receiver capability discovery', () =>
      this.#receiver.capabilities(),
    );
    const senderCompatibility = validateAdapterCompatibility(this.#senderCapabilities);
    if (!senderCompatibility.ok) throw new Error(senderCompatibility.reason);
    const receiverCompatibility = validateAdapterCompatibility(this.#receiverCapabilities);
    if (!receiverCompatibility.ok) throw new Error(receiverCompatibility.reason);
    await this.#faults.reset();
    await adapterCall('receiver reset', () => this.#receiver.reset(seed));
    await adapterCall('sender reset', () => this.#sender.reset(seed));
    const request = await adapterCall('receiver request creation', () =>
      this.#receiver.createRequest({
        amount: this.#amount,
        unit: this.#unit,
        transports: this.#transports,
        singleUse: true,
        expiresIn: 900,
      }),
    );
    if (
      request.amount !== this.#amount ||
      request.unit !== this.#unit ||
      !request.singleUse ||
      this.#transports.some((transport) => !transportViewTypes(request).has(transport))
    ) {
      throw new Error('External receiver request does not match the scenario payment');
    }
    this.#request = request;
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    this.#senderCapabilities ??= await adapterCall('sender capability discovery', () =>
      this.#sender.capabilities(),
    );
    this.#receiverCapabilities ??= await adapterCall('receiver capability discovery', () =>
      this.#receiver.capabilities(),
    );
    return {
      sender: {
        implementation: this.#senderCapabilities.implementation,
        role: this.#senderCapabilities.roles.sender,
        contract: this.#senderCapabilities.contract,
        compatibility: validateAdapterCompatibility(this.#senderCapabilities),
      },
      receiver: {
        implementation: this.#receiverCapabilities.implementation,
        role: this.#receiverCapabilities.roles.receiver,
        contract: this.#receiverCapabilities.contract,
        compatibility: validateAdapterCompatibility(this.#receiverCapabilities),
      },
      transports: this.#transports,
    };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    try {
      await this.#faults.configure(target, rule);
      if (target === 'http' || target === 'nostr') {
        this.#configuredTransportFaults.add(target);
      }
    } catch {
      throw new Error('External fault configuration failed');
    }
  }

  async armCrash(input: CrashArmInput): Promise<void> {
    if (this.#faults.armCrash === undefined || this.#faults.crashStatus === undefined) {
      throw new AdapterNotApplicableError('Selected adapter does not provide crash controls');
    }
    try {
      await this.#faults.armCrash(input);
      const status = await this.#faults.crashStatus();
      const evidence = status.find(
        (item) =>
          item.runId === input.runId &&
          item.component === input.component &&
          item.boundary === input.boundary &&
          item.occurrence === input.occurrence,
      );
      if (evidence === undefined || evidence.hits !== 0 || evidence.consumed) {
        throw new Error('Crash arm evidence does not match the requested checkpoint');
      }
      this.#armedCrashes.push(input);
    } catch (error) {
      if (error instanceof AdapterNotApplicableError) throw error;
      throw new Error('External crash control could not be armed');
    }
  }

  async send(sender: string, requestId: string): Promise<DriverSendResult> {
    const request = this.#request;
    const senderCapabilities = this.#senderCapabilities;
    if (request === undefined || senderCapabilities === undefined) {
      throw new Error('External scenario driver is not initialized');
    }
    if (
      sender !== (this.#senderAlias ?? senderCapabilities.implementation.id) ||
      requestId !== (this.#requestAlias ?? request.id)
    ) {
      throw new Error('Scenario sender or request does not match the selected adapter pair');
    }

    const deliveryId = seededProtocolId(
      this.#seed,
      `external-delivery:${senderCapabilities.implementation.id}:${request.id}`,
    );
    let sent: DeliveryReceipt | undefined;
    let lastSendError: unknown;
    let sendAttempts = 0;
    for (; sendAttempts < this.#maxAttempts; sendAttempts += 1) {
      try {
        sent = parseDeliveryReceipt(await this.#sender.send({ request: request.raw, deliveryId }));
        sendAttempts += 1;
        break;
      } catch (error) {
        if (error instanceof AdapterNotApplicableError) throw error;
        lastSendError = error;
        if (this.#armedCrashes.length > 0) {
          await this.#waitForRestartReadiness(this.#armedCrashes.at(-1)?.component ?? 'sender');
        }
        if (sendAttempts + 1 === this.#maxAttempts) {
          throw new Error(
            `External sender did not return a receipt after retry attempts${adapterErrorHint(lastSendError)}`,
          );
        }
        await this.#sleep(Math.min(this.#retryDelayMs * 2 ** sendAttempts, 5_000));
      }
    }
    if (sent === undefined) throw new Error('External sender did not return a receipt');
    await this.#assertCrashEvidence();
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
    const controllerAttempts = Math.max(faultEvidence.inbound, faultEvidence.forwarded);
    if (
      faultEvidence.appliedFaults !== undefined &&
      (!Number.isSafeInteger(faultEvidence.appliedFaults) || faultEvidence.appliedFaults < 0)
    ) {
      throw new Error('External fault evidence collection failed');
    }
    const configuredFaultWasObserved =
      faultEvidence.controller === 'http-gateway' &&
      faultEvidence.observedTarget !== undefined &&
      this.#configuredTransportFaults.has(faultEvidence.observedTarget) &&
      (faultEvidence.appliedFaults ?? 0) > 0;
    if (
      this.#configuredTransportFaults.size > 0 &&
      (controllerAttempts === 0 || !configuredFaultWasObserved)
    ) {
      throw new Error('External configured fault was not exercised');
    }
    const transportAttempts = positiveSafeInteger(
      Math.max(sendAttempts, controllerAttempts),
      'transport attempts',
    );
    const deliveryObservation = (transport: AdapterTransport) =>
      ({
        type: 'delivery_attempted',
        requestId: observed.requestId,
        deliveryId: observed.deliveryId,
        payloadHash: observed.payloadHash,
        proofSetHash: proof.proofSetHash,
        transport,
      }) as const;
    const deliveryObservations =
      this.#transports.length === 1
        ? Array.from({ length: transportAttempts }, () => deliveryObservation(this.#transports[0]!))
        : this.#transports.map((transport) => deliveryObservation(transport));
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
    const redemptionObservations: Observation[] = this.#redeemedDeliveries.has(observed.deliveryId)
      ? []
      : [
          {
            type: 'redemption_started',
            deliveryId: observed.deliveryId,
            proofSetHash: proof.proofSetHash,
          },
        ];
    this.#redeemedDeliveries.add(observed.deliveryId);
    const observations: Observation[] = [
      { type: 'request_observed', requestId: request.id, singleUse: request.singleUse },
      ...deliveryObservations,
      ...redemptionObservations,
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
        faultController: faultEvidence.controller,
        ...(faultEvidence.observedTarget === undefined
          ? {}
          : { faultObservedTarget: faultEvidence.observedTarget }),
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
    await this.#waitForRestartReadiness(_component);
  }

  async clearFaults(target?: string): Promise<void> {
    try {
      await this.#faults.clear(target);
      if (target === undefined) {
        this.#configuredTransportFaults.clear();
      } else {
        this.#configuredTransportFaults.delete(target);
      }
    } catch {
      throw new Error('External fault cleanup failed');
    }
  }

  async #waitForRestartReadiness(component: string): Promise<void> {
    if (component !== 'sender' && component !== 'receiver') return;

    const probe = async () => {
      await adapterCall('sender capability discovery', () => this.#sender.capabilities());
      await adapterCall('receiver capability discovery', () => this.#receiver.capabilities());
      if (component !== 'receiver') return;
      for (const deliveryId of this.#redeemedDeliveries) {
        const receiptView = await adapterCall('receiver delivery lookup', () =>
          this.#receiver.delivery(deliveryId),
        );
        let receipt: DeliveryReceipt;
        try {
          receipt = parseDeliveryReceipt(receiptView);
        } catch {
          throw new Error('External receiver delivery receipt is invalid after restart');
        }
        if (receipt.status !== 'settled') {
          throw new Error(
            `External receiver restored delivery with status ${receipt.status} after restart`,
          );
        }
      }
    };

    for (let attempt = 0; attempt < this.#restartReadinessAttempts; attempt += 1) {
      try {
        await probe();
        return;
      } catch (error) {
        if (error instanceof AdapterNotApplicableError) throw error;
        if (attempt + 1 === this.#restartReadinessAttempts) {
          const detail = error instanceof Error ? error.message : 'Unknown readiness failure';
          throw new Error(
            `External ${component} restart readiness failed after ${this.#restartReadinessAttempts} attempts: ${detail}`,
          );
        }
        await this.#sleep(this.#restartReadinessDelayMs);
      }
    }
  }

  async #assertCrashEvidence(): Promise<void> {
    if (this.#armedCrashes.length === 0) return;
    if (this.#faults.crashStatus === undefined) {
      throw new Error('External crash status evidence is unavailable');
    }
    const status = await this.#faults.crashStatus();
    for (const armed of this.#armedCrashes) {
      const evidence = status.find(
        (item) =>
          item.runId === armed.runId &&
          item.component === armed.component &&
          item.boundary === armed.boundary &&
          item.occurrence === armed.occurrence,
      );
      if (evidence === undefined || !evidence.consumed || evidence.hits < armed.occurrence) {
        throw new Error('External crash arm was not consumed');
      }
    }
  }
}
