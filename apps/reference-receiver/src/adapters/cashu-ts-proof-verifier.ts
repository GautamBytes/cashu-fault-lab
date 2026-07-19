import {
  Amount,
  getSecretKind,
  hasValidDleq,
  hashToCurve,
  pointFromHex,
  verifyHTLCSpendingConditions,
  verifyP2PKSpendingConditions,
  type HasKeysetKeys,
  type Proof,
} from '@cashu/cashu-ts';
import { computeProofSetHash, normalizeMintUrl } from '@cashu-fault-lab/delivery-core';
import { createHmac } from 'node:crypto';
import { TextEncoder } from 'node:util';
import type { InspectProofs, InspectProofsResult, ProofVerifier } from '../ports/proof-verifier.js';
import { readBoundedJson } from './bounded-json.js';
import type { MintFetch } from './cashu-ts-mint.js';

const MAX_METADATA_BYTES = 1_048_576;

export interface CashuTsProofVerifierOptions {
  readonly proofClaimKey: Uint8Array;
  readonly fetch?: MintFetch;
  readonly timeoutMs?: number;
}

interface KeysetMetadata {
  readonly id: string;
  readonly unit: string;
  readonly inputFeePpk: number;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

async function parseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Mint metadata returned HTTP ${response.status}`);
  return readBoundedJson(response, MAX_METADATA_BYTES, 'Mint metadata');
}

function parseMetadata(value: unknown): Map<string, KeysetMetadata> {
  if (!isRecord(value) || !Array.isArray(value.keysets))
    throw new Error('Mint keysets are invalid');
  const result = new Map<string, KeysetMetadata>();
  for (const entry of value.keysets) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.unit !== 'string') {
      throw new Error('Mint keyset metadata is invalid');
    }
    result.set(entry.id, {
      id: entry.id,
      unit: entry.unit,
      inputFeePpk:
        entry.input_fee_ppk === undefined ? 0 : safeInteger(entry.input_fee_ppk, 'Input fee PPK'),
    });
  }
  return result;
}

function parseKeys(value: unknown, id: string, expectedUnit: string): HasKeysetKeys {
  if (!isRecord(value) || !Array.isArray(value.keysets)) throw new Error('Mint keys are invalid');
  const entry = value.keysets.find((candidate) => isRecord(candidate) && candidate.id === id);
  if (!isRecord(entry) || !isRecord(entry.keys)) throw new Error(`Mint keys for ${id} are missing`);
  if (entry.unit !== expectedUnit) {
    throw new Error('Mint keyset unit does not match delivery unit');
  }
  const keys: Record<string, string> = {};
  for (const [amount, point] of Object.entries(entry.keys)) {
    if (typeof point !== 'string') throw new Error('Mint public key is invalid');
    pointFromHex(point);
    keys[amount] = point;
  }
  return { id, keys };
}

function cashuProof(value: InspectProofs['payload']['proofs'][number]): Proof {
  const dleq = value.dleq;
  let normalizedDleq: Proof['dleq'];
  if (dleq !== undefined) {
    if (
      !isRecord(dleq) ||
      typeof dleq.e !== 'string' ||
      typeof dleq.s !== 'string' ||
      typeof dleq.r !== 'string'
    ) {
      throw new Error('Proof DLEQ evidence is malformed');
    }
    normalizedDleq = { e: dleq.e, s: dleq.s, r: dleq.r };
  }
  return {
    id: value.id,
    amount: Amount.from(value.amount),
    secret: value.secret,
    C: value.C,
    ...(value.witness === undefined ? {} : { witness: value.witness }),
    ...(normalizedDleq === undefined ? {} : { dleq: normalizedDleq }),
  };
}

function enforceOfflineEvidence(proof: Proof, keys: HasKeysetKeys): void {
  pointFromHex(proof.C);
  try {
    if (!hasValidDleq(proof, keys, { require: false })) {
      throw new Error('Proof DLEQ evidence is invalid');
    }
  } catch (error) {
    if (proof.dleq) {
      throw new Error('Proof DLEQ evidence is invalid', { cause: error });
    }
    throw error;
  }

  let kind: string | undefined;
  try {
    kind = getSecretKind(proof.secret);
  } catch (error) {
    if (proof.secret.trimStart().startsWith('[')) {
      throw new Error('Proof spending condition is malformed', { cause: error });
    }
    return;
  }
  if (kind === 'P2PK' && !verifyP2PKSpendingConditions(proof).success) {
    throw new Error('P2PK spending condition is not authorized');
  }
  if (kind === 'HTLC' && !verifyHTLCSpendingConditions(proof).success) {
    throw new Error('HTLC spending condition is not authorized');
  }
}

export class CashuTsProofVerifier implements ProofVerifier {
  readonly #claimKey: Buffer;
  readonly #fetch: MintFetch;
  readonly #timeoutMs: number;

  constructor(options: CashuTsProofVerifierOptions) {
    this.#claimKey = Buffer.from(options.proofClaimKey);
    if (this.#claimKey.byteLength !== 32)
      throw new Error('Proof claim key must be exactly 32 bytes');
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (
      !Number.isSafeInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1 ||
      this.#timeoutMs > 300_000
    ) {
      throw new Error('Proof verifier timeout must be from 1 to 300,000 milliseconds');
    }
  }

  async #get(mint: string, path: string): Promise<unknown> {
    const response = await this.#fetch(`${normalizeMintUrl(mint)}${path}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    return parseJson(response);
  }

  async inspect(input: InspectProofs): Promise<InspectProofsResult> {
    const metadata = parseMetadata(await this.#get(input.payload.mint, '/v1/keysets'));
    const ids = [...new Set(input.payload.proofs.map((proof) => proof.id))];
    const keysets = new Map<string, HasKeysetKeys>();
    await Promise.all(
      ids.map(async (id) => {
        keysets.set(
          id,
          parseKeys(
            await this.#get(input.payload.mint, `/v1/keys/${encodeURIComponent(id)}`),
            id,
            input.payload.unit,
          ),
        );
      }),
    );

    const ys: string[] = [];
    const proofClaimIds: string[] = [];
    let total = 0;
    let feePpk = 0;
    for (const value of input.payload.proofs) {
      const keysetMetadata = metadata.get(value.id);
      const keys = keysets.get(value.id);
      if (!keysetMetadata || !keys) throw new Error(`Proof uses unknown keyset ${value.id}`);
      if (keysetMetadata.unit !== input.payload.unit) {
        throw new Error('Proof keyset unit does not match delivery unit');
      }
      if (!Object.hasOwn(keys.keys, String(value.amount))) {
        throw new Error('Proof denomination is not signed by its keyset');
      }
      const proof = cashuProof(value);
      enforceOfflineEvidence(proof, keys);
      const Y = hashToCurve(new TextEncoder().encode(value.secret)).toHex(true);
      ys.push(Y);
      proofClaimIds.push(createHmac('sha256', this.#claimKey).update(Y, 'hex').digest('hex'));
      total += value.amount;
      feePpk += keysetMetadata.inputFeePpk;
    }
    const fee = Math.ceil(feePpk / 1_000);
    const netAmount = total - fee;
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(feePpk) || netAmount < 0) {
      throw new Error('Proof amount or input fee exceeds safe bounds');
    }
    return {
      ys,
      proofClaimIds,
      proofSetHash: computeProofSetHash({
        mint: input.payload.mint,
        unit: input.payload.unit,
        ys: ys.map((Y) => Uint8Array.from(Buffer.from(Y, 'hex'))),
      }),
      netAmount,
    };
  }
}
