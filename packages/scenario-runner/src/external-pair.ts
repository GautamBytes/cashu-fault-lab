import {
  AdapterClientError,
  AdapterNotApplicableError,
  type AdapterClient,
  type AdapterMintIdentity,
  type AdapterTransport,
  type LedgerCreditView,
  type PaymentRequestView,
  type ProofEvidenceView,
} from '@cashu-fault-lab/adapter-contract';
import {
  assertReceiptTransition,
  parseDeliveryReceipt,
  type DeliveryReceipt,
} from '@cashu-fault-lab/delivery-core';
import {
  applyObservation,
  emptyOracleModel,
  evaluateInvariants,
  type Observation,
} from '@cashu-fault-lab/oracle';
import type { MatrixExecutionResult } from './matrix.js';
import { seededProtocolId } from './seeded-fixture.js';

const DELIVERY_PROFILE = 'delivery-v1';

export interface ExternalDeliveryPairInput {
  readonly profile: string;
  readonly seed: string;
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly amount: number;
  readonly unit: string;
  readonly transports?: readonly AdapterTransport[];
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function failure(code: string, reason: string): MatrixExecutionResult {
  return { ok: false, code, reason };
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function executionFailure(stage: string, error: unknown): MatrixExecutionResult {
  if (error instanceof AdapterClientError) {
    return failure(
      'ADAPTER_PAIR_EXECUTION',
      `External adapter pair execution failed during ${stage}: ${error.code} ${error.message}`,
    );
  }
  return failure('ADAPTER_PAIR_EXECUTION', 'External adapter pair execution failed');
}

function transportViewTypes(request: PaymentRequestView): ReadonlySet<AdapterTransport> {
  return new Set(
    request.transports.map((transport) => (transport.type === 'post' ? 'http' : 'nostr')),
  );
}

function requestMatches(
  input: ExternalDeliveryPairInput,
  request: PaymentRequestView,
  transports: readonly AdapterTransport[],
): boolean {
  return (
    request.amount === input.amount &&
    request.unit === input.unit &&
    request.singleUse &&
    transports.every((transport) => transportViewTypes(request).has(transport))
  );
}

function sameReceiptIdentity(left: DeliveryReceipt, right: DeliveryReceipt): boolean {
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

function relatedCredits(
  credits: readonly LedgerCreditView[],
  receipt: DeliveryReceipt,
): readonly LedgerCreditView[] {
  return credits.filter(
    (credit) => credit.requestId === receipt.requestId || credit.deliveryId === receipt.deliveryId,
  );
}

function relatedProofs(
  proofs: readonly ProofEvidenceView[],
  deliveryId: string,
): readonly ProofEvidenceView[] {
  return proofs.filter((proof) => proof.deliveryId === deliveryId);
}

function mintIdentities(values: readonly AdapterMintIdentity[]): readonly AdapterMintIdentity[] {
  const result = new Map<string, AdapterMintIdentity>();
  for (const value of values) {
    result.set(`${value.id}\0${value.implementation}\0${value.version ?? ''}`, value);
  }
  return [...result.values()].sort((left, right) =>
    `${left.id}:${left.implementation}:${left.version ?? ''}`.localeCompare(
      `${right.id}:${right.implementation}:${right.version ?? ''}`,
    ),
  );
}

export async function runExternalDeliveryPair(
  input: ExternalDeliveryPairInput,
): Promise<MatrixExecutionResult> {
  if (input.profile !== DELIVERY_PROFILE) {
    return { ok: null, reason: `External pair profile ${input.profile} is not supported` };
  }

  try {
    const maxAttempts = positiveSafeInteger(input.maxAttempts ?? 3, 'maxAttempts');
    const retryDelayMs = positiveSafeInteger(input.retryDelayMs ?? 100, 'retryDelayMs');
    const sleep =
      input.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const transports: AdapterTransport[] = [...new Set(input.transports ?? (['http'] as const))];
    if (
      transports.length < 1 ||
      transports.some((transport) => transport !== 'http' && transport !== 'nostr')
    ) {
      return failure('ADAPTER_TRANSPORT_SELECTION', 'External pair transport selection is invalid');
    }
    await input.receiver.reset(input.seed);
    await input.sender.reset(input.seed);
    const senderCapabilities = await input.sender.capabilities();
    const receiverCapabilities = await input.receiver.capabilities();

    const request = await input.receiver.createRequest({
      amount: input.amount,
      unit: input.unit,
      transports,
      singleUse: true,
      expiresIn: 900,
    });
    if (!requestMatches(input, request, transports)) {
      return failure(
        'ADAPTER_REQUEST_IDENTITY',
        'Receiver request does not match the requested payment',
      );
    }

    const deliveryId = seededProtocolId(
      input.seed,
      `external-delivery:${senderCapabilities.implementation.id}:${request.id}`,
    );
    let sent: DeliveryReceipt | undefined;
    let lastSendError: unknown;
    let sendAttempts = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        sendAttempts += 1;
        sent = parseDeliveryReceipt(await input.sender.send({ request: request.raw, deliveryId }));
        break;
      } catch (error) {
        if (error instanceof AdapterNotApplicableError) throw error;
        lastSendError = error;
        if (attempt + 1 === maxAttempts) return executionFailure('sender send', lastSendError);
        await sleep(Math.min(retryDelayMs * 2 ** attempt, 5_000));
      }
    }
    if (sent === undefined) {
      return failure('ADAPTER_PAIR_EXECUTION', 'External adapter pair execution failed');
    }
    if (
      sent.requestId !== request.id ||
      sent.deliveryId !== deliveryId ||
      sent.amount !== request.amount ||
      sent.unit !== request.unit
    ) {
      return failure(
        'ADAPTER_RECEIPT_IDENTITY',
        'Sender receipt does not match the receiver request',
      );
    }

    const observed = parseDeliveryReceipt(await input.receiver.delivery(sent.deliveryId));
    if (!sameReceiptIdentity(sent, observed)) {
      return failure(
        'ADAPTER_RECEIPT_IDENTITY',
        'Receiver receipt conflicts with the sender receipt',
      );
    }
    try {
      assertReceiptTransition(sent, observed);
    } catch {
      return failure(
        'ADAPTER_RECEIPT_TRANSITION',
        'Receiver receipt is not a valid progression from the sender receipt',
      );
    }
    if (observed.status !== 'settled') {
      return failure('ADAPTER_RECEIPT_NOT_SETTLED', 'Receiver did not report a settled payment');
    }

    const credits = relatedCredits(await input.receiver.ledger(), observed);
    const credit = credits[0];
    if (
      credits.length !== 1 ||
      credit === undefined ||
      credit.requestId !== observed.requestId ||
      credit.deliveryId !== observed.deliveryId ||
      credit.amount !== observed.amount ||
      credit.unit !== observed.unit ||
      credit.creditCount !== 1
    ) {
      return failure(
        'ADAPTER_LEDGER_EVIDENCE',
        'Receiver must report exactly one matching merchant credit',
      );
    }

    const proofs = relatedProofs(await input.receiver.proofs(), observed.deliveryId);
    const proof = proofs[0];
    if (
      proofs.length !== 1 ||
      proof === undefined ||
      proof.state !== 'spent' ||
      proof.inputYs.length === 0
    ) {
      return failure(
        'ADAPTER_PROOF_EVIDENCE',
        'Receiver must report exactly one spent input proof set',
      );
    }

    const deliveryObservations: Observation[] = Array.from({ length: sendAttempts }, () => ({
      type: 'delivery_attempted',
      requestId: observed.requestId,
      deliveryId: observed.deliveryId,
      payloadHash: observed.payloadHash,
      proofSetHash: proof.proofSetHash,
      transport: transports[0]!,
    }));
    const invariantObservations: readonly Observation[] = [
      { type: 'request_observed', requestId: request.id, singleUse: request.singleUse },
      ...deliveryObservations,
      { type: 'mint_proofs_state', proofSetHash: proof.proofSetHash, state: 'SPENT' },
      {
        type: 'merchant_credited',
        creditId: `external-ledger:${credit.requestId}:${credit.deliveryId}:${credit.createdAt}`,
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
    const capabilities = {
      sender: {
        implementation: senderCapabilities.implementation,
        role: senderCapabilities.roles.sender,
      },
      receiver: {
        implementation: receiverCapabilities.implementation,
        role: receiverCapabilities.roles.receiver,
      },
    };
    const invariants = evaluateInvariants({
      model: invariantObservations.reduce(applyObservation, emptyOracleModel()),
      history: invariantObservations.map((observation, index) => ({
        sequence: index,
        phase: 'observation',
        event: observation.type,
        data: observation,
      })),
      commands: Array.from({ length: sendAttempts }, () => ({ type: 'send' })),
      capabilities,
      metadata: {
        scenarioId: `matrix:${input.profile}`,
        seed: input.seed,
        componentVersions: {
          [`sender/${senderCapabilities.implementation.id}`]:
            senderCapabilities.implementation.version,
          [`receiver/${receiverCapabilities.implementation.id}`]:
            receiverCapabilities.implementation.version,
        },
      },
      profile: input.profile,
    });
    const mints = mintIdentities([...senderCapabilities.mints, ...receiverCapabilities.mints]);

    return {
      ok: true,
      invariants,
      mints,
      evidence: {
        requestId: observed.requestId,
        deliveryId: observed.deliveryId,
        payloadHash: observed.payloadHash,
        receiptVersion: observed.statusVersion,
        credits: credit.creditCount,
        proofSetHash: proof.proofSetHash,
        proofState: proof.state,
        transports,
        seed: input.seed,
      },
    };
  } catch (error) {
    if (error instanceof AdapterNotApplicableError) {
      return { ok: null, reason: error.reason };
    }
    return executionFailure('setup or evidence collection', error);
  }
}
