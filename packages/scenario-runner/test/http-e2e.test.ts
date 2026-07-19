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
  type SwapResult,
  type SwapPlanDraft,
} from '@cashu-fault-lab/reference-receiver';
import {
  HttpPaymentTransport,
  InMemorySenderState,
  sendPayment,
  type ReservedProofSet,
  type SenderWallet,
} from '@cashu-fault-lab/reference-sender';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ScenarioRunner,
  type DriverSendResult,
  type FaultRule,
  type ScenarioDriver,
  type ScenarioSpec,
} from '../src/index.js';

const now = 1_784_399_400;
const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const deliveryId = 'EBESExQVFhcYGRobHB0eHw';
const proofs: readonly CashuProof[] = [
  { amount: 8, id: '00aa', secret: 'e2e-secret-a', C: '02aa' },
];

class E2eVerifier implements ProofVerifier {
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

class E2eMint implements MintGateway {
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
          secret: 'e2e-replacement-secret',
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

class E2eWallet implements SenderWallet {
  reserveCalls = 0;
  status = 'unreserved';

  async reserveExact(): Promise<ReservedProofSet> {
    this.reserveCalls += 1;
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs };
  }

  async markSettled(): Promise<void> {
    this.status = 'settled';
  }

  async releaseRejected(): Promise<void> {
    this.status = 'rejected';
  }

  async markRecoveryRequired(): Promise<void> {
    this.status = 'recovery_required';
  }
}

class HttpE2eDriver implements ScenarioDriver {
  store = new MemoryReceiverStore();
  mint = new E2eMint();
  wallet = new E2eWallet();
  state = new InMemorySenderState();
  gateway: HttpFaultGateway | undefined;
  gatewayUrl = '';
  receiver: Awaited<ReturnType<typeof buildReceiverHttpServer>> | undefined;

  async reset(): Promise<void> {
    await this.close();
    this.store = new MemoryReceiverStore();
    this.mint = new E2eMint();
    this.wallet = new E2eWallet();
    this.state = new InMemorySenderState();
    await this.store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
    this.receiver = await buildReceiverHttpServer({
      accept: {
        store: this.store,
        mint: this.mint,
        verifier: new E2eVerifier(),
        now: () => now,
      },
    });
    await this.receiver.listen({ port: 0, host: '127.0.0.1' });
    const address = this.receiver.server.address();
    if (!address || typeof address === 'string') throw new Error('Receiver did not bind TCP');
    this.gateway = new HttpFaultGateway({
      downstream: `http://127.0.0.1:${address.port}`,
    });
    this.gatewayUrl = await this.gateway.listen();
  }

  async close(): Promise<void> {
    await this.gateway?.close();
    await this.receiver?.close();
    this.gateway = undefined;
    this.receiver = undefined;
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return {
      sender: 'reference',
      receiver: 'reference',
      transports: ['http'],
      evidenceTier: 'T3',
    };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    if (target !== 'http' || !this.gateway) throw new Error('Unsupported fault target');
    if (rule.kind === 'drop_request') {
      this.gateway.control.setRule({
        phase: 'before_forward',
        action: 'drop',
        occurrence: rule.occurrence ?? 1,
        count: 1,
      });
      return;
    }
    if (rule.kind === 'drop_response') {
      this.gateway.control.setRule({
        phase: 'after_downstream_response',
        action: 'drop',
        occurrence: rule.occurrence ?? 1,
        count: 1,
      });
      return;
    }
    if (rule.kind === 'duplicate') {
      this.gateway.control.setRule({
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
        transports: [{ type: 'post', target: `${this.gatewayUrl}/pay` }],
      },
      {
        wallet: this.wallet,
        transport: new HttpPaymentTransport({ timeoutMs: 2_000 }),
        state: this.state,
        now: () => now,
        generateDeliveryId: () => deliveryId as ProtocolId,
        sleep: async () => {},
      },
      { seed: 'http-e2e-retry', maxAttempts: 3 },
    );
    if (outcome.status !== 'settled') throw new Error(`Payment did not settle: ${outcome.status}`);
    const senderRecord = await this.state.get(deliveryId);
    const receiverRecord = await this.store.current(deliveryId);
    const credits = await this.store.credits();
    if (!senderRecord || !receiverRecord || credits.length !== 1) {
      throw new Error('End-to-end evidence is incomplete');
    }
    const receipt = outcome.receipt;
    const observations: readonly Observation[] = [
      { type: 'request_observed', requestId, singleUse: true },
      {
        type: 'delivery_attempted',
        requestId,
        deliveryId,
        payloadHash: senderRecord.payloadHash,
        proofSetHash: receiverRecord.proofSetHash,
        transport: 'http',
      },
      { type: 'mint_proofs_state', proofSetHash: receiverRecord.proofSetHash, state: 'SPENT' },
      {
        type: 'receiver_settled',
        deliveryId,
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
    return { value: { status: outcome.status, deliveryId }, observations };
  }

  async restart(): Promise<void> {
    throw new Error('Restart is not used by HTTP retry scenarios');
  }

  async clearFaults(target?: string): Promise<void> {
    if (target !== undefined && target !== 'http') throw new Error('Unsupported fault target');
    this.gateway?.control.clearRules();
  }
}

async function loadScenario(relativePath: string): Promise<ScenarioSpec> {
  const url = new URL(`../../../scenarios/${relativePath}`, import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as ScenarioSpec;
}

describe('real HTTP payment fault scenarios', () => {
  const drivers: HttpE2eDriver[] = [];
  afterEach(async () => Promise.all(drivers.splice(0).map((driver) => driver.close())));

  it.each([
    ['retry/response-lost.json', 2, 2],
    ['retry/request-lost.json', 2, 1],
    ['concurrency/duplicate-storm.json', 1, 100],
  ] as const)('proves %s settles and credits exactly once', async (file, inbound, forwarded) => {
    const driver = new HttpE2eDriver();
    drivers.push(driver);
    const runner = new ScenarioRunner(driver);
    const scenario = await loadScenario(file);

    const result = await runner.run(scenario, `seed:${file}`);

    expect(result.status).toBe('passed');
    expect(await driver.store.credits()).toHaveLength(1);
    expect(driver.mint.swapCalls).toBe(1);
    expect(driver.wallet.reserveCalls).toBe(1);
    expect(driver.wallet.status).toBe('settled');
    expect((await driver.state.get(deliveryId))?.status).toBe('settled');
    expect(driver.gateway?.control.snapshot()).toMatchObject({ inbound, forwarded });
  });
});
