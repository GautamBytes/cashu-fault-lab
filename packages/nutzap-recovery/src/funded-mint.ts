import {
  Amount,
  hasValidDleq,
  JSONInt,
  Mint,
  normalizeProofAmounts,
  OutputData,
  Wallet,
  type Proof,
  type RequestFn,
  type SerializedOutputData,
  type SwapPreview,
} from '@cashu/cashu-ts';
import { loopbackMint, type Nutzap, type NutzapProof } from './protocol.js';
import type { MintPort, PreparedRedemption, PreparedSpend } from './types.js';

function boundedRequest(origin: string): RequestFn {
  return async <T>(args: Parameters<RequestFn>[0]): Promise<T> => {
    if (new URL(args.endpoint).origin !== origin) throw Error('Mint origin changed');
    const body = args.requestBody === undefined ? undefined : JSONInt.stringify(args.requestBody);
    const response = await fetch(args.endpoint, {
      method: args.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw Error('Empty mint response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1048576) throw Error('Mint response too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    if (!response.ok) throw Error('Mint request failed');
    return JSONInt.parse(Buffer.concat(chunks).toString('utf8')) as T;
  };
}
function mintImplementation(version: unknown): string {
  if (
    typeof version !== 'string' ||
    !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}\/[0-9][a-zA-Z0-9.+_-]{0,63}$/.test(version)
  )
    throw Error('Invalid mint implementation');
  return version;
}

/** Self-reported NUT-06 version, not authenticated build provenance. */
export async function readMintImplementation(url: string): Promise<string> {
  loopbackMint(url);
  const info = await new Mint(url, {
    customRequest: boundedRequest(new URL(url).origin),
  }).getInfo();
  return mintImplementation(info.version);
}

function portable(proof: Proof): NutzapProof {
  return JSON.parse(JSONInt.stringify(proof)!);
}
interface StoredPreview {
  amount: string;
  fees: string;
  keysetId: string;
  inputs: NutzapProof[];
  outputs: SerializedOutputData[];
}

/** Real P2PK/DLEQ cashu-ts against an operator-provided disposable loopback mint. */
export class FundedMint implements MintPort {
  readonly #wallet: Wallet;
  readonly #key: string;
  successfulSwaps = 0;
  constructor(url: string, lockingKey: string) {
    loopbackMint(url);
    this.#key = lockingKey;
    this.#wallet = new Wallet(
      new Mint(url, { customRequest: boundedRequest(new URL(url).origin) }),
    );
  }
  get implementation(): string {
    return mintImplementation(this.#wallet.getMintInfo().version);
  }
  async source(lockingPubkey: string): Promise<NutzapProof[]> {
    await this.#wallet.loadMint();
    // Validate public identity before any test funding or redemption.
    this.implementation;
    for (const nut of [9, 11, 12] as const) {
      const support = this.#wallet.getMintInfo().isSupported(nut);
      if (!support.supported) throw Error('Mint lacks required restore, P2PK or DLEQ support');
    }
    let quote = await this.#wallet.createMintQuoteBolt11(16, 'NIP-61 disposable recovery suite');
    for (let i = 0; quote.state !== 'PAID' && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      quote = await this.#wallet.checkMintQuoteBolt11(quote);
    }
    if (quote.state !== 'PAID') throw Error('Disposable mint quote not paid');
    const preview = await this.#wallet.prepareMint('bolt11', 16, quote, undefined, {
      type: 'p2pk',
      options: { pubkey: `02${lockingPubkey}` },
    });
    return (await this.#wallet.completeMint(preview)).map(portable);
  }
  async initialize(): Promise<void> {
    await this.#wallet.loadMint();
  }
  async verify(proofs: NutzapProof[]): Promise<void> {
    this.#verified(normalizeProofAmounts(proofs));
  }
  async prepare(zap: Nutzap): Promise<PreparedRedemption> {
    const preview = await this.#wallet.prepareSwapToReceive(normalizeProofAmounts(zap.proofs), {
      requireDleq: true,
    });
    return this.#plan(preview);
  }
  async prepareSpend(proofs: NutzapProof[], amount: number): Promise<PreparedSpend> {
    await this.verify(proofs);
    const keyset = this.#wallet.getKeyset();
    const fee = this.#wallet.getFeesForProofs(proofs).toNumber();
    const keep = OutputData.createRandomData(
      proofs.reduce((n, p) => n + p.amount, 0) - amount - fee,
      keyset,
    );
    const send = OutputData.createRandomData(amount, keyset);
    // Reissue every proof from the retired token, including its remaining value.
    const preview = await this.#wallet.prepareSwapToReceive(
      normalizeProofAmounts(proofs),
      { requireDleq: true, keysetId: keyset.id },
      { type: 'custom', data: [...keep, ...send] },
    );
    return {
      ...this.#plan(preview),
      sendSecrets: send.map((o) =>
        Buffer.from(OutputData.serialize(o).secret, 'hex').toString('utf8'),
      ),
    };
  }
  #plan(preview: SwapPreview): PreparedRedemption {
    const outputs = [...(preview.keepOutputs ?? []), ...(preview.sendOutputs ?? [])].map((o) =>
      OutputData.serialize(o),
    );
    const stored: StoredPreview = {
      amount: preview.amount.toString(),
      fees: preview.fees.toString(),
      keysetId: preview.keysetId,
      inputs: preview.inputs.map(portable),
      outputs,
    };
    return {
      material: JSON.stringify(stored),
      fee: preview.fees.toNumber(),
      outputs: outputs.map((o) => ({
        secret: Buffer.from(o.secret, 'hex').toString('utf8'),
        amount: Number(o.blindedMessage.amount),
        id: o.blindedMessage.id,
      })),
    };
  }
  #preview(plan: PreparedRedemption): SwapPreview {
    const p: StoredPreview = JSON.parse(plan.material);
    return {
      amount: Amount.from(p.amount),
      fees: Amount.from(p.fees),
      keysetId: p.keysetId,
      inputs: normalizeProofAmounts(p.inputs),
      keepOutputs: p.outputs.map((o) => OutputData.deserialize(o)),
    };
  }
  #verified(proofs: Proof[]): NutzapProof[] {
    for (const p of proofs)
      if (!hasValidDleq(p, this.#wallet.getKeyset(p.id), { require: true }))
        throw Error('Output DLEQ invalid');
    return proofs.map(portable);
  }
  async swap(_zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]> {
    const result = await this.#wallet.completeSwap(this.#preview(plan), this.#key);
    this.successfulSwaps++;
    return this.#verified(result.keep);
  }
  async restore(_zap: Nutzap, plan: PreparedRedemption): Promise<NutzapProof[]> {
    const outputs = this.#preview(plan).keepOutputs ?? [];
    const response = await this.#wallet.mint.restore({
      outputs: outputs.map((o) => o.blindedMessage),
    });
    if (response.outputs.length !== response.signatures.length)
      throw Error('Restore cardinality mismatch');
    const seen = new Set<string>();
    const proofs = response.outputs.map((o, i) => {
      const source = outputs.find((p) => p.blindedMessage.B_ === o.B_);
      const sig = response.signatures[i]!;
      if (
        !source ||
        seen.has(o.B_) ||
        source.blindedMessage.id !== o.id ||
        sig.id !== o.id ||
        String(o.amount) !== String(source.blindedMessage.amount) ||
        String(sig.amount) !== String(o.amount)
      )
        throw Error('Restore output mismatch');
      seen.add(o.B_);
      return source.toProof(sig, this.#wallet.getKeyset(sig.id));
    });
    return this.#verified(proofs);
  }
  async states(proofs: NutzapProof[]): Promise<('UNSPENT' | 'SPENT' | 'PENDING')[]> {
    const result = await this.#wallet.checkProofsStates(normalizeProofAmounts(proofs));
    return result.map((r) => r.state);
  }
}
