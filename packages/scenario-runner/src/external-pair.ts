import {
  AdapterNotApplicableError,
  type AdapterClient,
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
import type { MatrixExecutionResult } from './matrix.js';

const DELIVERY_PROFILE = 'delivery-v1';

export interface ExternalDeliveryPairInput {
  readonly profile: string;
  readonly seed: string;
  readonly sender: AdapterClient;
  readonly receiver: AdapterClient;
  readonly amount: number;
  readonly unit: string;
  readonly transports?: readonly AdapterTransport[];
}

function failure(code: string, reason: string): MatrixExecutionResult {
  return { ok: false, code, reason };
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

export async function runExternalDeliveryPair(
  input: ExternalDeliveryPairInput,
): Promise<MatrixExecutionResult> {
  if (input.profile !== DELIVERY_PROFILE) {
    return { ok: null, reason: `External pair profile ${input.profile} is not supported` };
  }

  try {
    const transports: AdapterTransport[] = [...new Set(input.transports ?? (['http'] as const))];
    if (
      transports.length < 1 ||
      transports.some((transport) => transport !== 'http' && transport !== 'nostr')
    ) {
      return failure('ADAPTER_TRANSPORT_SELECTION', 'External pair transport selection is invalid');
    }
    await input.receiver.reset(input.seed);
    await input.sender.reset(input.seed);

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

    const sent = parseDeliveryReceipt(await input.sender.send({ request: request.raw }));
    if (
      sent.requestId !== request.id ||
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

    return {
      ok: true,
      evidence: {
        tier: 'T1',
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
    return failure('ADAPTER_PAIR_EXECUTION', 'External adapter pair execution failed');
  }
}
