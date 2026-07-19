import type { CashuProof, ProtocolId } from '@cashu-fault-lab/delivery-core';
import { serializeDeliveryReceipt } from '@cashu-fault-lab/delivery-core';
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
import type { GiftWrapSource } from '@cashu-fault-lab/nostr-delivery';
import type { Observation } from '@cashu-fault-lab/oracle';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getPublicKey, nip19 } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
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
const senderKey = Uint8Array.from(Buffer.from('11'.repeat(32), 'hex'));
const receiverKey = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const proofs: readonly CashuProof[] = [
  { amount: 8, id: '00aa', secret: 'cross-transport-secret', C: '02aa' },
];
const nostrTarget: TransportTarget = {
  type: 'nostr',
  target: nip19.nprofileEncode({
    pubkey: getPublicKey(receiverKey),
    relays: ['wss://relay.example'],
  }),
  tags: [['n', '17']],
};

class Verifier implements ProofVerifier {
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

class Mint implements MintGateway {
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
          secret: 'replacement-secret',
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

class Wallet implements SenderWallet {
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

class HybridTransport implements PaymentTransport {
  readonly payloadHex: string[] = [];
  readonly targetTypes: Array<TransportTarget['type']> = [];
  readonly requestWrapPubkeys: string[] = [];
  dropHttpResponse = false;
  dropFirstNostrReceipt = false;
  nostrPublishes = 0;
  private reply: Awaited<ReturnType<typeof processNostrDelivery>> | undefined;
  readonly #nostr: NostrPaymentTransport;

  constructor(
    private readonly accept: Parameters<typeof acceptPayloadBytes>[1],
    wrapperKeys: Uint8Array[],
  ) {
    this.#nostr = new NostrPaymentTransport({
      senderPrivateKey: senderKey,
      now: () => now,
      pollAttempts: 1,
      randomSecretKey: () => wrapperKeys.shift()!,
      randomOffsetSeconds: () => 1,
      publish: async (_relayUrl, event) => {
        this.nostrPublishes += 1;
        this.requestWrapPubkeys.push(event.pubkey);
        this.reply = await processNostrDelivery(event, {
          receiverPrivateKey: receiverKey,
          accept: this.accept,
          randomOffsetSeconds: () => 1,
        });
        return { accepted: true, message: '' };
      },
      source: (): GiftWrapSource => ({
        query: async () => {
          if (this.dropFirstNostrReceipt && this.nostrPublishes === 1) return [];
          return this.reply ? [this.reply] : [];
        },
      }),
    });
  }

  async send(
    payload: Uint8Array,
    target: TransportTarget,
    signal: AbortSignal,
  ): Promise<TransportResult> {
    this.payloadHex.push(Buffer.from(payload).toString('hex'));
    this.targetTypes.push(target.type);
    if (target.type === 'nostr') return this.#nostr.send(payload, target, signal);
    const receipt = await acceptPayloadBytes(payload, this.accept);
    return this.dropHttpResponse
      ? { kind: 'no_response' }
      : { kind: 'receipt', receipt: serializeDeliveryReceipt(receipt) };
  }
}

class NostrE2eDriver implements ScenarioDriver {
  readonly store = new MemoryReceiverStore();
  readonly mint = new Mint();
  readonly wallet = new Wallet();
  readonly state = new InMemorySenderState();
  readonly transport = new HybridTransport(
    { store: this.store, mint: this.mint, verifier: new Verifier(), now: () => now },
    ['33', '44', '55'].map((byte) => Uint8Array.from(Buffer.from(byte.repeat(32), 'hex'))),
  );

  constructor(private readonly mode: 'nostr' | 'cross') {}

  async reset(): Promise<void> {
    await this.store.createRequest({
      id: requestId,
      amount: 8,
      unit: 'sat',
      mints: ['https://mint.example'],
      singleUse: true,
      expiresAt: now + 900,
    });
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return { sender: 'reference', receiver: 'reference', transports: ['http', 'nostr'] };
  }

  async configureFault(target: string, rule: FaultRule): Promise<void> {
    if (rule.kind !== 'drop_response') throw new Error('Unsupported fault kind');
    if (target === 'http') this.transport.dropHttpResponse = true;
    else if (target === 'nostr') this.transport.dropFirstNostrReceipt = true;
    else throw new Error('Unsupported fault target');
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (sender !== 'reference' || selectedRequestId !== requestId)
      throw new Error('Unknown request');
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
        wallet: this.wallet,
        transport: this.transport,
        state: this.state,
        now: () => now,
        generateDeliveryId: () => deliveryId as ProtocolId,
        sleep: async () => {},
      },
      { seed: `e2e-${this.mode}`, maxAttempts: 3 },
    );
    if (outcome.status !== 'settled') throw new Error(`Payment did not settle: ${outcome.status}`);
    const senderRecord = await this.state.get(deliveryId);
    const receiverRecord = await this.store.current(deliveryId);
    const credits = await this.store.credits();
    if (!senderRecord || !receiverRecord || credits.length !== 1)
      throw new Error('Evidence missing');
    const attemptedTransports = [...new Set(this.transport.targetTypes)].map(
      (transport): Observation => ({
        type: 'delivery_attempted',
        requestId,
        deliveryId,
        payloadHash: senderRecord.payloadHash,
        proofSetHash: receiverRecord.proofSetHash,
        transport: transport === 'post' ? 'http' : 'nostr',
      }),
    );
    const receipt = outcome.receipt;
    return {
      value: { status: outcome.status, deliveryId },
      observations: [
        { type: 'request_observed', requestId, singleUse: true },
        ...attemptedTransports,
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
      ],
    };
  }

  async restart(): Promise<void> {
    throw new Error('Restart is not used');
  }

  async clearFaults(): Promise<void> {}
}

async function loadScenario(name: string): Promise<ScenarioSpec> {
  return JSON.parse(
    await readFile(new URL(`../../../scenarios/retry/${name}`, import.meta.url), 'utf8'),
  ) as ScenarioSpec;
}

describe('Nostr and cross-transport fault scenarios', () => {
  it.each([
    ['nostr-response-lost.json', 'nostr', ['nostr', 'nostr']],
    ['cross-transport-fallback.json', 'cross', ['post', 'nostr']],
  ] as const)('proves %s settles once', async (file, mode, expectedTargets) => {
    const driver = new NostrE2eDriver(mode);
    const result = await new ScenarioRunner(driver).run(await loadScenario(file), `seed:${file}`);

    expect(result.status).toBe('passed');
    expect(driver.transport.targetTypes).toEqual(expectedTargets);
    expect(new Set(driver.transport.payloadHex).size).toBe(1);
    expect(new Set(driver.transport.requestWrapPubkeys).size).toBe(driver.transport.nostrPublishes);
    expect(driver.mint.swapCalls).toBe(1);
    expect(driver.wallet.reserveCalls).toBe(1);
    expect(driver.wallet.status).toBe('settled');
    expect(await driver.store.credits()).toHaveLength(1);
  });
});
