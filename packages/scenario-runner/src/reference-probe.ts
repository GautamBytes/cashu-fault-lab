import {
  computePayloadHash,
  serializeDeliveryReceipt,
  type CashuProof,
} from '@cashu-fault-lab/delivery-core';
import {
  acceptPayloadBytes,
  createExactSwapPlan,
  MemoryReceiverStore,
  type ExactSwapPlan,
  type InspectProofs,
  type InspectProofsResult,
  type MintGateway,
  type MintProofState,
  type ProofVerifier,
  type RestoreResult,
  type SwapPlanDraft,
  type SwapResult,
} from '@cashu-fault-lab/reference-receiver';
import {
  InMemorySenderState,
  sendPayment,
  type PaymentTransport,
  type ReservedProofSet,
  type SenderWallet,
  type TransportResult,
} from '@cashu-fault-lab/reference-sender';
import { createHash } from 'node:crypto';
import type { MatrixExecutionResult } from './matrix.js';
import { seededProtocolId, seededSecret } from './seeded-fixture.js';

const now = 1_784_399_400;

class ProbeVerifier implements ProofVerifier {
  async inspect(input: InspectProofs): Promise<InspectProofsResult> {
    const proofClaimIds = input.payload.proofs.map((proof) =>
      createHash('sha256').update(`claim:${proof.secret}`).digest('hex'),
    );
    return {
      ys: input.payload.proofs.map((proof) => `Y:${proof.secret}`),
      proofClaimIds,
      proofSetHash: createHash('sha256').update(proofClaimIds.join('|')).digest('hex'),
      netAmount: input.payload.proofs.reduce((sum, proof) => sum + proof.amount, 0),
    };
  }
}

class ProbeMint implements MintGateway {
  swapCalls = 0;

  async prepareSwap(draft: SwapPlanDraft): Promise<ExactSwapPlan> {
    return createExactSwapPlan(draft, {
      keysetId: '00aa',
      inputFeePpk: 0,
      preparedAt: now,
      outputs: [
        {
          amount: draft.expectedAmount,
          id: '00aa',
          B_: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
          secret: 'matrix-replacement-secret',
          blindingFactor: '11'.repeat(32),
        },
      ],
      recovery: { nut09: true, nut19Replay: false, nut19ReplayUntil: null },
    });
  }

  async swap(plan: ExactSwapPlan): Promise<SwapResult> {
    this.swapCalls += 1;
    return {
      replacementPlanHash: `replacement:${plan.deliveryId}`,
      replacementProofs: [`replacement:${plan.deliveryId}`],
    };
  }

  async restore(): Promise<RestoreResult> {
    return { kind: 'not_found' };
  }

  async proofStates(plan: ExactSwapPlan): Promise<readonly MintProofState[]> {
    return plan.proofYs.map(() => 'SPENT');
  }
}

class ProbeWallet implements SenderWallet {
  reserveCalls = 0;

  constructor(private readonly proofs: readonly CashuProof[]) {}

  async reserveExact(): Promise<ReservedProofSet> {
    this.reserveCalls += 1;
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs: this.proofs };
  }

  async markSettled(): Promise<void> {}
  async releaseRejected(): Promise<void> {}
  async markRecoveryRequired(): Promise<void> {}
}

class ProbeTransport implements PaymentTransport {
  readonly payloadHashes: string[] = [];
  attempts = 0;

  constructor(private readonly accept: Parameters<typeof acceptPayloadBytes>[1]) {}

  async send(payload: Uint8Array): Promise<TransportResult> {
    this.attempts += 1;
    this.payloadHashes.push(createHash('sha256').update(payload).digest('hex'));
    const receipt = await acceptPayloadBytes(payload, this.accept);
    return this.attempts === 1
      ? { kind: 'no_response' }
      : { kind: 'receipt', receipt: serializeDeliveryReceipt(receipt) };
  }
}

export async function runReferenceDeliveryProbe(seed: string): Promise<MatrixExecutionResult> {
  const requestId = seededProtocolId(seed, 'matrix-request');
  const deliveryId = seededProtocolId(seed, 'matrix-delivery');
  const proofs: readonly CashuProof[] = [
    { amount: 8, id: '00aa', secret: seededSecret(seed, 'matrix-proof'), C: '02aa' },
  ];
  const store = new MemoryReceiverStore();
  const mint = new ProbeMint();
  const wallet = new ProbeWallet(proofs);
  const verifier = new ProbeVerifier();
  await store.createRequest({
    id: requestId,
    amount: 8,
    unit: 'sat',
    mints: ['https://mint.example'],
    singleUse: true,
    expiresAt: now + 900,
  });
  const transport = new ProbeTransport({ store, mint, verifier, now: () => now });
  const outcome = await sendPayment(
    {
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      expiresAt: now + 900,
      transports: [{ type: 'post', target: 'https://matrix-probe.invalid/pay' }],
    },
    {
      wallet,
      transport,
      state: new InMemorySenderState(),
      now: () => now,
      generateDeliveryId: () => deliveryId,
      sleep: async () => {},
    },
    { seed, maxAttempts: 2 },
  );
  const credits = await store.credits();
  const plans = await store.settlementPlans();
  const invariant =
    outcome.status === 'settled' &&
    transport.attempts === 2 &&
    new Set(transport.payloadHashes).size === 1 &&
    wallet.reserveCalls === 1 &&
    mint.swapCalls === 1 &&
    plans.length === 1 &&
    credits.length === 1;
  if (!invariant) {
    return {
      ok: false,
      code: 'REFERENCE_DELIVERY_INVARIANT_FAILED',
      reason: 'Reference delivery retry did not converge on one settlement and credit',
    };
  }
  const payloadHash = computePayloadHash({
    requestId,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs,
    createdAt: now,
    expiresAt: now + 900,
  });
  return {
    ok: true,
    evidence: {
      tier: 'T0',
      attempts: 2,
      uniquePayloads: 1,
      proofReservations: 1,
      swaps: 1,
      credits: 1,
      payloadHash,
    },
  };
}
