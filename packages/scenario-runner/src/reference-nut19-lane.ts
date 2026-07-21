import {
  serializeDeliveryReceipt,
  type CashuProof,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import type { Observation } from '@cashu-fault-lab/oracle';
import {
  acceptPayloadBytes,
  createExactSwapPlan,
  MemoryReceiverStore,
  MintGatewayError,
  recoverDelivery,
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
  resumePayment,
  sendPayment,
  type PaymentTransport,
  type ReservedProofSet,
  type SenderWallet,
  type TransportResult,
} from '@cashu-fault-lab/reference-sender';
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

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';

class Nut19Verifier implements ProofVerifier {
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

class Nut19Mint implements MintGateway {
  mode: 'success' | 'timeout_after_commit' = 'success';
  swapCalls = 0;
  nut19ReplayCalls = 0;
  readonly swapRequests: string[] = [];
  readonly committed = new Map<string, SwapResult>();

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
          secret: 'packaged-nut19-replacement',
          blindingFactor: '11'.repeat(32),
        },
      ],
      recovery: { nut09: false, nut19Replay: true, nut19ReplayUntil: now + 300 },
    });
  }

  async swap(plan: ExactSwapPlan): Promise<SwapResult> {
    this.swapCalls += 1;
    this.swapRequests.push(plan.serializedRequest);
    const result = {
      replacementPlanHash: `nut19-replacement:${plan.deliveryId}`,
      replacementProofs: [`nut19-replacement-proof:${plan.deliveryId}`],
    } satisfies SwapResult;
    this.committed.set(plan.deliveryId, result);
    if (this.mode === 'timeout_after_commit') {
      throw new MintGatewayError('MINT_TIMEOUT', 'mint committed before response loss', true);
    }
    return result;
  }

  async restore(plan: ExactSwapPlan): Promise<RestoreResult> {
    if (
      !plan.recovery.nut19Replay ||
      now > (plan.recovery.nut19ReplayUntil ?? Number.MAX_SAFE_INTEGER)
    ) {
      return { kind: 'not_found' };
    }
    this.nut19ReplayCalls += 1;
    this.swapRequests.push(plan.serializedRequest);
    const result = this.committed.get(plan.deliveryId);
    if (!result || this.swapRequests[0] !== plan.serializedRequest) return { kind: 'not_found' };
    return { kind: 'recovered', result };
  }

  async proofStates(plan: ExactSwapPlan): Promise<readonly MintProofState[]> {
    return plan.proofYs.map(() => 'SPENT');
  }
}

class Nut19Wallet implements SenderWallet {
  constructor(private readonly proofs: readonly CashuProof[]) {}

  async reserveExact(): Promise<ReservedProofSet> {
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs: this.proofs };
  }

  async markSettled(): Promise<void> {}
  async releaseRejected(): Promise<void> {}
  async markRecoveryRequired(): Promise<void> {}
}

class ReceiverTransport implements PaymentTransport {
  constructor(private readonly accept: Parameters<typeof acceptPayloadBytes>[1]) {}

  async send(payload: Uint8Array): Promise<TransportResult> {
    const receipt = await acceptPayloadBytes(payload, this.accept);
    return { kind: 'receipt', receipt: serializeDeliveryReceipt(receipt) };
  }
}

class ReferenceNut19Driver implements ScenarioDriver {
  #seed = 'initial';
  #deliveryId = seededProtocolId(this.#seed, 'nut19-delivery');
  #proofs: readonly CashuProof[] = [
    { amount: 8, id: '00aa', secret: seededSecret(this.#seed, 'nut19-proof'), C: '02aa' },
  ];
  #store = new MemoryReceiverStore();
  #mint = new Nut19Mint();
  #wallet = new Nut19Wallet(this.#proofs);
  #state = new InMemorySenderState();
  #transport = this.#newTransport();
  #sendCount = 0;
  #reportedSwapCalls = 0;

  #deps() {
    return {
      store: this.#store,
      mint: this.#mint,
      verifier: new Nut19Verifier(),
      now: () => now,
    } as const;
  }

  #newTransport(): ReceiverTransport {
    return new ReceiverTransport(this.#deps());
  }

  async reset(seed: string): Promise<void> {
    this.#seed = seed;
    this.#deliveryId = seededProtocolId(seed, 'nut19-delivery');
    this.#proofs = [
      { amount: 8, id: '00aa', secret: seededSecret(seed, 'nut19-proof'), C: '02aa' },
    ];
    this.#store = new MemoryReceiverStore();
    this.#mint = new Nut19Mint();
    this.#wallet = new Nut19Wallet(this.#proofs);
    this.#state = new InMemorySenderState();
    this.#transport = this.#newTransport();
    this.#sendCount = 0;
    this.#reportedSwapCalls = 0;
    await this.#store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return {
      sender: 'reference-ts',
      receiver: 'reference-ts',
      transports: ['http'],
      recovery: ['nut19'],
      evidenceTier: 'T0',
    };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    if (target !== 'mint' || rule.kind !== 'timeout_after_commit') {
      throw new Error('Unsupported NUT-19 fault');
    }
    this.#mint.mode = 'timeout_after_commit';
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (sender !== 'reference' || selectedRequestId !== requestId) {
      throw new Error('Unknown sender or request');
    }
    const senderDeps = {
      wallet: this.#wallet,
      transport: this.#transport,
      state: this.#state,
      now: () => now,
      generateDeliveryId: () => this.#deliveryId,
      sleep: async () => {},
    } as const;
    const outcome =
      this.#sendCount === 0
        ? await sendPayment(
            {
              id: requestId as ProtocolId,
              amount: 8,
              unit: 'sat',
              mints: ['https://mint.example'],
              expiresAt: now + 900,
              transports: [{ type: 'post', target: 'https://merchant.example/pay' }],
            },
            senderDeps,
            { seed: this.#seed, maxAttempts: 1 },
          )
        : await resumePayment(this.#deliveryId, senderDeps, {
            seed: this.#seed,
            maxAttempts: 1,
          });
    this.#sendCount += 1;
    const senderRecord = await this.#state.get(this.#deliveryId);
    const receiverRecord = await this.#store.current(this.#deliveryId);
    if (!senderRecord || !receiverRecord) throw new Error('NUT-19 evidence is incomplete');
    const observations: Observation[] = [];
    if (this.#sendCount === 1) {
      observations.push({ type: 'request_observed', requestId, singleUse: true });
    }
    observations.push({
      type: 'delivery_attempted',
      requestId,
      deliveryId: this.#deliveryId,
      payloadHash: senderRecord.payloadHash,
      proofSetHash: receiverRecord.proofSetHash,
      transport: 'http',
    });
    while (this.#reportedSwapCalls < this.#mint.swapCalls) {
      observations.push({
        type: 'redemption_started',
        deliveryId: this.#deliveryId,
        proofSetHash: receiverRecord.proofSetHash,
      });
      this.#reportedSwapCalls += 1;
    }
    observations.push({
      type: 'mint_proofs_state',
      proofSetHash: receiverRecord.proofSetHash,
      state: 'SPENT',
    });
    if (outcome.receipt) {
      const receipt = outcome.receipt;
      if (receipt.status === 'settled') {
        const credits = await this.#store.credits();
        if (
          credits.length !== 1 ||
          !receiverRecord.replacementPlanHash ||
          this.#mint.nut19ReplayCalls !== 1 ||
          this.#mint.swapRequests[0] !== this.#mint.swapRequests[1]
        ) {
          throw new Error('NUT-19 replay settlement evidence is incomplete');
        }
        observations.push(
          {
            type: 'receiver_settled',
            deliveryId: this.#deliveryId,
            replacementPlanHash: receiverRecord.replacementPlanHash,
          },
          { type: 'merchant_credited', ...credits[0]! },
        );
      }
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
    return { value: { status: outcome.status, deliveryId: this.#deliveryId }, observations };
  }

  async restart(component: string): Promise<void> {
    if (component !== 'receiver') throw new Error('Unsupported NUT-19 restart component');
    await recoverDelivery(this.#deliveryId, this.#deps());
    this.#transport = this.#newTransport();
  }

  async clearFaults(): Promise<void> {
    this.#mint.mode = 'success';
  }
}

export async function runReferenceNut19Scenario(
  spec: ScenarioSpec,
  seed: string,
): Promise<ScenarioRunResult> {
  return new ScenarioRunner(new ReferenceNut19Driver()).run(spec, seed);
}
