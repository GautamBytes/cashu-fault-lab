import {
  serializeDeliveryReceipt,
  type CashuProof,
  type ProtocolId,
} from '@cashu-fault-lab/delivery-core';
import type { GiftWrapSource } from '@cashu-fault-lab/nostr-delivery';
import type { Observation } from '@cashu-fault-lab/oracle';
import {
  acceptPayloadBytes,
  createExactSwapPlan,
  MemoryReceiverStore,
  processNostrDelivery,
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
  NostrPaymentTransport,
  sendPayment,
  type PaymentTransport,
  type ReservedProofSet,
  type SenderWallet,
  type TransportResult,
  type TransportTarget,
} from '@cashu-fault-lab/reference-sender';
import { createHash } from 'node:crypto';
import { getPublicKey, nip19 } from 'nostr-tools';
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
const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const nostrTarget: TransportTarget = {
  type: 'nostr',
  target: nip19.nprofileEncode({
    pubkey: getPublicKey(receiverKey),
    relays: ['wss://relay.example'],
  }),
  tags: [['n', '17']],
};

class ReferenceNostrVerifier implements ProofVerifier {
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

class ReferenceNostrMint implements MintGateway {
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
          secret: 'packaged-nostr-replacement',
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

class ReferenceNostrWallet implements SenderWallet {
  constructor(private readonly proofs: readonly CashuProof[]) {}

  async reserveExact(): Promise<ReservedProofSet> {
    return { mint: 'https://mint.example', unit: 'sat', netAmount: 8, proofs: this.proofs };
  }

  async markSettled(): Promise<void> {}
  async releaseRejected(): Promise<void> {}
  async markRecoveryRequired(): Promise<void> {}
}

class FaultableHybridTransport implements PaymentTransport {
  readonly targetTypes: Array<TransportTarget['type']> = [];
  dropHttpResponse = false;
  dropFirstNostrReceipt = false;
  httpDuplicates = 0;
  nostrDuplicates = 0;
  #nostrPublishes = 0;
  #reply: Awaited<ReturnType<typeof processNostrDelivery>> | undefined;
  readonly #nostr: NostrPaymentTransport;

  constructor(
    private readonly accept: Parameters<typeof acceptPayloadBytes>[1],
    wrapperKeys: Uint8Array[],
  ) {
    this.#nostr = new NostrPaymentTransport({
      senderPrivateKey: senderKey,
      now: () => now,
      pollAttempts: 1,
      randomSecretKey: () => {
        const key = wrapperKeys.shift();
        if (!key) throw new Error('Nostr wrapper key pool exhausted');
        return key;
      },
      randomOffsetSeconds: () => 1,
      publish: async (_relayUrl, event) => {
        this.#nostrPublishes += 1;
        const replies = await Promise.all(
          Array.from({ length: this.nostrDuplicates + 1 }, () =>
            processNostrDelivery(event, {
              receiverPrivateKey: receiverKey,
              accept: this.accept,
              randomOffsetSeconds: () => 1,
            }),
          ),
        );
        this.#reply = replies[0];
        return { accepted: true, message: '' };
      },
      source: (): GiftWrapSource => ({
        query: async () => {
          if (this.dropFirstNostrReceipt && this.#nostrPublishes === 1) return [];
          return this.#reply ? [this.#reply] : [];
        },
      }),
    });
  }

  async send(
    payload: Uint8Array,
    target: TransportTarget,
    signal: AbortSignal,
  ): Promise<TransportResult> {
    this.targetTypes.push(target.type);
    if (target.type === 'nostr') return this.#nostr.send(payload, target, signal);
    const receipts = await Promise.all(
      Array.from({ length: this.httpDuplicates + 1 }, () =>
        acceptPayloadBytes(payload, this.accept),
      ),
    );
    const receipt = receipts[0]!;
    return this.dropHttpResponse
      ? { kind: 'no_response' }
      : { kind: 'receipt', receipt: serializeDeliveryReceipt(receipt) };
  }
}

class ReferenceNostrDriver implements ScenarioDriver {
  #seed = 'initial';
  #deliveryId = seededProtocolId(this.#seed, 'nostr-delivery');
  #proofs: readonly CashuProof[] = [
    {
      amount: 8,
      id: '00aa',
      secret: seededSecret(this.#seed, 'nostr-proof'),
      C: '02aa',
    },
  ];
  #store = new MemoryReceiverStore();
  #mint = new ReferenceNostrMint();
  #wallet = new ReferenceNostrWallet(this.#proofs);
  #state = new InMemorySenderState();
  #transport = this.#newTransport();

  constructor(private readonly mode: 'nostr' | 'cross') {}

  #newTransport(): FaultableHybridTransport {
    return new FaultableHybridTransport(
      {
        store: this.#store,
        mint: this.#mint,
        verifier: new ReferenceNostrVerifier(),
        now: () => now,
      },
      ['33', '44', '55', '66'].map((byte) => Uint8Array.from(Buffer.from(byte.repeat(32), 'hex'))),
    );
  }

  async reset(seed: string): Promise<void> {
    this.#seed = seed;
    this.#deliveryId = seededProtocolId(seed, `nostr-${this.mode}-delivery`);
    this.#proofs = [
      {
        amount: 8,
        id: '00aa',
        secret: seededSecret(seed, `nostr-${this.mode}-proof`),
        C: '02aa',
      },
    ];
    this.#store = new MemoryReceiverStore();
    this.#mint = new ReferenceNostrMint();
    this.#wallet = new ReferenceNostrWallet(this.#proofs);
    this.#state = new InMemorySenderState();
    this.#transport = this.#newTransport();
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
      transports: ['http', 'nostr'],
      evidenceTier: 'T0',
    };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    if (rule.kind === 'drop_response') {
      if (target === 'http') this.#transport.dropHttpResponse = true;
      else if (target === 'nostr') this.#transport.dropFirstNostrReceipt = true;
      else throw new Error('Unsupported fault target');
      return;
    }
    if (rule.kind === 'duplicate') {
      const count = rule.duplicateCount ?? 1;
      if (target === 'http') this.#transport.httpDuplicates = count;
      else if (target === 'nostr') this.#transport.nostrDuplicates = count;
      else throw new Error('Unsupported fault target');
      return;
    }
    throw new Error('Unsupported Nostr fault kind');
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (sender !== 'reference' || selectedRequestId !== requestId) {
      throw new Error('Unknown sender or request');
    }
    const transports: readonly TransportTarget[] =
      this.mode === 'cross'
        ? [{ type: 'post', target: 'https://merchant.example/pay' }, nostrTarget]
        : [nostrTarget];
    const outcome = await sendPayment(
      {
        id: requestId as ProtocolId,
        amount: 8,
        unit: 'sat',
        mints: ['https://mint.example'],
        expiresAt: now + 900,
        transports,
      },
      {
        wallet: this.#wallet,
        transport: this.#transport,
        state: this.#state,
        now: () => now,
        generateDeliveryId: () => this.#deliveryId,
        sleep: async () => {},
      },
      { seed: this.#seed, maxAttempts: 3 },
    );
    if (outcome.status !== 'settled') throw new Error(`Payment did not settle: ${outcome.status}`);
    const senderRecord = await this.#state.get(this.#deliveryId);
    const receiverRecord = await this.#store.current(this.#deliveryId);
    const credits = await this.#store.credits();
    if (!senderRecord || !receiverRecord || credits.length !== 1) {
      throw new Error('End-to-end evidence is incomplete');
    }
    if (this.#mint.swapCalls !== 1) {
      throw new Error('Nostr fault lane started mint redemption more than once');
    }
    const attemptedTransports = [...new Set(this.#transport.targetTypes)].map(
      (transport): Observation => ({
        type: 'delivery_attempted',
        requestId,
        deliveryId: this.#deliveryId,
        payloadHash: senderRecord.payloadHash,
        proofSetHash: receiverRecord.proofSetHash,
        transport: transport === 'post' ? 'http' : 'nostr',
      }),
    );
    const receipt = outcome.receipt;
    return {
      value: { status: outcome.status, deliveryId: this.#deliveryId },
      observations: [
        { type: 'request_observed', requestId, singleUse: true },
        ...attemptedTransports,
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
      ],
    };
  }

  async restart(): Promise<void> {
    throw new Error('Restart is unsupported by Nostr retry lane');
  }

  async clearFaults(): Promise<void> {}
}

export async function runReferenceNostrScenario(
  spec: ScenarioSpec,
  seed: string,
  mode: 'nostr' | 'cross',
): Promise<ScenarioRunResult> {
  return new ScenarioRunner(new ReferenceNostrDriver(mode)).run(spec, seed);
}
