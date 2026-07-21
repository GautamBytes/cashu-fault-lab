import {
  computePayloadHash,
  parseDeliveryPayloadJson,
  parseProtocolId,
  type CashuProof,
  type DeliveryPayload,
  type DeliveryReceipt,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import type { Observation } from '@cashu-fault-lab/oracle';
import {
  acceptDelivery,
  createExactSwapPlan,
  MemoryReceiverStore,
  ReceiverDomainError,
  type AcceptDeliveryDependencies,
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
import { createHash } from 'node:crypto';
import {
  ScenarioRunner,
  type DriverSendResult,
  type FaultRule,
  type ScenarioDriver,
  type ScenarioRunResult,
  type ScenarioSpec,
} from './runner.js';
import { seededProtocolId, seededSecret } from './seeded-fixture.js';

const BASE_NOW = 1_784_399_400;
const VALIDITY_WINDOW_SECONDS = 900;
const REQUEST_ID = parseProtocolId('AAECAwQFBgcICQoLDA0ODw');

class ExpiryVerifier implements ProofVerifier {
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

class ExpiryMint implements MintGateway {
  swapCalls = 0;

  async prepareSwap(draft: SwapPlanDraft): Promise<ExactSwapPlan> {
    return createExactSwapPlan(draft, {
      keysetId: '00aa',
      inputFeePpk: 0,
      preparedAt: BASE_NOW,
      outputs: [
        {
          amount: draft.expectedAmount,
          id: '00aa',
          B_: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
          secret: 'expiry-replacement',
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
      replacementProofs: [`replacement-proof:${plan.deliveryId}`],
    };
  }

  async restore(): Promise<RestoreResult> {
    return { kind: 'not_found' };
  }

  async proofStates(plan: ExactSwapPlan): Promise<readonly MintProofState[]> {
    return plan.proofYs.map(() => 'UNSPENT');
  }
}

function buildPayload(
  deliveryId: ProtocolId,
  proofs: readonly CashuProof[],
  createdAt: number,
): { readonly payload: DeliveryPayload; readonly payloadHash: string } {
  const raw = {
    id: REQUEST_ID,
    memo: null,
    mint: 'https://mint.example',
    unit: 'sat',
    proofs,
    delivery: {
      v: 1 as const,
      id: deliveryId,
      created_at: createdAt,
      expires_at: createdAt + VALIDITY_WINDOW_SECONDS,
    },
  };
  const payload = parseDeliveryPayloadJson(
    new TextEncoder().encode(JSON.stringify(raw)),
    createdAt,
  );
  const payloadHash = computePayloadHash({
    requestId: payload.id,
    memo: payload.memo,
    mint: payload.mint,
    unit: payload.unit,
    proofs: payload.proofs,
    createdAt: payload.delivery.createdAt,
    expiresAt: payload.delivery.expiresAt,
  });
  return { payload, payloadHash };
}

function proofSetHashForProofs(proofs: readonly CashuProof[]): string {
  const proofClaimIds = proofs.map((proof) =>
    createHash('sha256').update(`claim:${proof.secret}`).digest('hex'),
  );
  return createHash('sha256').update(proofClaimIds.join('|')).digest('hex');
}

class ExpiryDriver implements ScenarioDriver {
  #seed = 'initial';
  #now = BASE_NOW;
  #proofs: readonly CashuProof[] = [
    { amount: 8, id: '00aa', secret: seededSecret(this.#seed, 'expiry-proof'), C: '02aa' },
  ];
  #store = new MemoryReceiverStore();
  #mint = new ExpiryMint();
  #requestObserved = false;
  #sendCount = 0;

  #deps(): AcceptDeliveryDependencies {
    return {
      store: this.#store,
      mint: this.#mint,
      verifier: new ExpiryVerifier(),
      now: () => this.#now,
    } as const;
  }

  async reset(seed: string): Promise<void> {
    this.#seed = seed;
    this.#now = BASE_NOW;
    this.#proofs = [
      { amount: 8, id: '00aa', secret: seededSecret(seed, 'expiry-proof'), C: '02aa' },
    ];
    this.#store = new MemoryReceiverStore();
    this.#mint = new ExpiryMint();
    this.#requestObserved = false;
    this.#sendCount = 0;
    await this.#store.createRequest({
      id: REQUEST_ID,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: BASE_NOW + VALIDITY_WINDOW_SECONDS,
    });
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return {
      sender: 'reference-ts',
      receiver: 'reference-ts',
      transports: ['http'],
      evidenceTier: 'T0',
      feature: 'expiry',
    };
  }

  async configureFault(_target: string, _rule: FaultRule): Promise<void> {
    throw new Error('Expiry lane does not configure transport faults');
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (sender !== 'reference' || selectedRequestId !== REQUEST_ID) {
      throw new Error('Unknown sender or request');
    }
    const deliveryId = this.#deliveryId(this.#sendCount);
    const { payload, payloadHash } = buildPayload(deliveryId, this.#proofs, BASE_NOW);
    const proofSetHash = proofSetHashForProofs(this.#proofs);
    const observations: Observation[] = [];
    if (!this.#requestObserved) {
      observations.push({ type: 'request_observed', requestId: REQUEST_ID, singleUse: true });
      this.#requestObserved = true;
    }
    let receipt: DeliveryReceipt | undefined;
    try {
      receipt = await acceptDelivery({ payload, payloadHash }, this.#deps());
    } catch (error) {
      if (error instanceof ReceiverDomainError) {
        const detailCode =
          error.code === 'REQUEST_EXPIRED' || error.code === 'DELIVERY_EXPIRED'
            ? 'expired'
            : error.code.toLowerCase();
        receipt = {
          profile: 'cashu-delivery-v1',
          requestId: REQUEST_ID,
          deliveryId,
          payloadHash,
          status: 'rejected',
          statusVersion: 1,
          mint: payload.mint,
          unit: payload.unit,
          amount: payload.proofs.reduce((sum, proof) => sum + proof.amount, 0),
          detailCode,
        };
      } else {
        throw error;
      }
    }
    this.#sendCount += 1;
    observations.push({
      type: 'delivery_attempted',
      requestId: REQUEST_ID,
      deliveryId,
      payloadHash,
      proofSetHash,
      transport: 'http',
    });
    if (receipt) {
      observations.push({
        type: 'receipt_observed',
        requestId: receipt.requestId,
        deliveryId: receipt.deliveryId,
        payloadHash: receipt.payloadHash,
        status: receipt.status,
        detailCode: receipt.detailCode,
        version: receipt.statusVersion,
        amount: receipt.amount,
        unit: receipt.unit,
      });
    }
    if (this.#mint.swapCalls !== 0) {
      throw new Error('Expiry lane started mint redemption on an expired delivery');
    }
    const credits = await this.#store.credits();
    if (credits.length !== 0) {
      throw new Error('Expiry lane credited a merchant for an expired delivery');
    }
    return {
      value: { status: receipt?.status ?? 'unknown', deliveryId },
      observations,
    };
  }

  #deliveryId(index: number): ProtocolId {
    return seededProtocolId(`${this.#seed}:send${index}`, 'expiry-delivery');
  }

  async restart(_component: string): Promise<void> {
    throw new Error('Expiry lane does not support restart');
  }

  async clearFaults(_target?: string): Promise<void> {
    throw new Error('Expiry lane does not configure faults');
  }

  async advanceTime(milliseconds: number): Promise<void> {
    const seconds = Math.floor(milliseconds / 1000);
    this.#now += seconds;
  }
}

export async function runReferenceExpiryScenario(
  spec: ScenarioSpec,
  seed: string,
): Promise<ScenarioRunResult> {
  return new ScenarioRunner(new ExpiryDriver()).run(spec, seed);
}
