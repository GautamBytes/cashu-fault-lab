import {
  Amount,
  OutputData,
  type HasKeysetKeys,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import { normalizeMintUrl } from '@cashu-fault-lab/delivery-core';
import type { ExactSwapPlan, SwapOutputPlan, SwapPlanDraft } from '../domain/types.js';
import {
  MintGatewayError,
  type MintGateway,
  type MintProofState,
  type RestoreResult,
  type SwapResult,
} from '../ports/mint-gateway.js';
import { createExactSwapPlan, replacementPlanHash } from './swap-plan.js';
import { readBoundedJson } from './bounded-json.js';

const MAX_MINT_RESPONSE_BYTES = 1_048_576;

export type MintFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CashuTsMintGatewayOptions {
  readonly now: () => number;
  readonly fetch?: MintFetch;
  readonly timeoutMs?: number;
}

interface MintKeysetWire {
  readonly id: string;
  readonly unit: string;
  readonly active: boolean;
  readonly input_fee_ppk: number;
}

interface MintKeysWire extends HasKeysetKeys {
  readonly unit: string;
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

function assertTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new Error('Mint timeout must be an integer from 1 to 300,000 milliseconds');
  }
}

function mintEndpoint(mint: string, path: string): string {
  return `${normalizeMintUrl(mint)}${path}`;
}

function parseKeysets(value: unknown): readonly MintKeysetWire[] {
  if (!isRecord(value) || !Array.isArray(value.keysets))
    throw new Error('Mint keysets are invalid');
  return value.keysets.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      typeof entry.unit !== 'string' ||
      typeof entry.active !== 'boolean'
    ) {
      throw new Error('Mint keyset entry is invalid');
    }
    return {
      id: entry.id,
      unit: entry.unit,
      active: entry.active,
      input_fee_ppk:
        entry.input_fee_ppk === undefined ? 0 : safeInteger(entry.input_fee_ppk, 'Input fee PPK'),
    };
  });
}

function parseKeys(value: unknown, expectedId: string, expectedUnit: string): MintKeysWire {
  if (!isRecord(value) || !Array.isArray(value.keysets)) throw new Error('Mint keys are invalid');
  const entry = value.keysets.find(
    (candidate) => isRecord(candidate) && candidate.id === expectedId,
  );
  if (!isRecord(entry) || entry.unit !== expectedUnit || !isRecord(entry.keys)) {
    throw new Error('Requested mint keyset keys are unavailable');
  }
  const keys: Record<string, string> = {};
  for (const [amount, point] of Object.entries(entry.keys)) {
    if (typeof point !== 'string') throw new Error('Mint public key is invalid');
    keys[amount] = point;
  }
  return { id: expectedId, unit: expectedUnit, keys };
}

function recoveryPolicy(info: unknown, preparedAt: number): ExactSwapPlan['recovery'] {
  if (!isRecord(info) || !isRecord(info.nuts)) {
    return { nut09: false, nut19Replay: false, nut19ReplayUntil: null };
  }
  const nut09 = isRecord(info.nuts['9']) && info.nuts['9'].supported === true;
  const nut19 = info.nuts['19'];
  if (!isRecord(nut19) || !Array.isArray(nut19.cached_endpoints)) {
    return { nut09, nut19Replay: false, nut19ReplayUntil: null };
  }
  const swapCached = nut19.cached_endpoints.some(
    (endpoint) => isRecord(endpoint) && endpoint.method === 'POST' && endpoint.path === '/v1/swap',
  );
  if (!swapCached) return { nut09, nut19Replay: false, nut19ReplayUntil: null };
  if (nut19.ttl === null) return { nut09, nut19Replay: true, nut19ReplayUntil: null };
  const ttl = safeInteger(nut19.ttl, 'NUT-19 TTL');
  return { nut09, nut19Replay: true, nut19ReplayUntil: preparedAt + ttl };
}

function parseSignatures(value: unknown): readonly SerializedBlindedSignature[] {
  if (!isRecord(value) || !Array.isArray(value.signatures)) {
    throw new Error('Mint swap response has no signatures');
  }
  return value.signatures.map((signature) => {
    if (
      !isRecord(signature) ||
      typeof signature.id !== 'string' ||
      typeof signature.C_ !== 'string'
    ) {
      throw new Error('Mint signature is invalid');
    }
    const amount =
      typeof signature.amount === 'string'
        ? Amount.from(signature.amount)
        : Amount.from(safeInteger(signature.amount, 'Mint signature amount'));
    const dleq = isRecord(signature.dleq)
      ? {
          e: String(signature.dleq.e),
          s: String(signature.dleq.s),
          ...(signature.dleq.r === undefined ? {} : { r: String(signature.dleq.r) }),
        }
      : undefined;
    return {
      id: signature.id,
      amount,
      C_: signature.C_,
      ...(dleq === undefined ? {} : { dleq }),
    };
  });
}

function outputData(output: SwapOutputPlan): OutputData {
  return new OutputData(
    { amount: Amount.from(output.amount), id: output.id, B_: output.B_ },
    BigInt(`0x${output.blindingFactor}`),
    Uint8Array.from(Buffer.from(output.secret, 'base64url')),
  );
}

function replacementResult(
  plan: ExactSwapPlan,
  keys: MintKeysWire,
  signatures: readonly SerializedBlindedSignature[],
): SwapResult {
  if (signatures.length !== plan.outputs.length)
    throw new Error('Mint signature count is incomplete');
  const replacementProofs = plan.outputs.map((output, index) => {
    const signature = signatures[index]!;
    if (signature.id !== output.id || signature.amount.toNumber() !== output.amount) {
      throw new Error('Mint signature does not match planned output');
    }
    const proof = outputData(output).toProof(signature, keys);
    return JSON.stringify({ ...proof, amount: proof.amount.toNumber() });
  });
  return { replacementPlanHash: replacementPlanHash(plan), replacementProofs };
}

export class CashuTsMintGateway implements MintGateway {
  readonly #now: () => number;
  readonly #fetch: MintFetch;
  readonly #timeoutMs: number;

  constructor(options: CashuTsMintGatewayOptions) {
    this.#now = options.now;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    assertTimeout(this.#timeoutMs);
  }

  async #request(
    url: string,
    init: Omit<RequestInit, 'signal'>,
    mayHaveConsumedInputs: boolean,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new MintGatewayError(
        'MINT_NETWORK_ERROR',
        error instanceof Error ? error.message : 'Mint network request failed',
        mayHaveConsumedInputs,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MintGatewayError(
        `MINT_HTTP_${response.status}`,
        `Mint returned HTTP ${response.status}`,
        mayHaveConsumedInputs && response.status >= 500,
      );
    }
    try {
      return await readBoundedJson(response, MAX_MINT_RESPONSE_BYTES, 'Mint response');
    } catch (error) {
      throw new MintGatewayError(
        'MINT_INVALID_RESPONSE',
        error instanceof Error ? error.message : 'Mint response is invalid',
        mayHaveConsumedInputs,
      );
    }
  }

  async #get(mint: string, path: string): Promise<unknown> {
    return this.#request(mintEndpoint(mint, path), { method: 'GET' }, false);
  }

  async #keys(mint: string, id: string, unit: string): Promise<MintKeysWire> {
    return parseKeys(await this.#get(mint, `/v1/keys/${encodeURIComponent(id)}`), id, unit);
  }

  async prepareSwap(draft: SwapPlanDraft): Promise<ExactSwapPlan> {
    const preparedAt = this.#now();
    safeInteger(preparedAt, 'Current time');
    const [info, keysetsValue] = await Promise.all([
      this.#get(draft.mint, '/v1/info'),
      this.#get(draft.mint, '/v1/keysets'),
    ]);
    const keysets = parseKeysets(keysetsValue)
      .filter((keyset) => keyset.active && keyset.unit === draft.unit)
      .sort(
        (left, right) =>
          left.input_fee_ppk - right.input_fee_ppk || left.id.localeCompare(right.id),
      );
    const keyset = keysets[0];
    if (!keyset) throw new Error(`Mint has no active ${draft.unit} output keyset`);
    const keys = await this.#keys(draft.mint, keyset.id, draft.unit);
    const outputDataList = OutputData.createRandomData(Amount.from(draft.expectedAmount), keys);
    const outputs: SwapOutputPlan[] = outputDataList.map((output) => ({
      amount: output.blindedMessage.amount.toNumber(),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
      secret: Buffer.from(output.secret).toString('base64url'),
      blindingFactor: output.blindingFactor.toString(16).padStart(64, '0'),
    }));
    return createExactSwapPlan(draft, {
      keysetId: keyset.id,
      inputFeePpk: keyset.input_fee_ppk,
      outputs,
      preparedAt,
      recovery: recoveryPolicy(info, preparedAt),
    });
  }

  async #postSwap(plan: ExactSwapPlan): Promise<SwapResult> {
    let swapSucceeded = false;
    try {
      const value = await this.#request(
        mintEndpoint(plan.mint, '/v1/swap'),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: plan.serializedRequest,
        },
        true,
      );
      swapSucceeded = true;
      const keys = await this.#keys(plan.mint, plan.keysetId, plan.unit);
      return replacementResult(plan, keys, parseSignatures(value));
    } catch (error) {
      if (!swapSucceeded) throw error;
      throw new MintGatewayError(
        'MINT_POST_SWAP_PROCESSING',
        error instanceof Error ? error.message : 'Mint swap result processing failed',
        true,
      );
    }
  }

  async swap(plan: ExactSwapPlan): Promise<SwapResult> {
    return this.#postSwap(plan);
  }

  async restore(plan: ExactSwapPlan): Promise<RestoreResult> {
    const replayAllowed =
      plan.recovery.nut19Replay &&
      (plan.recovery.nut19ReplayUntil === null || this.#now() <= plan.recovery.nut19ReplayUntil);
    if (replayAllowed) {
      try {
        return { kind: 'recovered', result: await this.#postSwap(plan) };
      } catch {}
    }
    if (!plan.recovery.nut09) return { kind: 'not_found' };
    const outputs = plan.outputs.map(({ amount, id, B_ }) => ({ amount, id, B_ }));
    const value = await this.#request(
      mintEndpoint(plan.mint, '/v1/restore'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputs }),
      },
      false,
    );
    if (!isRecord(value) || !Array.isArray(value.outputs)) return { kind: 'not_found' };
    if (value.outputs.length !== plan.outputs.length) return { kind: 'not_found' };
    for (let index = 0; index < plan.outputs.length; index += 1) {
      const restored = value.outputs[index];
      const planned = plan.outputs[index]!;
      if (
        !isRecord(restored) ||
        restored.B_ !== planned.B_ ||
        restored.id !== planned.id ||
        Number(restored.amount) !== planned.amount
      ) {
        return { kind: 'not_found' };
      }
    }
    const keys = await this.#keys(plan.mint, plan.keysetId, plan.unit);
    return { kind: 'recovered', result: replacementResult(plan, keys, parseSignatures(value)) };
  }

  async proofStates(plan: ExactSwapPlan): Promise<readonly MintProofState[]> {
    const value = await this.#request(
      mintEndpoint(plan.mint, '/v1/checkstate'),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Ys: plan.proofYs }),
      },
      false,
    );
    if (
      !isRecord(value) ||
      !Array.isArray(value.states) ||
      value.states.length !== plan.proofYs.length
    ) {
      throw new MintGatewayError(
        'MINT_INVALID_STATE_RESPONSE',
        'Mint proof states are invalid',
        false,
      );
    }
    return value.states.map((entry, index) => {
      if (
        !isRecord(entry) ||
        entry.Y !== plan.proofYs[index] ||
        (entry.state !== 'UNSPENT' && entry.state !== 'PENDING' && entry.state !== 'SPENT')
      ) {
        throw new MintGatewayError(
          'MINT_INVALID_STATE_RESPONSE',
          'Mint proof state is invalid',
          false,
        );
      }
      return entry.state;
    });
  }
}
