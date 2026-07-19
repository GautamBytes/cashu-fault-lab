import type { CashuProof, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { HttpFaultGateway } from '@cashu-fault-lab/http-fault-gateway';
import type { Observation } from '@cashu-fault-lab/oracle';
import {
  buildReceiverHttpServer,
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
  HttpPaymentTransport,
  InMemorySenderState,
  sendPayment,
  type ReservedProofSet,
  type SenderWallet,
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

class ReferenceVerifier implements ProofVerifier {
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

class ReferenceMint implements MintGateway {
  swapCalls = 0;

  async prepareSwap(draft: SwapPlanDraft): Promise<ExactSwapPlan> {
    return createExactSwapPlan(draft, {
      keysetId: draft.inputProofs[0]?.id ?? '00aa',
      inputFeePpk: 0,
      preparedAt: now,
      outputs: [
        {
          amount: draft.expectedAmount,
          id: draft.inputProofs[0]?.id ?? '00aa',
          B_: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
          secret: 'packaged-lane-replacement',
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

class ReferenceWallet implements SenderWallet {
  constructor(private readonly proofs: readonly CashuProof[]) {}

  async reserveExact(): Promise<ReservedProofSet> {
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs: this.proofs };
  }

  async markSettled(): Promise<void> {}
  async releaseRejected(): Promise<void> {}
  async markRecoveryRequired(): Promise<void> {}
}

class ReferenceHttpDriver implements ScenarioDriver {
  #deliveryId = seededProtocolId('initial', 'http-delivery');
  #proofs: readonly CashuProof[] = [
    { amount: 8, id: '00aa', secret: seededSecret('initial', 'http-proof'), C: '02aa' },
  ];
  #store = new MemoryReceiverStore();
  #mint = new ReferenceMint();
  #wallet = new ReferenceWallet(this.#proofs);
  #state = new InMemorySenderState();
  #gateway: HttpFaultGateway | undefined;
  #gatewayUrl = '';
  #receiver: Awaited<ReturnType<typeof buildReceiverHttpServer>> | undefined;

  async reset(seed: string): Promise<void> {
    await this.close();
    this.#deliveryId = seededProtocolId(seed, 'http-delivery');
    this.#proofs = [{ amount: 8, id: '00aa', secret: seededSecret(seed, 'http-proof'), C: '02aa' }];
    this.#store = new MemoryReceiverStore();
    this.#mint = new ReferenceMint();
    this.#wallet = new ReferenceWallet(this.#proofs);
    this.#state = new InMemorySenderState();
    await this.#store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    this.#receiver = await buildReceiverHttpServer({
      accept: {
        store: this.#store,
        mint: this.#mint,
        verifier: new ReferenceVerifier(),
        now: () => now,
      },
    });
    await this.#receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = this.#receiver.server.address();
    if (!address || typeof address === 'string') throw new Error('Receiver did not bind TCP');
    this.#gateway = new HttpFaultGateway({
      downstream: `http://127.0.0.1:${address.port}`,
    });
    this.#gatewayUrl = await this.#gateway.listen();
  }

  async close(): Promise<void> {
    await this.#gateway?.close();
    await this.#receiver?.close();
    this.#gateway = undefined;
    this.#receiver = undefined;
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return {
      sender: 'reference-ts',
      receiver: 'reference-ts',
      transports: ['http'],
      evidenceTier: 'T0',
    };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    if (target !== 'http' || !this.#gateway) throw new Error('Unsupported fault target');
    if (rule.kind === 'drop_request') {
      this.#gateway.control.setRule({
        phase: 'before_forward',
        action: 'drop',
        occurrence: rule.occurrence ?? 1,
        count: 1,
      });
      return;
    }
    if (rule.kind === 'drop_response') {
      this.#gateway.control.setRule({
        phase: 'after_downstream_response',
        action: 'drop',
        occurrence: rule.occurrence ?? 1,
        count: 1,
      });
      return;
    }
    if (rule.kind === 'duplicate') {
      this.#gateway.control.setRule({
        phase: 'before_forward',
        action: 'duplicate',
        occurrence: rule.occurrence ?? 1,
        count: 1,
        duplicateCount: rule.duplicateCount ?? 1,
      });
      return;
    }
    throw new Error(`Unsupported HTTP fault kind: ${rule.kind}`);
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (sender !== 'reference' || selectedRequestId !== requestId) {
      throw new Error('Unknown sender or request');
    }
    const outcome = await sendPayment(
      {
        id: requestId as ProtocolId,
        amount: 8,
        unit: 'sat',
        mints: ['https://mint.example'],
        expiresAt: now + 900,
        transports: [{ type: 'post', target: `${this.#gatewayUrl}/pay` }],
      },
      {
        wallet: this.#wallet,
        transport: new HttpPaymentTransport({ timeoutMs: 2_000, allowPrivateNetwork: true }),
        state: this.#state,
        now: () => now,
        generateDeliveryId: () => this.#deliveryId,
        sleep: async () => {},
      },
      { seed: 'packaged-http-retry', maxAttempts: 3 },
    );
    if (outcome.status !== 'settled') throw new Error(`Payment did not settle: ${outcome.status}`);
    const senderRecord = await this.#state.get(this.#deliveryId);
    const receiverRecord = await this.#store.current(this.#deliveryId);
    const credits = await this.#store.credits();
    if (!senderRecord || !receiverRecord || credits.length !== 1) {
      throw new Error('End-to-end evidence is incomplete');
    }
    if (this.#mint.swapCalls !== 1) {
      throw new Error('HTTP fault lane started mint redemption more than once');
    }
    const receipt = outcome.receipt;
    const observations: readonly Observation[] = [
      { type: 'request_observed', requestId, singleUse: true },
      {
        type: 'delivery_attempted',
        requestId,
        deliveryId: this.#deliveryId,
        payloadHash: senderRecord.payloadHash,
        proofSetHash: receiverRecord.proofSetHash,
        transport: 'http',
      },
      {
        type: 'redemption_started',
        deliveryId: this.#deliveryId,
        proofSetHash: receiverRecord.proofSetHash,
      },
      { type: 'mint_proofs_state', proofSetHash: receiverRecord.proofSetHash, state: 'SPENT' },
      {
        type: 'receiver_settled',
        deliveryId: this.#deliveryId,
        replacementPlanHash: receiverRecord.replacementPlanHash!,
      },
      { type: 'merchant_credited', ...credits[0]! },
      {
        type: 'receipt_observed',
        requestId: receipt.requestId,
        deliveryId: receipt.deliveryId,
        payloadHash: receipt.payloadHash,
        status: receipt.status,
        detailCode: receipt.detailCode,
        version: receipt.statusVersion,
        amount: receipt.amount,
        unit: receipt.unit,
      },
    ];
    return { value: { status: outcome.status, deliveryId: this.#deliveryId }, observations };
  }

  async restart(): Promise<void> {
    throw new Error('Restart is unsupported by HTTP retry lane');
  }

  async clearFaults(target?: string): Promise<void> {
    if (target !== undefined && target !== 'http') throw new Error('Unsupported fault target');
    this.#gateway?.control.clearRules();
  }
}

export async function runReferenceHttpScenario(
  spec: ScenarioSpec,
  seed: string,
): Promise<ScenarioRunResult> {
  const driver = new ReferenceHttpDriver();
  try {
    return await new ScenarioRunner(driver).run(spec, seed);
  } finally {
    await driver.close();
  }
}
