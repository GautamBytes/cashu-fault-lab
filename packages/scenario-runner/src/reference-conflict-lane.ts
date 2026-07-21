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

class ConflictVerifier implements ProofVerifier {
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

class ConflictMint implements MintGateway {
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
          secret: 'conflict-replacement',
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
    return plan.proofYs.map(() => 'SPENT');
  }
}

function buildPayload(
  deliveryId: ProtocolId,
  proofs: readonly CashuProof[],
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
      created_at: BASE_NOW,
      expires_at: BASE_NOW + VALIDITY_WINDOW_SECONDS,
    },
  };
  const payload = parseDeliveryPayloadJson(new TextEncoder().encode(JSON.stringify(raw)), BASE_NOW);
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

interface ConflictVariant {
  readonly deliveryId: ProtocolId;
  readonly proofs: readonly CashuProof[];
  readonly amount: number;
}

type ConflictKind = 'delivery_conflict' | 'proof_conflict' | 'single_use_conflict';

class ConflictDriver implements ScenarioDriver {
  #seed = 'initial';
  #conflictKind: ConflictKind = 'single_use_conflict';
  #store = new MemoryReceiverStore();
  #mint = new ConflictMint();
  #sendCount = 0;
  #reportedSwapCalls = 0;
  #requestObserved = false;
  #variants: readonly ConflictVariant[] = [];

  #deps(): AcceptDeliveryDependencies {
    return {
      store: this.#store,
      mint: this.#mint,
      verifier: new ConflictVerifier(),
      now: () => BASE_NOW,
    } as const;
  }

  async reset(seed: string): Promise<void> {
    this.#seed = seed;
    this.#store = new MemoryReceiverStore();
    this.#mint = new ConflictMint();
    this.#sendCount = 0;
    this.#reportedSwapCalls = 0;
    this.#requestObserved = false;
    this.#variants = this.#buildVariants(seed);
    await this.#store.createRequest({
      id: REQUEST_ID,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: this.#requestSingleUse(),
      expiresAt: BASE_NOW + VALIDITY_WINDOW_SECONDS,
    });
  }

  setConflictKind(kind: ConflictKind): void {
    this.#conflictKind = kind;
  }

  #buildVariants(seed: string): readonly ConflictVariant[] {
    const deliveryA = seededProtocolId(`${seed}:conflict-a`, 'delivery');
    const deliveryB = seededProtocolId(`${seed}:conflict-b`, 'delivery');
    const proofA: CashuProof = {
      amount: 8,
      id: '00aa',
      secret: seededSecret(seed, 'proof-a'),
      C: '02aa',
    };
    const proofB: CashuProof = {
      amount: 8,
      id: '00bb',
      secret: seededSecret(seed, 'proof-b'),
      C: '02bb',
    };
    // The second variant depends on the conflict type under test:
    // - delivery_conflict: same delivery ID, different proofs (binds a different payload
    //   under an existing delivery ID)
    // - proof_conflict: new delivery ID, same proofs (tries to re-use spent proofs)
    // - single_use_conflict: new delivery ID, new proofs (tries to claim an already-claimed
    //   single-use request)
    switch (this.#conflictKind) {
      case 'delivery_conflict':
        return [
          { deliveryId: deliveryA, proofs: [proofA], amount: 8 },
          { deliveryId: deliveryA, proofs: [proofB], amount: 8 },
        ];
      case 'proof_conflict':
        return [
          { deliveryId: deliveryA, proofs: [proofA], amount: 8 },
          { deliveryId: deliveryB, proofs: [proofA], amount: 8 },
        ];
      case 'single_use_conflict':
        return [
          { deliveryId: deliveryA, proofs: [proofA], amount: 8 },
          { deliveryId: deliveryB, proofs: [proofB], amount: 8 },
        ];
    }
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return {
      sender: 'reference-ts',
      receiver: 'reference-ts',
      transports: ['http'],
      evidenceTier: 'T0',
      feature: 'conflict',
    };
  }

  async configureFault(_target: string, _rule: FaultRule): Promise<void> {
    throw new Error('Conflict lane does not configure transport faults');
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (sender !== 'reference' || selectedRequestId !== REQUEST_ID) {
      throw new Error('Unknown sender or request');
    }
    const variant = this.#variants[this.#sendCount % this.#variants.length]!;
    const sendIndex = this.#sendCount;
    const { payload, payloadHash } = buildPayload(variant.deliveryId, variant.proofs);
    const proofSetHash = proofSetHashForProofs(variant.proofs);
    const observations: Observation[] = [];
    if (!this.#requestObserved) {
      observations.push({
        type: 'request_observed',
        requestId: REQUEST_ID,
        singleUse: this.#requestSingleUse(),
      });
      this.#requestObserved = true;
    }
    let receipt: DeliveryReceipt | undefined;
    let rejectedCode: string | undefined;
    try {
      receipt = await acceptDelivery({ payload, payloadHash }, this.#deps());
    } catch (error) {
      if (error instanceof ReceiverDomainError) {
        rejectedCode = error.code;
        receipt = {
          profile: 'cashu-delivery-v1',
          requestId: REQUEST_ID,
          deliveryId: variant.deliveryId,
          payloadHash,
          status: 'rejected',
          statusVersion: 1,
          mint: payload.mint,
          unit: payload.unit,
          amount: variant.amount,
          detailCode: 'conflict',
        };
      } else {
        throw error;
      }
    }
    this.#sendCount += 1;
    if (sendIndex === 0) {
      observations.push({
        type: 'delivery_attempted',
        requestId: REQUEST_ID,
        deliveryId: variant.deliveryId,
        payloadHash,
        proofSetHash,
        transport: 'http',
      });
      while (this.#reportedSwapCalls < this.#mint.swapCalls) {
        observations.push({
          type: 'redemption_started',
          deliveryId: variant.deliveryId,
          proofSetHash,
        });
        this.#reportedSwapCalls += 1;
      }
    } else {
      const expected = expectedReceiverError(this.#conflictKind);
      if (rejectedCode !== expected) {
        throw new Error(
          `Conflict lane expected ${expected} but saw ${rejectedCode ?? 'no rejection'}`,
        );
      }
      if (this.#mint.swapCalls !== this.#reportedSwapCalls) {
        throw new Error('Conflict lane started an extra mint swap for a rejected delivery');
      }
    }
    if (sendIndex === 0 && receipt?.status === 'settled') {
      const record = await this.#store.current(variant.deliveryId);
      const credits = await this.#store.credits();
      const credit = credits.find((item) => item.deliveryId === variant.deliveryId);
      if (!record?.replacementPlanHash || !credit) {
        throw new Error('Conflict lane settlement evidence is incomplete');
      }
      observations.push(
        {
          type: 'receiver_settled',
          deliveryId: variant.deliveryId,
          replacementPlanHash: record.replacementPlanHash,
        },
        { type: 'merchant_credited', ...credit },
      );
    }
    if (receipt && (sendIndex === 0 || this.#conflictKind !== 'delivery_conflict')) {
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
    const credits = await this.#store.credits();
    if (credits.length > 1) {
      throw new Error(`Conflict lane credited ${credits.length} times; expected at most one`);
    }
    return {
      value: {
        status: receipt?.status ?? 'unknown',
        deliveryId: variant.deliveryId,
        rejectedCode,
        payloadHash,
        proofSetHash,
      },
      observations,
    };
  }

  #requestSingleUse(): boolean {
    return this.#conflictKind !== 'proof_conflict';
  }

  async restart(_component: string): Promise<void> {
    throw new Error('Conflict lane does not support restart');
  }

  async clearFaults(_target?: string): Promise<void> {
    throw new Error('Conflict lane does not configure faults');
  }
}

function conflictKindFromName(name: string): ConflictKind {
  if (name === 'conflict-delivery') return 'delivery_conflict';
  if (name === 'conflict-proof') return 'proof_conflict';
  if (name === 'conflict-single-use') return 'single_use_conflict';
  throw new Error(`Unknown conflict scenario: ${name}`);
}

function expectedReceiverError(kind: ConflictKind): string {
  switch (kind) {
    case 'delivery_conflict':
      return 'DELIVERY_CONFLICT';
    case 'proof_conflict':
      return 'PROOF_CONFLICT';
    case 'single_use_conflict':
      return 'SINGLE_USE_CONFLICT';
  }
}

export async function runReferenceConflictScenario(
  spec: ScenarioSpec,
  seed: string,
): Promise<ScenarioRunResult> {
  const driver = new ConflictDriver();
  driver.setConflictKind(conflictKindFromName(spec.name));
  return new ScenarioRunner(driver).run(spec, seed);
}
