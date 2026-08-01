import {
  Amount,
  getEncodedToken,
  getP2PKSigFlag,
  hashToCurve,
  JSONInt,
  Mint,
  normalizeProofAmounts,
  OutputData,
  parseP2PKSecret,
  Wallet,
} from '@cashu/cashu-ts';
import type {
  LifecycleOperationInput,
  LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { createHash } from 'node:crypto';
import type {
  CashuTsLifecyclePreparedRequest,
  CashuTsLifecycleResult,
  CashuTsLifecycleStore,
  CashuTsLifecycleWalletPort,
  CashuTsLifecycleStoredProof,
} from './types.js';
import { createCashuTsNoRedirectRequest, validatedMintOrigin } from './network.js';

export { createCashuTsNoRedirectRequest, withCashuTsLifecycleOperation } from './network.js';

export interface CashuTsLifecycleClient {
  readonly keysetId: string;
  loadMint(): Promise<void>;
  createMintQuoteBolt11(amount: number, description?: string): Promise<unknown>;
  checkMintQuoteBolt11(quote: unknown): Promise<unknown>;
  prepareMint(
    method: string,
    amount: number,
    quote: unknown,
    config?: unknown,
    outputType?: unknown,
  ): Promise<unknown>;
  completeMint(preview: unknown): Promise<readonly unknown[]>;
  prepareSwapToSend(
    amount: number,
    proofs: readonly unknown[],
    config?: unknown,
    outputConfig?: unknown,
  ): Promise<unknown>;
  prepareSwapToReceive(token: string, config?: unknown, outputType?: unknown): Promise<unknown>;
  completeSwap(preview: unknown): Promise<{
    readonly keep: readonly unknown[];
    readonly send: readonly unknown[];
  }>;
  createMeltQuoteBolt11(invoice: string): Promise<unknown>;
  getFeesForProofs(proofs: readonly unknown[]): unknown;
  prepareMelt(
    method: string,
    quote: unknown,
    proofs: readonly unknown[],
    config?: unknown,
    outputType?: unknown,
  ): Promise<unknown>;
  completeMelt(preview: unknown, privkey?: unknown, options?: unknown): Promise<unknown>;
  prepareRestoreOutputs(
    start: number,
    count: number,
    keysetId: string,
  ): Promise<readonly unknown[]>;
  checkProofsStates(proofs: readonly unknown[]): Promise<readonly unknown[]>;
  getMintInfo(): unknown;
  restoreOutputs(outputs: readonly unknown[]): Promise<readonly unknown[]>;
  checkMeltQuoteBolt11(quote: unknown): Promise<unknown>;
  createMeltChangeProofs(
    outputData: readonly unknown[],
    signatures: readonly unknown[],
  ): readonly unknown[];
}

export interface CashuTsLifecycleLightningPort {
  settled(invoice: string, quoteHash: string): Promise<boolean>;
}

export function assertCashuTsRestoreResponsePair(
  originalBlindedMessage: object,
  restoredOutput: object,
  signature: object,
): void {
  if (
    Reflect.get(originalBlindedMessage, 'id') !== Reflect.get(restoredOutput, 'id') ||
    String(Reflect.get(originalBlindedMessage, 'amount')) !==
      String(Reflect.get(restoredOutput, 'amount')) ||
    Reflect.get(signature, 'id') !== Reflect.get(restoredOutput, 'id') ||
    String(Reflect.get(signature, 'amount')) !== String(Reflect.get(restoredOutput, 'amount'))
  ) {
    throw new Error('Cashu lifecycle restore response identity is invalid');
  }
}

class RealCashuTsLifecycleClient implements CashuTsLifecycleClient {
  readonly #wallet: Wallet;
  readonly #seed: Uint8Array;

  constructor(wallet: Wallet, seed: Uint8Array) {
    this.#wallet = wallet;
    this.#seed = seed;
  }

  get keysetId(): string {
    return this.#wallet.keysetId;
  }

  loadMint(): Promise<void> {
    return this.#wallet.loadMint();
  }

  createMintQuoteBolt11(amount: number, description?: string): Promise<unknown> {
    return this.#wallet.createMintQuoteBolt11(amount, description);
  }

  checkMintQuoteBolt11(quote: unknown): Promise<unknown> {
    return this.#wallet.checkMintQuoteBolt11(
      quote as Parameters<Wallet['checkMintQuoteBolt11']>[0],
    );
  }

  prepareMint(
    method: string,
    amount: number,
    quote: unknown,
    config?: unknown,
    outputType?: unknown,
  ): Promise<unknown> {
    return this.#wallet.prepareMint(
      method,
      amount,
      quote as Parameters<Wallet['prepareMint']>[2],
      config as Parameters<Wallet['prepareMint']>[3],
      outputType as Parameters<Wallet['prepareMint']>[4],
    );
  }

  completeMint(preview: unknown): Promise<readonly unknown[]> {
    return this.#wallet.completeMint(preview as Parameters<Wallet['completeMint']>[0]);
  }

  prepareSwapToSend(
    amount: number,
    proofs: readonly unknown[],
    config?: unknown,
    outputConfig?: unknown,
  ): Promise<unknown> {
    return this.#wallet.prepareSwapToSend(
      amount,
      proofs as Parameters<Wallet['prepareSwapToSend']>[1],
      config as Parameters<Wallet['prepareSwapToSend']>[2],
      outputConfig as Parameters<Wallet['prepareSwapToSend']>[3],
    );
  }

  prepareSwapToReceive(token: string, config?: unknown, outputType?: unknown): Promise<unknown> {
    return this.#wallet.prepareSwapToReceive(
      token,
      config as Parameters<Wallet['prepareSwapToReceive']>[1],
      outputType as Parameters<Wallet['prepareSwapToReceive']>[2],
    );
  }

  completeSwap(preview: unknown): Promise<{
    readonly keep: readonly unknown[];
    readonly send: readonly unknown[];
  }> {
    return this.#wallet.completeSwap(preview as Parameters<Wallet['completeSwap']>[0]);
  }

  createMeltQuoteBolt11(invoice: string): Promise<unknown> {
    return this.#wallet.createMeltQuoteBolt11(invoice);
  }

  getFeesForProofs(proofs: readonly unknown[]): unknown {
    return this.#wallet.getFeesForProofs(proofs as Parameters<Wallet['getFeesForProofs']>[0]);
  }

  prepareMelt(
    method: string,
    quote: unknown,
    proofs: readonly unknown[],
    config?: unknown,
    outputType?: unknown,
  ): Promise<unknown> {
    return this.#wallet.prepareMelt(
      method,
      quote as Parameters<Wallet['prepareMelt']>[1],
      proofs as Parameters<Wallet['prepareMelt']>[2],
      config as Parameters<Wallet['prepareMelt']>[3],
      outputType as Parameters<Wallet['prepareMelt']>[4],
    );
  }

  completeMelt(preview: unknown, privkey?: unknown, options?: unknown): Promise<unknown> {
    return this.#wallet.completeMelt(
      preview as Parameters<Wallet['completeMelt']>[0],
      privkey as Parameters<Wallet['completeMelt']>[1],
      options as Parameters<Wallet['completeMelt']>[2],
    );
  }

  async prepareRestoreOutputs(
    start: number,
    count: number,
    keysetId: string,
  ): Promise<readonly unknown[]> {
    const keyset = await this.#wallet.keyChain.ensureKeysetKeys(keysetId);
    return OutputData.createDeterministicData(
      0,
      this.#seed,
      start,
      keyset,
      Array.from({ length: count }, () => 0),
    );
  }

  checkProofsStates(proofs: readonly unknown[]): Promise<readonly unknown[]> {
    return this.#wallet.checkProofsStates(proofs as Parameters<Wallet['checkProofsStates']>[0]);
  }

  getMintInfo(): unknown {
    return this.#wallet.getMintInfo();
  }

  checkMeltQuoteBolt11(quote: unknown): Promise<unknown> {
    return this.#wallet.checkMeltQuoteBolt11(
      quote as Parameters<Wallet['checkMeltQuoteBolt11']>[0],
    );
  }

  createMeltChangeProofs(
    outputData: readonly unknown[],
    signatures: readonly unknown[],
  ): readonly unknown[] {
    return this.#wallet.createMeltChangeProofs(
      outputData as Parameters<Wallet['createMeltChangeProofs']>[0],
      signatures as Parameters<Wallet['createMeltChangeProofs']>[1],
    );
  }

  async restoreOutputs(outputs: readonly unknown[]): Promise<readonly unknown[]> {
    const requested = outputs.map((output) => {
      if (typeof output !== 'object' || output === null) {
        throw new Error('Cashu lifecycle restore output is invalid');
      }
      const blindedMessage = Reflect.get(output, 'blindedMessage');
      if (typeof blindedMessage !== 'object' || blindedMessage === null) {
        throw new Error('Cashu lifecycle restore output is invalid');
      }
      const B = Reflect.get(blindedMessage, 'B_');
      const id = Reflect.get(blindedMessage, 'id');
      if (typeof B !== 'string' || typeof id !== 'string') {
        throw new Error('Cashu lifecycle restore output is invalid');
      }
      return { output, blindedMessage, B, id };
    });
    if (new Set(requested.map(({ B }) => B)).size !== requested.length) {
      throw new Error('Cashu lifecycle restore output identity is invalid');
    }
    const response = await this.#wallet.mint.restore({
      outputs: requested.map(
        ({ blindedMessage }) =>
          blindedMessage as Parameters<Wallet['mint']['restore']>[0]['outputs'][number],
      ),
    });
    if (response.outputs.length !== response.signatures.length) {
      throw new Error('Cashu lifecycle restore response cardinality is invalid');
    }
    const signatures = new Map<string, (typeof response.signatures)[number]>();
    for (let index = 0; index < response.outputs.length; index += 1) {
      const restoredOutput = response.outputs[index]!;
      const signature = response.signatures[index]!;
      const original = requested.find(({ B }) => B === restoredOutput.B_);
      if (original === undefined || signatures.has(restoredOutput.B_)) {
        throw new Error('Cashu lifecycle restore response identity is invalid');
      }
      assertCashuTsRestoreResponsePair(original.blindedMessage, restoredOutput, signature);
      signatures.set(restoredOutput.B_, signature);
    }
    return requested.flatMap(({ output, B }) => {
      const signature = signatures.get(B);
      if (signature === undefined) return [];
      const toProof = Reflect.get(output, 'toProof');
      if (typeof toProof !== 'function')
        throw new Error('Cashu lifecycle restore output is invalid');
      return [
        (toProof as (signature: unknown, keyset: unknown) => unknown).call(
          output,
          signature,
          this.#wallet.getKeyset(signature.id),
        ),
      ];
    });
  }
}

export interface CashuTsLifecycleWalletOptions {
  readonly mintUrl: string;
  readonly unit: string;
  readonly store: CashuTsLifecycleStore;
  readonly walletFactory?: (seed: Uint8Array) => CashuTsLifecycleClient;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly lightning?: CashuTsLifecycleLightningPort;
  /** Explicitly enables lifecycle mutations against a non-loopback mint. */
  readonly allowUnsafeMint?: boolean;
}

interface PortableMarker {
  readonly __cashuFaultLabType: 'amount' | 'bigint' | 'bytes' | 'output_data';
  readonly value: unknown;
}

interface MintRequestMaterial {
  readonly schemaVersion: 1;
  readonly kind: 'mint';
  readonly operationId: string;
  readonly amount: number;
  readonly counter: number;
  readonly quote: unknown;
  readonly preview: unknown;
}

interface TransferRequestMaterial {
  readonly schemaVersion: 1;
  readonly kind: 'swap' | 'send';
  readonly operationId: string;
  readonly amount: number;
  readonly inputProofIds: readonly string[];
  readonly preview: unknown;
  readonly recipient?: string;
}

interface ReceiveRequestMaterial {
  readonly schemaVersion: 1;
  readonly kind: 'receive';
  readonly operationId: string;
  readonly token: string;
  readonly inputProofIds: readonly string[];
  readonly preview: unknown;
}

interface MeltRequestMaterial {
  readonly schemaVersion: 1;
  readonly kind: 'melt';
  readonly operationId: string;
  readonly invoice: string;
  readonly inputProofIds: readonly string[];
  readonly quote: unknown;
  readonly preview: unknown;
  readonly preferAsync: boolean;
}

interface RestoreRequestMaterial {
  readonly schemaVersion: 1;
  readonly kind: 'restore';
  readonly operationId: string;
  readonly start: number;
  readonly count: number;
  readonly batchSize: number;
  readonly keysetId: string;
  readonly outputs: unknown;
  readonly keysets: readonly {
    readonly keysetId: string;
    readonly start: number;
    readonly count: number;
    readonly outputs: unknown;
  }[];
}

interface ReconcileRequestMaterial {
  readonly schemaVersion: 1;
  readonly kind: 'reconcile';
  readonly operationId: string;
  readonly targetOperationId: string;
  readonly inputProofIds: readonly string[];
  readonly ys: readonly string[];
}

type LifecycleRequestMaterial =
  | MintRequestMaterial
  | TransferRequestMaterial
  | ReceiveRequestMaterial
  | MeltRequestMaterial
  | RestoreRequestMaterial
  | ReconcileRequestMaterial;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}

function seedBytes(seed: string): Uint8Array {
  if (seed.length === 0) throw new Error('Cashu lifecycle wallet seed is required');
  return Uint8Array.from(
    createHash('sha512')
      .update('cashu-fault-lab/cashu-ts-lifecycle-wallet-seed-v1\0')
      .update(seed)
      .digest(),
  );
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function portableEncode(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return { __cashuFaultLabType: 'bigint', value: value.toString() } satisfies PortableMarker;
  }
  if (value instanceof Uint8Array) {
    return {
      __cashuFaultLabType: 'bytes',
      value: Buffer.from(value).toString('base64url'),
    } satisfies PortableMarker;
  }
  if (value instanceof Amount) {
    return {
      __cashuFaultLabType: 'amount',
      value: value.toString(),
    } satisfies PortableMarker;
  }
  if (value instanceof OutputData) {
    return {
      __cashuFaultLabType: 'output_data',
      value: OutputData.serialize(value),
    } satisfies PortableMarker;
  }
  if (Array.isArray(value)) return value.map(portableEncode);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, portableEncode(entry)]),
  );
}

function portableDecode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableDecode);
  if (typeof value !== 'object' || value === null) return value;
  const marker = value as Partial<PortableMarker>;
  if (marker.__cashuFaultLabType === 'bigint' && typeof marker.value === 'string') {
    return BigInt(marker.value);
  }
  if (marker.__cashuFaultLabType === 'bytes' && typeof marker.value === 'string') {
    return Uint8Array.from(Buffer.from(marker.value, 'base64url'));
  }
  if (marker.__cashuFaultLabType === 'amount' && typeof marker.value === 'string') {
    return Amount.from(marker.value);
  }
  if (marker.__cashuFaultLabType === 'output_data') {
    return OutputData.deserialize(marker.value as Parameters<typeof OutputData.deserialize>[0]);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, portableDecode(entry)]),
  );
}

function encodedJson(value: unknown): string {
  const encoded = JSON.stringify(canonical(value));
  if (encoded === undefined) throw new Error('Cashu lifecycle request material is invalid');
  return encoded;
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`cashu-fault-lab/${domain}/v1\0`)
    .update(encodedJson(value))
    .digest('hex');
}

function httpBodyHash(value: Record<string, unknown>): string {
  const encoded = JSONInt.stringify(value);
  if (encoded === undefined) throw new Error('Cashu lifecycle HTTP body is invalid');
  return createHash('sha256')
    .update('cashu-fault-lab/cashu-ts-lifecycle-http-body/v1\0')
    .update(encoded)
    .digest('hex');
}

function requestDigest(path: string, body: Record<string, unknown>) {
  return { method: 'POST' as const, path, bodyHash: httpBodyHash(body) };
}

function blindedMessages(value: unknown, key: string): readonly unknown[] {
  return objectArray(value, key).map((output) => {
    if (typeof output !== 'object' || output === null) {
      throw new Error('Cashu lifecycle output is invalid');
    }
    const blindedMessage = Reflect.get(output, 'blindedMessage');
    if (typeof blindedMessage !== 'object' || blindedMessage === null) {
      throw new Error('Cashu lifecycle output is invalid');
    }
    return blindedMessage;
  });
}

function wireInputs(proofs: readonly unknown[]): readonly Record<string, unknown>[] {
  return proofs.map((proof) => {
    if (typeof proof !== 'object' || proof === null) {
      throw new Error('Cashu lifecycle request input is invalid');
    }
    const {
      dleq: _dleq,
      p2pk_e: _p2pkE,
      witness: originalWitness,
      ...input
    } = proof as Record<string, unknown>;
    let witness: string | undefined;
    if (originalWitness !== undefined) {
      try {
        parseP2PKSecret(Reflect.get(proof, 'secret') as string);
        witness =
          typeof originalWitness === 'string' ? originalWitness : JSON.stringify(originalWitness);
      } catch {
        // cashu-ts drops witnesses attached to proofs that do not contain a valid P2PK secret.
      }
    }
    return { ...input, ...(witness === undefined ? {} : { witness }) };
  });
}

function usesSigAll(proofs: readonly unknown[]): boolean {
  return proofs.some((proof) => {
    if (typeof proof !== 'object' || proof === null) return false;
    const secret = Reflect.get(proof, 'secret');
    if (typeof secret !== 'string') return false;
    try {
      return getP2PKSigFlag(secret) === 'SIG_ALL';
    } catch {
      return false;
    }
  });
}

function wireSwapOutputs(
  proofs: readonly unknown[],
  keepOutputs: readonly unknown[],
  sendOutputs: readonly unknown[] = [],
): readonly unknown[] {
  const outputs = [...keepOutputs, ...sendOutputs];
  if (!usesSigAll(proofs)) {
    outputs.sort(
      (left, right) =>
        amountNumber(Reflect.get(left as object, 'amount')) -
        amountNumber(Reflect.get(right as object, 'amount')),
    );
  }
  return outputs;
}

function quoteId(quote: unknown): string {
  if (
    typeof quote !== 'object' ||
    quote === null ||
    typeof Reflect.get(quote, 'quote') !== 'string'
  ) {
    throw new Error('Cashu lifecycle mint quote is invalid');
  }
  return Reflect.get(quote, 'quote') as string;
}

const COUNTER_RANGE_SIZE = 64;
const RESTORE_GAP_COUNT = 192;

function amountNumber(value: unknown): number {
  let amount: number;
  if (typeof value === 'number') amount = value;
  else if (typeof value === 'bigint' || typeof value === 'string') amount = Number(value);
  else if (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'toNumber') === 'function'
  ) {
    amount = (Reflect.get(value, 'toNumber') as () => number).call(value);
  } else {
    throw new Error('Cashu lifecycle proof amount is invalid');
  }
  return positiveInteger(amount, 'Cashu lifecycle proof amount');
}

function amountNumberOrZero(value: unknown): number {
  if (value === 0 || value === 0n || value === '0') return 0;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'toString') === 'function' &&
    (Reflect.get(value, 'toString') as () => string).call(value) === '0'
  ) {
    return 0;
  }
  return amountNumber(value);
}

function proofRecord(proof: unknown, mint: string, unit: string): CashuTsLifecycleStoredProof {
  if (typeof proof !== 'object' || proof === null)
    throw new Error('Cashu lifecycle proof is invalid');
  const secret = Reflect.get(proof, 'secret');
  const id = Reflect.get(proof, 'id');
  const C = Reflect.get(proof, 'C');
  if (typeof secret !== 'string' || typeof id !== 'string' || typeof C !== 'string') {
    throw new Error('Cashu lifecycle proof is invalid');
  }
  const amount = amountNumber(Reflect.get(proof, 'amount'));
  const material = portableEncode({
    amount,
    id,
    secret,
    C,
    ...(Reflect.get(proof, 'witness') === undefined
      ? {}
      : { witness: Reflect.get(proof, 'witness') }),
    ...(Reflect.get(proof, 'dleq') === undefined ? {} : { dleq: Reflect.get(proof, 'dleq') }),
    ...(Reflect.get(proof, 'p2pk_e') === undefined ? {} : { p2pk_e: Reflect.get(proof, 'p2pk_e') }),
  });
  return {
    proofId: digest('cashu-ts-lifecycle-proof-id', [id, secret]),
    mint,
    unit,
    amount,
    state: 'UNSPENT',
    bucket: 'available',
    material,
  };
}

function parseMintMaterial(value: unknown): MintRequestMaterial {
  if (
    typeof value !== 'object' ||
    value === null ||
    Reflect.get(value, 'schemaVersion') !== 1 ||
    Reflect.get(value, 'kind') !== 'mint' ||
    typeof Reflect.get(value, 'operationId') !== 'string'
  ) {
    throw new Error('Cashu lifecycle mint request material is invalid');
  }
  return value as unknown as MintRequestMaterial;
}

function parseRequestMaterial(value: unknown): LifecycleRequestMaterial {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'schemaVersion') !== 1) {
    throw new Error('Cashu lifecycle request material is invalid');
  }
  if (Reflect.get(value, 'kind') === 'mint') return parseMintMaterial(value);
  if (
    (Reflect.get(value, 'kind') === 'swap' || Reflect.get(value, 'kind') === 'send') &&
    typeof Reflect.get(value, 'operationId') === 'string' &&
    typeof Reflect.get(value, 'amount') === 'number' &&
    Array.isArray(Reflect.get(value, 'inputProofIds'))
  ) {
    return value as unknown as TransferRequestMaterial;
  }
  if (
    Reflect.get(value, 'kind') === 'receive' &&
    typeof Reflect.get(value, 'operationId') === 'string' &&
    typeof Reflect.get(value, 'token') === 'string' &&
    Array.isArray(Reflect.get(value, 'inputProofIds'))
  ) {
    return value as unknown as ReceiveRequestMaterial;
  }
  if (
    Reflect.get(value, 'kind') === 'melt' &&
    typeof Reflect.get(value, 'operationId') === 'string' &&
    typeof Reflect.get(value, 'invoice') === 'string' &&
    Array.isArray(Reflect.get(value, 'inputProofIds')) &&
    typeof Reflect.get(value, 'preferAsync') === 'boolean'
  ) {
    return value as unknown as MeltRequestMaterial;
  }
  if (
    Reflect.get(value, 'kind') === 'restore' &&
    typeof Reflect.get(value, 'operationId') === 'string' &&
    typeof Reflect.get(value, 'start') === 'number' &&
    typeof Reflect.get(value, 'count') === 'number' &&
    typeof Reflect.get(value, 'keysetId') === 'string'
  ) {
    return value as unknown as RestoreRequestMaterial;
  }
  if (
    Reflect.get(value, 'kind') === 'reconcile' &&
    typeof Reflect.get(value, 'operationId') === 'string' &&
    typeof Reflect.get(value, 'targetOperationId') === 'string' &&
    Array.isArray(Reflect.get(value, 'inputProofIds')) &&
    Array.isArray(Reflect.get(value, 'ys'))
  ) {
    return value as unknown as ReconcileRequestMaterial;
  }
  throw new Error('Cashu lifecycle request material is invalid');
}

function proofMaterial(proof: CashuTsLifecycleStoredProof): unknown {
  return portableDecode(proof.material);
}

function proofIdentity(proof: unknown): string {
  if (typeof proof !== 'object' || proof === null)
    throw new Error('Cashu lifecycle proof is invalid');
  const id = Reflect.get(proof, 'id');
  const secret = Reflect.get(proof, 'secret');
  if (typeof id !== 'string' || typeof secret !== 'string') {
    throw new Error('Cashu lifecycle proof is invalid');
  }
  return digest('cashu-ts-lifecycle-proof-id', [id, secret]);
}

function proofY(proof: unknown): string {
  if (typeof proof !== 'object' || proof === null)
    throw new Error('Cashu lifecycle proof is invalid');
  const secret = Reflect.get(proof, 'secret');
  if (typeof secret !== 'string') throw new Error('Cashu lifecycle proof is invalid');
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}

function objectArray(value: unknown, field: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null || !Array.isArray(Reflect.get(value, field))) {
    throw new Error(`Cashu lifecycle ${field} response is invalid`);
  }
  return Reflect.get(value, field) as readonly unknown[];
}

function optionalObjectArray(value: unknown, field: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Cashu lifecycle ${field} response is invalid`);
  }
  const fieldValue = Reflect.get(value, field);
  if (fieldValue === undefined || fieldValue === null) return [];
  if (!Array.isArray(fieldValue)) {
    throw new Error(`Cashu lifecycle ${field} response is invalid`);
  }
  return fieldValue as readonly unknown[];
}

function meltQuote(
  value: unknown,
  invoice: string,
  unit: string,
): {
  readonly quoteId: string;
  readonly amount: number;
  readonly feeReserve: number;
  readonly state: 'UNPAID' | 'PENDING' | 'PAID';
} {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Cashu lifecycle melt quote is invalid');
  }
  const quoteId = Reflect.get(value, 'quote');
  const request = Reflect.get(value, 'request');
  const quoteUnit = Reflect.get(value, 'unit');
  const stateValue = Reflect.get(value, 'state');
  const state = typeof stateValue === 'string' ? stateValue.toUpperCase() : undefined;
  if (
    typeof quoteId !== 'string' ||
    quoteId.length === 0 ||
    request !== invoice ||
    quoteUnit !== unit ||
    (state !== 'UNPAID' && state !== 'PENDING' && state !== 'PAID')
  ) {
    throw new Error('Cashu lifecycle melt quote identity is invalid');
  }
  return {
    quoteId,
    amount: amountNumber(Reflect.get(value, 'amount')),
    feeReserve: amountNumberOrZero(Reflect.get(value, 'fee_reserve')),
    state,
  };
}

function mintQuote(
  value: unknown,
  amount: number,
  unit: string,
): {
  readonly quoteId: string;
  readonly state: 'UNPAID' | 'PAID' | 'ISSUED';
} {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Cashu lifecycle mint quote is invalid');
  }
  const quoteId = Reflect.get(value, 'quote');
  const quoteAmount = amountNumber(Reflect.get(value, 'amount'));
  const quoteUnit = Reflect.get(value, 'unit');
  const stateValue = Reflect.get(value, 'state');
  const state = typeof stateValue === 'string' ? stateValue.toUpperCase() : undefined;
  if (
    typeof quoteId !== 'string' ||
    quoteId.length === 0 ||
    quoteAmount !== amount ||
    quoteUnit !== unit ||
    (state !== 'UNPAID' && state !== 'PAID' && state !== 'ISSUED')
  ) {
    throw new Error('Cashu lifecycle mint quote identity is invalid');
  }
  return { quoteId, state };
}

function quoteObservation(
  kind: 'mint' | 'melt',
  state: 'UNPAID' | 'PAID' | 'ISSUED' | 'PENDING',
  value: unknown,
) {
  return {
    kind,
    state,
    dataHash: digest('cashu-ts-lifecycle-quote-observation', [kind, state, portableEncode(value)]),
  } as const;
}

function lightningSettlementEvidence(operationId: string, invoice: string, quoteHash: string) {
  const dataHash = digest('cashu-ts-lifecycle-lightning-settlement', [invoice, quoteHash]);
  return {
    effectId: `melt-settlement-${dataHash.slice(0, 32)}`,
    operationId,
    source: 'lightning' as const,
    event: 'settlement_verified',
    dataHash,
  };
}

function supportsCachedEndpoint(
  client: CashuTsLifecycleClient,
  method: 'GET' | 'POST',
  path: string,
): boolean {
  try {
    const info = client.getMintInfo();
    if (typeof info !== 'object' || info === null) return false;
    const isSupported = Reflect.get(info, 'isSupported');
    if (typeof isSupported !== 'function') return false;
    const support = (isSupported as (nut: number) => unknown).call(info, 19);
    if (
      typeof support !== 'object' ||
      support === null ||
      Reflect.get(support, 'supported') !== true
    ) {
      return false;
    }
    const params = Reflect.get(support, 'params');
    const endpoints =
      typeof params === 'object' && params !== null
        ? Reflect.get(params, 'cached_endpoints')
        : undefined;
    return (
      Array.isArray(endpoints) &&
      endpoints.some(
        (endpoint) =>
          typeof endpoint === 'object' &&
          endpoint !== null &&
          Reflect.get(endpoint, 'method') === method &&
          Reflect.get(endpoint, 'path') === path,
      )
    );
  } catch {
    return false;
  }
}

function mintSupportsNut(info: unknown, nut: number, unit: string): boolean {
  if (typeof info !== 'object' || info === null) return false;
  const isSupported = Reflect.get(info, 'isSupported');
  if (typeof isSupported !== 'function') return false;
  try {
    const support = (isSupported as (value: number) => unknown).call(info, nut);
    if (typeof support !== 'object' || support === null) return false;
    if (Reflect.get(support, 'supported') === true) return true;
    if ((nut === 4 || nut === 5) && Reflect.get(support, 'disabled') === false) {
      const params = Reflect.get(support, 'params');
      return (
        Array.isArray(params) &&
        params.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            Reflect.get(item, 'method') === 'bolt11' &&
            Reflect.get(item, 'unit') === unit,
        )
      );
    }
    return false;
  } catch {
    return false;
  }
}

export class CashuTsLifecycleWallet implements CashuTsLifecycleWalletPort {
  readonly #mintUrl: string;
  readonly #unit: string;
  readonly #store: CashuTsLifecycleStore;
  readonly #walletFactory: (seed: Uint8Array) => CashuTsLifecycleClient;
  readonly #pollAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #lightning: CashuTsLifecycleLightningPort | undefined;
  #clientValue: CashuTsLifecycleClient | undefined;

  get supportsSendHandoff(): boolean {
    return this.#store.sendHandoffDurability === 'persistent';
  }

  constructor(options: CashuTsLifecycleWalletOptions) {
    validatedMintOrigin(options.mintUrl, options.allowUnsafeMint === true);
    this.#mintUrl = options.mintUrl;
    this.#unit = options.unit;
    this.#store = options.store;
    this.#walletFactory =
      options.walletFactory ??
      ((seed) =>
        new RealCashuTsLifecycleClient(
          new Wallet(
            new Mint(this.#mintUrl, {
              customRequest: createCashuTsNoRedirectRequest(this.#mintUrl),
            }),
            {
              unit: this.#unit,
              bip39seed: seed,
            },
          ),
          seed,
        ));
    this.#pollAttempts = positiveInteger(options.pollAttempts ?? 60, 'pollAttempts');
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 100, 'pollIntervalMs');
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#lightning = options.lightning;
  }

  async reset(seed: string): Promise<void> {
    const client = this.#walletFactory(seedBytes(seed));
    await client.loadMint();
    this.#clientValue = client;
  }

  async discoverSupportedNuts(): Promise<readonly number[]> {
    const existing = this.#clientValue;
    const client = existing ?? this.#walletFactory(seedBytes('capability-discovery'));
    if (existing === undefined) await client.loadMint();
    const info = client.getMintInfo();
    const nuts = [3];
    for (const nut of [4, 5, 7, 8, 9, 19]) {
      if (mintSupportsNut(info, nut, this.#unit)) nuts.push(nut);
    }
    if (nuts.includes(9)) nuts.push(13);
    return nuts;
  }

  async prepare(input: LifecycleOperationInput): Promise<CashuTsLifecyclePreparedRequest> {
    if (input.mint !== this.#mintUrl || input.unit !== this.#unit) {
      throw new Error('Cashu lifecycle wallet mint or unit is unsupported');
    }
    if (input.kind === 'swap' || input.kind === 'send') return this.#prepareTransfer(input);
    if (input.kind === 'receive') return this.#prepareReceive(input);
    if (input.kind === 'melt') return this.#prepareMelt(input);
    if (input.kind === 'restore') return this.#prepareRestore(input);
    if (input.kind === 'reconcile') return this.#prepareReconcile(input);
    if (input.kind !== 'mint')
      throw new Error('Cashu lifecycle wallet operation is not implemented');
    const client = await this.#client();
    let quote = await client.createMintQuoteBolt11(input.amount, 'cashu-fault-lab lifecycle mint');
    const originalQuote = mintQuote(quote, input.amount, this.#unit);
    let observedQuote = originalQuote;
    const quoteObservations = [quoteObservation('mint', originalQuote.state, quote)];
    const stateOrder = { UNPAID: 0, PAID: 1, ISSUED: 2 } as const;
    for (
      let attempt = 0;
      observedQuote.state !== 'PAID' && attempt < this.#pollAttempts;
      attempt += 1
    ) {
      const checkedValue = await client.checkMintQuoteBolt11(quote);
      const checked = mintQuote(checkedValue, input.amount, this.#unit);
      if (checked.quoteId !== originalQuote.quoteId) {
        throw new Error('Cashu lifecycle mint quote identity changed');
      }
      if (stateOrder[checked.state] < stateOrder[observedQuote.state]) {
        throw new Error('Cashu lifecycle mint quote state regressed');
      }
      quote = checkedValue;
      observedQuote = checked;
      quoteObservations.push(quoteObservation('mint', checked.state, checkedValue));
      if (observedQuote.state !== 'PAID') await this.#sleep(this.#pollIntervalMs);
    }
    if (observedQuote.state !== 'PAID')
      throw new Error('Cashu lifecycle mint quote did not become paid');
    const counter = await this.#reserveCounter(client.keysetId, input.operationId, 'mint');
    const preview = await client.prepareMint('bolt11', input.amount, quote, undefined, {
      type: 'deterministic',
      counter,
    });
    const material: MintRequestMaterial = {
      schemaVersion: 1,
      kind: 'mint',
      operationId: input.operationId,
      amount: input.amount,
      counter,
      quote: portableEncode(quote),
      preview: portableEncode(preview),
    };
    const request = requestDigest(
      '/v1/mint/bolt11',
      Reflect.get(preview as object, 'payload') as Record<string, unknown>,
    );
    return {
      requestMaterial: material,
      ...request,
      requestDigests: [request],
      requestHash: digest('cashu-ts-lifecycle-request', material),
      quoteHash: digest('cashu-ts-lifecycle-quote', quoteId(quote)),
      outputPlanHash: digest('cashu-ts-lifecycle-output-plan', [counter, material.preview]),
      amount: input.amount,
      quoteObservations,
    };
  }

  async submit(prepared: CashuTsLifecyclePreparedRequest): Promise<CashuTsLifecycleResult> {
    const material = parseRequestMaterial(prepared.requestMaterial);
    if (material.kind === 'swap' || material.kind === 'send') {
      return this.#submitTransfer(material, prepared);
    }
    if (material.kind === 'receive') return this.#submitReceive(material, prepared);
    if (material.kind === 'melt') return this.#submitMelt(material, prepared);
    if (material.kind === 'restore') return this.#submitRestore(material);
    if (material.kind === 'reconcile') return this.#submitReconcile(material);
    const client = await this.#client();
    const preview = portableDecode(material.preview);
    const proofs = await client.completeMint(preview);
    const records = proofs.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    if (
      records.length !== objectArray(preview, 'outputData').length ||
      new Set(records.map((proof) => proof.proofId)).size !== records.length
    ) {
      throw new Error('Cashu lifecycle mint proof cardinality is invalid');
    }
    const amount = records.reduce((total, proof) => total + proof.amount, 0);
    if (amount !== material.amount) throw new Error('Cashu lifecycle mint proof value is invalid');
    const proofSetHash = digest(
      'cashu-ts-lifecycle-proof-set',
      records.map((proof) => proof.proofId).sort(),
    );
    return {
      status: 'succeeded',
      amount,
      ...(prepared.quoteHash === undefined ? {} : { quoteHash: prepared.quoteHash }),
      proofChanges: { add: records, update: [] },
      evidence: [
        {
          effectId: `mint-${proofSetHash.slice(0, 32)}`,
          operationId: material.operationId,
          source: 'durable_state',
          event: 'proofs_persisted',
          dataHash: proofSetHash,
        },
      ],
    };
  }

  async #prepareTransfer(
    input: Extract<LifecycleOperationInput, { readonly kind: 'swap' | 'send' }>,
  ): Promise<CashuTsLifecyclePreparedRequest> {
    const client = await this.#client();
    const sendCounter = await this.#reserveCounter(
      client.keysetId,
      input.operationId,
      `${input.kind}-send`,
    );
    const keepCounter = await this.#reserveCounter(
      client.keysetId,
      input.operationId,
      `${input.kind}-keep`,
    );
    const available = (await this.#store.listProofs(this.#mintUrl, this.#unit)).filter(
      (proof) => proof.state === 'UNSPENT' && proof.bucket === 'available',
    );
    const preview = await client.prepareSwapToSend(
      input.amount,
      available.map(proofMaterial),
      { includeFees: true },
      {
        send: {
          type: 'deterministic',
          counter: sendCounter,
        },
        keep: {
          type: 'deterministic',
          counter: keepCounter,
        },
      },
    );
    const previewInputs = objectArray(preview, 'inputs');
    const inputProofIds = previewInputs.map(proofIdentity);
    if (new Set(inputProofIds).size !== inputProofIds.length) {
      throw new Error('Cashu lifecycle swap selected duplicate inputs');
    }
    const availableIds = new Set(available.map((proof) => proof.proofId));
    if (inputProofIds.length === 0 || inputProofIds.some((proofId) => !availableIds.has(proofId))) {
      throw new Error('Cashu lifecycle swap selected unknown inputs');
    }
    const amount = amountNumber(Reflect.get(preview as object, 'amount'));
    if (amount !== input.amount)
      throw new Error('Cashu lifecycle swap amount changed during prepare');
    const feesValue = Reflect.get(preview as object, 'fees');
    const inputFee = feesValue === undefined ? 0 : amountNumberOrZero(feesValue);
    const portablePreview = portableEncode(preview);
    const material: TransferRequestMaterial = {
      schemaVersion: 1,
      kind: input.kind,
      operationId: input.operationId,
      amount: input.amount,
      inputProofIds,
      preview: portablePreview,
      ...(input.kind === 'send' ? { recipient: input.recipient } : {}),
    };
    const request = requestDigest('/v1/swap', {
      inputs: wireInputs(previewInputs),
      outputs: wireSwapOutputs(
        previewInputs,
        blindedMessages(preview, 'keepOutputs'),
        blindedMessages(preview, 'sendOutputs'),
      ),
    });
    return {
      requestMaterial: material,
      ...request,
      requestDigests: [request],
      requestHash: digest('cashu-ts-lifecycle-request', material),
      outputPlanHash: digest('cashu-ts-lifecycle-output-plan', portablePreview),
      amount: input.amount,
      inputFee,
      proofChanges: {
        add: [],
        update: inputProofIds.map((proofId) => ({
          proofId,
          state: 'PENDING' as const,
          bucket: 'reserved' as const,
        })),
      },
    };
  }

  async #submitTransfer(
    material: TransferRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    const preview = portableDecode(material.preview);
    const result = await client.completeSwap(preview);
    const keep = objectArray(result, 'keep');
    const send = objectArray(result, 'send');
    const oldIds = new Set(material.inputProofIds);
    const expectedUnselected = new Map(
      optionalObjectArray(preview, 'unselectedProofs').map((proof) => [
        proofIdentity(proof),
        digest('cashu-ts-lifecycle-proof-material', portableEncode(proof)),
      ]),
    );
    const returnedUnselected = new Set<string>();
    const keepRecords = keep.flatMap((proof) => {
      const proofId = proofIdentity(proof);
      if (oldIds.has(proofId)) {
        throw new Error('Cashu lifecycle swap output reuses an input identity');
      }
      const expectedHash = expectedUnselected.get(proofId);
      if (expectedHash === undefined) {
        return [proofRecord(proof, this.#mintUrl, this.#unit)];
      }
      if (
        returnedUnselected.has(proofId) ||
        digest('cashu-ts-lifecycle-proof-material', portableEncode(proof)) !== expectedHash
      ) {
        throw new Error('Cashu lifecycle unselected proof identity changed');
      }
      returnedUnselected.add(proofId);
      return [];
    });
    const sendRecords = send.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    if (
      sendRecords.some(
        (proof) => oldIds.has(proof.proofId) || expectedUnselected.has(proof.proofId),
      )
    ) {
      throw new Error('Cashu lifecycle swap output reuses an input identity');
    }
    const records = [...keepRecords, ...sendRecords];
    if (
      returnedUnselected.size !== expectedUnselected.size ||
      keepRecords.length !== objectArray(preview, 'keepOutputs').length ||
      sendRecords.length !== objectArray(preview, 'sendOutputs').length ||
      new Set(records.map((proof) => proof.proofId)).size !== records.length
    ) {
      throw new Error('Cashu lifecycle swap proof cardinality is invalid');
    }
    const inputProofs = objectArray(preview, 'inputs');
    const inputTotal = inputProofs.reduce<number>(
      (total, proof) => total + amountNumber(Reflect.get(proof as object, 'amount')),
      0,
    );
    const outputTotal = records.reduce((total, proof) => total + proof.amount, 0);
    const inputFee = prepared.inputFee ?? 0;
    if (outputTotal !== inputTotal - inputFee) {
      throw new Error('Cashu lifecycle swap value is invalid');
    }
    const handoff = material.kind === 'send' ? await this.#handoffSend(material, send) : undefined;
    return {
      status: 'succeeded',
      amount: material.amount,
      inputFee,
      proofChanges: {
        add: material.kind === 'send' ? keepRecords : records,
        update: material.inputProofIds.map((proofId) => ({
          proofId,
          state: 'SPENT' as const,
          bucket: 'reserved' as const,
        })),
      },
      ...handoff,
    };
  }

  async #prepareReceive(
    input: Extract<LifecycleOperationInput, { readonly kind: 'receive' }>,
  ): Promise<CashuTsLifecyclePreparedRequest> {
    const client = await this.#client();
    const counter = await this.#reserveCounter(client.keysetId, input.operationId, 'receive');
    const preview = await client.prepareSwapToReceive(input.token, undefined, {
      type: 'deterministic',
      counter,
    });
    const inputProofIds = objectArray(preview, 'inputs').map(proofIdentity);
    if (inputProofIds.length === 0 || new Set(inputProofIds).size !== inputProofIds.length) {
      throw new Error('Cashu lifecycle receive input cardinality is invalid');
    }
    const amount = amountNumber(Reflect.get(preview as object, 'amount'));
    const inputFee = amountNumberOrZero(Reflect.get(preview as object, 'fees'));
    const portablePreview = portableEncode(preview);
    const material: ReceiveRequestMaterial = {
      schemaVersion: 1,
      kind: 'receive',
      operationId: input.operationId,
      token: input.token,
      inputProofIds,
      preview: portablePreview,
    };
    const previewInputs = objectArray(preview, 'inputs');
    const request = requestDigest('/v1/swap', {
      inputs: wireInputs(previewInputs),
      outputs: wireSwapOutputs(previewInputs, blindedMessages(preview, 'keepOutputs')),
    });
    return {
      requestMaterial: material,
      ...request,
      requestDigests: [request],
      requestHash: digest('cashu-ts-lifecycle-request', material),
      outputPlanHash: digest('cashu-ts-lifecycle-output-plan', portablePreview),
      amount,
      inputFee,
    };
  }

  async #submitReceive(
    material: ReceiveRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    const preview = portableDecode(material.preview);
    const result = await client.completeSwap(preview);
    const keep = objectArray(result, 'keep');
    const send = objectArray(result, 'send');
    if (send.length !== 0) throw new Error('Cashu lifecycle receive returned send proofs');
    const records = keep.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    const inputProofIds = new Set(material.inputProofIds);
    if (records.some((proof) => inputProofIds.has(proof.proofId))) {
      throw new Error('Cashu lifecycle receive output reuses an input identity');
    }
    if (
      records.length !== objectArray(preview, 'keepOutputs').length ||
      new Set(records.map((proof) => proof.proofId)).size !== records.length
    ) {
      throw new Error('Cashu lifecycle receive proof cardinality is invalid');
    }
    const inputTotal = objectArray(preview, 'inputs').reduce<number>(
      (total, proof) => total + amountNumber(Reflect.get(proof as object, 'amount')),
      0,
    );
    const outputTotal = records.reduce((total, proof) => total + proof.amount, 0);
    const inputFee = prepared.inputFee ?? 0;
    if (outputTotal !== inputTotal - inputFee) {
      throw new Error('Cashu lifecycle receive value is invalid');
    }
    return {
      status: 'succeeded',
      amount: prepared.amount ?? outputTotal,
      inputFee,
      proofChanges: { add: records, update: [] },
    };
  }

  async #prepareMelt(
    input: Extract<LifecycleOperationInput, { readonly kind: 'melt' }>,
  ): Promise<CashuTsLifecyclePreparedRequest> {
    const client = await this.#client();
    const changeCounter = await this.#reserveCounter(
      client.keysetId,
      input.operationId,
      'melt-change',
    );
    const quote = await client.createMeltQuoteBolt11(input.invoice);
    const quoteRecord = meltQuote(quote, input.invoice, this.#unit);
    const available = (await this.#store.listProofs(this.#mintUrl, this.#unit)).filter(
      (proof) => proof.state === 'UNSPENT' && proof.bucket === 'available',
    );
    const preview = await client.prepareMelt(
      'bolt11',
      quote,
      available.map(proofMaterial),
      { nut08Change: true },
      { type: 'deterministic', counter: changeCounter },
    );
    const inputProofIds = objectArray(preview, 'inputs').map(proofIdentity);
    const availableIds = new Set(available.map((proof) => proof.proofId));
    if (
      inputProofIds.length === 0 ||
      new Set(inputProofIds).size !== inputProofIds.length ||
      inputProofIds.some((proofId) => !availableIds.has(proofId))
    ) {
      throw new Error('Cashu lifecycle melt selected invalid inputs');
    }
    const selected = available.filter((proof) => inputProofIds.includes(proof.proofId));
    const inputTotal = selected.reduce((total, proof) => total + proof.amount, 0);
    if (inputTotal < quoteRecord.amount)
      throw new Error('Cashu lifecycle melt inputs are insufficient');
    const inputFee = amountNumberOrZero(client.getFeesForProofs(selected.map(proofMaterial)));
    const portableQuote = portableEncode(quote);
    const portablePreview = portableEncode(preview);
    const material: MeltRequestMaterial = {
      schemaVersion: 1,
      kind: 'melt',
      operationId: input.operationId,
      invoice: input.invoice,
      inputProofIds,
      quote: portableQuote,
      preview: portablePreview,
      preferAsync: input.preferAsync ?? false,
    };
    const request = requestDigest('/v1/melt/bolt11', {
      quote: quoteRecord.quoteId,
      inputs: wireInputs(objectArray(preview, 'inputs')),
      outputs: blindedMessages(preview, 'outputData'),
      ...(material.preferAsync ? { prefer_async: true } : {}),
    });
    return {
      requestMaterial: material,
      ...request,
      requestDigests: [request],
      requestHash: digest('cashu-ts-lifecycle-request', material),
      quoteHash: digest('cashu-ts-lifecycle-quote', quoteRecord.quoteId),
      outputPlanHash: digest('cashu-ts-lifecycle-output-plan', portablePreview),
      amount: quoteRecord.amount,
      feeReserve: quoteRecord.feeReserve,
      inputFee,
      quoteObservations: [quoteObservation('melt', quoteRecord.state, quote)],
      proofChanges: {
        add: [],
        update: inputProofIds.map((proofId) => ({
          proofId,
          state: 'PENDING' as const,
          bucket: 'reserved' as const,
        })),
      },
    };
  }

  async #submitMelt(
    material: MeltRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    const preview = portableDecode(material.preview);
    const response = await client.completeMelt(preview, undefined, {
      preferAsync: material.preferAsync,
    });
    if (typeof response !== 'object' || response === null) {
      throw new Error('Cashu lifecycle melt response is invalid');
    }
    const quote = Reflect.get(response, 'quote');
    const quoteRecord = meltQuote(quote, material.invoice, this.#unit);
    const originalQuote = meltQuote(portableDecode(material.quote), material.invoice, this.#unit);
    if (
      quoteRecord.quoteId !== originalQuote.quoteId ||
      quoteRecord.amount !== originalQuote.amount ||
      quoteRecord.feeReserve !== originalQuote.feeReserve
    ) {
      throw new Error('Cashu lifecycle melt quote identity changed');
    }
    const quoteObservations = [quoteObservation('melt', quoteRecord.state, quote)];
    if (quoteRecord.state !== 'PAID') return { status: 'ambiguous', quoteObservations };
    if (!(await this.#lightningSettled(material.invoice, prepared.quoteHash ?? ''))) {
      return {
        status: 'recovery_blocked',
        evidenceCode: 'lightning_settlement_unverified',
        quoteObservations,
      };
    }
    const change = objectArray(response, 'change').map((proof) =>
      proofRecord(proof, this.#mintUrl, this.#unit),
    );
    if (
      change.some((proof) => material.inputProofIds.includes(proof.proofId)) ||
      new Set(change.map((proof) => proof.proofId)).size !== change.length
    ) {
      throw new Error('Cashu lifecycle melt change identity is invalid');
    }
    const changeAmount = change.reduce((total, proof) => total + proof.amount, 0);
    const proofs = await this.#store.listProofs(this.#mintUrl, this.#unit);
    const inputTotal = proofs
      .filter((proof) => material.inputProofIds.includes(proof.proofId))
      .reduce((total, proof) => total + proof.amount, 0);
    if (inputTotal < quoteRecord.amount + changeAmount) {
      throw new Error('Cashu lifecycle melt value is invalid');
    }
    const inputFee = prepared.inputFee ?? 0;
    const actualFee = inputTotal - quoteRecord.amount - changeAmount - inputFee;
    if (actualFee < 0 || actualFee > quoteRecord.feeReserve) {
      throw new Error('Cashu lifecycle melt fee exceeds reserve');
    }
    return {
      status: 'succeeded',
      amount: quoteRecord.amount,
      inputFee,
      feeReserve: quoteRecord.feeReserve,
      actualFee,
      change: changeAmount,
      quoteObservations,
      evidence: [
        lightningSettlementEvidence(
          material.operationId,
          material.invoice,
          prepared.quoteHash ?? '',
        ),
      ],
      ...(prepared.quoteHash === undefined ? {} : { quoteHash: prepared.quoteHash }),
      proofChanges: {
        add: change,
        update: material.inputProofIds.map((proofId) => ({
          proofId,
          state: 'SPENT' as const,
          bucket: 'reserved' as const,
        })),
      },
    };
  }

  async #prepareRestore(
    input: Extract<LifecycleOperationInput, { readonly kind: 'restore' }>,
  ): Promise<CashuTsLifecyclePreparedRequest> {
    const client = await this.#client();
    const highWatermarks = [...(await this.#store.counterHighWatermarks())];
    if (!highWatermarks.some(({ keysetId }) => keysetId === client.keysetId)) {
      highWatermarks.push({ keysetId: client.keysetId, nextCounter: 0 });
    }
    const keysets = await Promise.all(
      highWatermarks.map(async ({ keysetId, nextCounter }) => {
        const count = Math.max(nextCounter + RESTORE_GAP_COUNT, RESTORE_GAP_COUNT);
        return {
          keysetId,
          start: 0,
          count,
          outputs: portableEncode(await client.prepareRestoreOutputs(0, count, keysetId)),
        } as const;
      }),
    );
    const active = keysets.find(({ keysetId }) => keysetId === client.keysetId)!;
    const material: RestoreRequestMaterial = {
      schemaVersion: 1,
      kind: 'restore',
      operationId: input.operationId,
      start: 0,
      count: active.count,
      batchSize: COUNTER_RANGE_SIZE,
      keysetId: client.keysetId,
      outputs: active.outputs,
      keysets,
    };
    const requests = keysets.flatMap((plan) => {
      const decodedOutputs = portableDecode(plan.outputs) as readonly unknown[];
      return Array.from(
        { length: Math.ceil(decodedOutputs.length / COUNTER_RANGE_SIZE) },
        (_, batchIndex) =>
          requestDigest('/v1/restore', {
            outputs: decodedOutputs
              .slice(batchIndex * COUNTER_RANGE_SIZE, (batchIndex + 1) * COUNTER_RANGE_SIZE)
              .map((output) => Reflect.get(output as object, 'blindedMessage')),
          }),
      );
    });
    return {
      requestMaterial: material,
      requestDigests: requests,
      requestHash: digest('cashu-ts-lifecycle-request', material),
      outputPlanHash: digest('cashu-ts-lifecycle-output-plan', material.keysets),
    };
  }

  async #submitRestore(material: RestoreRequestMaterial): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    const proofs: unknown[] = [];
    let outputCount = 0;
    for (const plan of material.keysets) {
      const outputs = portableDecode(plan.outputs);
      if (!Array.isArray(outputs) || outputs.length !== plan.count) {
        throw new Error('Cashu lifecycle restore output cardinality is invalid');
      }
      outputCount += outputs.length;
      for (let start = 0; start < outputs.length; start += material.batchSize) {
        const batch = outputs.slice(start, start + material.batchSize);
        const restored = await client.restoreOutputs(batch);
        if (restored.length > batch.length) {
          throw new Error('Cashu lifecycle restore proof cardinality is invalid');
        }
        proofs.push(...restored);
      }
    }
    if (proofs.length > outputCount) {
      throw new Error('Cashu lifecycle restore proof cardinality is invalid');
    }
    const records = proofs.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    if (new Set(records.map((proof) => proof.proofId)).size !== records.length) {
      throw new Error('Cashu lifecycle restore proof identity is invalid');
    }
    const states = await this.#validatedProofStates(proofs);
    const existing = new Set(
      (await this.#store.listProofs(this.#mintUrl, this.#unit)).map((proof) => proof.proofId),
    );
    const additions = records.flatMap((record, index) => {
      if (existing.has(record.proofId)) return [];
      const state = states[index]!;
      return [
        {
          ...record,
          state,
          bucket: state === 'UNSPENT' ? ('available' as const) : ('recoverable' as const),
        },
      ];
    });
    return {
      status: 'succeeded',
      amount: additions
        .filter((proof) => proof.state === 'UNSPENT')
        .reduce((total, proof) => total + proof.amount, 0),
      proofChanges: { add: additions, update: [] },
    };
  }

  async #reserveCounter(keysetId: string, operationId: string, purpose: string): Promise<number> {
    const range = await this.#store.reserveCounterRange(
      keysetId,
      `${operationId}:${purpose}`,
      COUNTER_RANGE_SIZE,
    );
    return range.start;
  }

  async #prepareReconcile(
    input: Extract<LifecycleOperationInput, { readonly kind: 'reconcile' }>,
  ): Promise<CashuTsLifecyclePreparedRequest> {
    const target = await this.#store.get(input.targetOperationId);
    if (target?.prepared === undefined) {
      throw new Error('Cashu lifecycle reconcile target has no prepared request');
    }
    const targetMaterial = parseRequestMaterial(target.prepared.requestMaterial);
    if (!('inputProofIds' in targetMaterial) || targetMaterial.inputProofIds.length === 0) {
      throw new Error('Cashu lifecycle reconcile target has no inputs');
    }
    const storedProofs = await this.#store.listProofs(this.#mintUrl, this.#unit);
    const byId = new Map(storedProofs.map((proof) => [proof.proofId, proof]));
    const proofs = targetMaterial.inputProofIds.map((proofId) => byId.get(proofId));
    if (proofs.some((proof) => proof === undefined)) {
      throw new Error('Cashu lifecycle reconcile input proof is missing');
    }
    const material: ReconcileRequestMaterial = {
      schemaVersion: 1,
      kind: 'reconcile',
      operationId: input.operationId,
      targetOperationId: input.targetOperationId,
      inputProofIds: targetMaterial.inputProofIds,
      ys: proofs.map((proof) => proofY(proofMaterial(proof!))),
    };
    const request = requestDigest('/v1/checkstate', { Ys: material.ys });
    return {
      requestMaterial: material,
      ...request,
      requestDigests: [request],
      requestHash: digest('cashu-ts-lifecycle-request', material),
    };
  }

  async #submitReconcile(material: ReconcileRequestMaterial): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    const storedProofs = await this.#store.listProofs(this.#mintUrl, this.#unit);
    const byId = new Map(storedProofs.map((proof) => [proof.proofId, proof]));
    const proofs = material.inputProofIds.map((proofId) => byId.get(proofId));
    if (proofs.some((proof) => proof === undefined)) {
      throw new Error('Cashu lifecycle reconcile input proof is missing');
    }
    const proofMaterials = proofs.map((proof) => proofMaterial(proof!));
    const ys = proofMaterials.map(proofY);
    if (JSON.stringify(ys) !== JSON.stringify(material.ys)) {
      throw new Error('Cashu lifecycle reconcile request identity changed');
    }
    const states = await client.checkProofsStates(proofMaterials);
    if (states.length !== material.inputProofIds.length) {
      throw new Error('Cashu lifecycle proof-state cardinality is invalid');
    }
    const updates = states.map((state, index) => {
      if (typeof state !== 'object' || state === null || Reflect.get(state, 'Y') !== ys[index]) {
        throw new Error('Cashu lifecycle proof-state identity is invalid');
      }
      const stateValue = Reflect.get(state, 'state');
      if (stateValue !== 'UNSPENT' && stateValue !== 'PENDING' && stateValue !== 'SPENT') {
        throw new Error('Cashu lifecycle proof state is invalid');
      }
      return {
        proofId: material.inputProofIds[index]!,
        state: stateValue,
        bucket: stateValue === 'UNSPENT' ? ('available' as const) : ('reserved' as const),
        reservationOperationId: material.targetOperationId,
      };
    });
    return {
      status: 'succeeded',
      amount: proofs.reduce((total, proof) => total + proof!.amount, 0),
      proofChanges: { add: [], update: updates },
    };
  }

  async recover(
    input: LifecycleOperationInput,
    _view: LifecycleOperationView,
    prepared?: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    if (prepared === undefined) {
      return { status: 'recovery_blocked', evidenceCode: 'request_material_missing' };
    }
    const material = parseRequestMaterial(prepared.requestMaterial);
    const client = await this.#client();
    const replayPath =
      material.kind === 'mint'
        ? '/v1/mint/bolt11'
        : material.kind === 'melt'
          ? '/v1/melt/bolt11'
          : material.kind === 'restore'
            ? '/v1/restore'
            : material.kind === 'reconcile'
              ? '/v1/checkstate'
              : '/v1/swap';
    if (supportsCachedEndpoint(client, 'POST', replayPath)) {
      try {
        return { ...(await this.submit(prepared)), recoveryMechanism: 'nut19_replay' };
      } catch {
        // Continue with quote, proof-state, and exact-output recovery.
      }
    }
    if (material.kind === 'swap' || material.kind === 'send') {
      const result = await this.#recoverTransfer(material, prepared);
      return {
        ...result,
        recoveryMechanism:
          result.status === 'succeeded' ||
          ('evidenceCode' in result && result.evidenceCode.startsWith('nut09_'))
            ? 'nut09_restore'
            : 'proof_state',
      };
    }
    if (material.kind === 'receive') {
      const result = await this.#recoverReceive(material, prepared);
      return {
        ...result,
        recoveryMechanism:
          result.status === 'succeeded' ||
          ('evidenceCode' in result && result.evidenceCode.startsWith('nut09_'))
            ? 'nut09_restore'
            : 'proof_state',
      };
    }
    if (material.kind === 'melt') {
      return { ...(await this.#recoverMelt(material, prepared)), recoveryMechanism: 'quote_state' };
    }
    if (material.kind === 'mint') return this.#recoverMint(material, prepared);
    if (material.kind === 'restore' || material.kind === 'reconcile') {
      try {
        return {
          ...(await this.submit(prepared)),
          recoveryMechanism: material.kind === 'restore' ? 'nut13_seed' : 'proof_state',
        };
      } catch {
        return { status: 'recovery_blocked', evidenceCode: 'recovery_request_failed' };
      }
    }
    return { status: 'recovery_blocked', evidenceCode: 'operation_not_supported' };
  }

  async #recoverTransfer(
    material: TransferRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const preview = portableDecode(material.preview);
    const inputProofs = objectArray(preview, 'inputs');
    let states: readonly ('UNSPENT' | 'PENDING' | 'SPENT')[];
    try {
      states = await this.#validatedProofStates(inputProofs);
    } catch {
      return { status: 'recovery_blocked', evidenceCode: 'proof_state_unavailable' };
    }
    if (states.every((state) => state === 'PENDING')) return { status: 'ambiguous' };
    if (states.every((state) => state === 'UNSPENT')) {
      return {
        status: 'recovery_blocked',
        evidenceCode: 'inputs_unspent_without_replay_fence',
      };
    }
    if (!states.every((state) => state === 'SPENT')) {
      return { status: 'recovery_blocked', evidenceCode: 'mixed_input_states' };
    }
    const keepOutputs = objectArray(preview, 'keepOutputs');
    const sendOutputs = objectArray(preview, 'sendOutputs');
    let restored: readonly unknown[];
    try {
      restored = await (await this.#client()).restoreOutputs([...keepOutputs, ...sendOutputs]);
    } catch {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_failed' };
    }
    if (restored.length !== keepOutputs.length + sendOutputs.length) {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_incomplete' };
    }
    const keep = restored.slice(0, keepOutputs.length);
    const send = restored.slice(keepOutputs.length);
    const keepRecords = keep.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    const sendRecords = send.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    const records = [...keepRecords, ...sendRecords];
    if (
      records.some((proof) => material.inputProofIds.includes(proof.proofId)) ||
      new Set(records.map((proof) => proof.proofId)).size !== records.length
    ) {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_invalid' };
    }
    const inputTotal = inputProofs.reduce<number>(
      (total, proof) => total + amountNumber(Reflect.get(proof as object, 'amount')),
      0,
    );
    if (
      records.reduce((total, proof) => total + proof.amount, 0) !==
      inputTotal - (prepared.inputFee ?? 0)
    ) {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_value_invalid' };
    }
    const handoff = material.kind === 'send' ? await this.#handoffSend(material, send) : undefined;
    return {
      status: 'succeeded',
      amount: material.amount,
      inputFee: prepared.inputFee ?? 0,
      proofChanges: {
        add: material.kind === 'send' ? keepRecords : records,
        update: material.inputProofIds.map((proofId) => ({
          proofId,
          state: 'SPENT' as const,
          bucket: 'reserved' as const,
        })),
      },
      ...handoff,
    };
  }

  async #handoffSend(
    material: TransferRequestMaterial,
    proofs: readonly unknown[],
  ): Promise<Pick<CashuTsLifecycleResult & object, 'resultMaterial' | 'evidence'>> {
    if (material.kind !== 'send' || material.recipient === undefined) {
      throw new Error('Cashu lifecycle send recipient is missing');
    }
    const token = getEncodedToken({
      mint: this.#mintUrl,
      unit: this.#unit,
      proofs: normalizeProofAmounts(proofs as Parameters<typeof normalizeProofAmounts>[0]),
    });
    const tokenHash = await this.#store.putSendHandoff(
      material.operationId,
      material.recipient,
      token,
    );
    return {
      resultMaterial: { kind: 'send', recipient: material.recipient, token },
      evidence: [
        {
          effectId: `send-handoff-${tokenHash.slice(0, 32)}`,
          operationId: material.operationId,
          source: 'durable_state',
          event: 'token_outbox_persisted',
          dataHash: tokenHash,
        },
      ],
    };
  }

  async #validatedProofStates(
    proofs: readonly unknown[],
  ): Promise<readonly ('UNSPENT' | 'PENDING' | 'SPENT')[]> {
    const ys = proofs.map(proofY);
    const states = await (await this.#client()).checkProofsStates(proofs);
    if (states.length !== proofs.length) {
      throw new Error('Cashu lifecycle proof-state cardinality is invalid');
    }
    return states.map((state, index) => {
      if (typeof state !== 'object' || state === null || Reflect.get(state, 'Y') !== ys[index]) {
        throw new Error('Cashu lifecycle proof-state identity is invalid');
      }
      const value = Reflect.get(state, 'state');
      if (value !== 'UNSPENT' && value !== 'PENDING' && value !== 'SPENT') {
        throw new Error('Cashu lifecycle proof state is invalid');
      }
      return value;
    });
  }

  async #recoverReceive(
    material: ReceiveRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const preview = portableDecode(material.preview);
    const inputs = objectArray(preview, 'inputs');
    let states: readonly ('UNSPENT' | 'PENDING' | 'SPENT')[];
    try {
      states = await this.#validatedProofStates(inputs);
    } catch {
      return { status: 'recovery_blocked', evidenceCode: 'proof_state_unavailable' };
    }
    if (states.every((state) => state === 'PENDING')) return { status: 'ambiguous' };
    if (states.every((state) => state === 'UNSPENT')) {
      return {
        status: 'recovery_blocked',
        evidenceCode: 'inputs_unspent_without_replay_fence',
      };
    }
    if (!states.every((state) => state === 'SPENT')) {
      return { status: 'recovery_blocked', evidenceCode: 'mixed_input_states' };
    }
    const outputs = objectArray(preview, 'keepOutputs');
    let restored: readonly unknown[];
    try {
      restored = await (await this.#client()).restoreOutputs(outputs);
    } catch {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_failed' };
    }
    if (restored.length !== outputs.length) {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_incomplete' };
    }
    const records = restored.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    if (
      records.some((proof) => material.inputProofIds.includes(proof.proofId)) ||
      new Set(records.map((proof) => proof.proofId)).size !== records.length
    ) {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_invalid' };
    }
    const inputTotal = inputs.reduce<number>(
      (total, proof) => total + amountNumber(Reflect.get(proof as object, 'amount')),
      0,
    );
    const outputTotal = records.reduce((total, proof) => total + proof.amount, 0);
    if (outputTotal !== inputTotal - (prepared.inputFee ?? 0)) {
      return { status: 'recovery_blocked', evidenceCode: 'nut09_restore_value_invalid' };
    }
    return {
      status: 'succeeded',
      amount: prepared.amount ?? outputTotal,
      inputFee: prepared.inputFee ?? 0,
      proofChanges: { add: records, update: [] },
    };
  }

  async #recoverMelt(
    material: MeltRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    const quoteObservations: ReturnType<typeof quoteObservation>[] = [];
    const finish = (result: CashuTsLifecycleResult): CashuTsLifecycleResult => ({
      ...result,
      quoteObservations,
    });
    const originalQuote = meltQuote(portableDecode(material.quote), material.invoice, this.#unit);
    let quote: unknown = portableDecode(material.quote);
    let observed = originalQuote;
    const stateOrder = { UNPAID: 0, PENDING: 1, PAID: 2 } as const;
    try {
      for (
        let attempt = 0;
        attempt < this.#pollAttempts && observed.state !== 'PAID';
        attempt += 1
      ) {
        quote = await client.checkMeltQuoteBolt11(quote);
        const checked = meltQuote(quote, material.invoice, this.#unit);
        if (
          checked.quoteId !== originalQuote.quoteId ||
          checked.amount !== originalQuote.amount ||
          checked.feeReserve !== originalQuote.feeReserve
        ) {
          return finish({
            status: 'recovery_blocked',
            evidenceCode: 'melt_quote_identity_changed',
          });
        }
        quoteObservations.push(quoteObservation('melt', checked.state, quote));
        if (stateOrder[checked.state] < stateOrder[observed.state]) {
          return finish({ status: 'recovery_blocked', evidenceCode: 'melt_quote_state_regressed' });
        }
        observed = checked;
        if (observed.state !== 'PAID') await this.#sleep(this.#pollIntervalMs);
      }
    } catch {
      return finish({ status: 'recovery_blocked', evidenceCode: 'melt_quote_unavailable' });
    }
    if (observed.state === 'PENDING') return finish({ status: 'ambiguous' });
    if (observed.state === 'UNPAID') {
      const preview = portableDecode(material.preview);
      let states: readonly ('UNSPENT' | 'PENDING' | 'SPENT')[];
      try {
        states = await this.#validatedProofStates(objectArray(preview, 'inputs'));
      } catch {
        return finish({ status: 'recovery_blocked', evidenceCode: 'proof_state_unavailable' });
      }
      if (states.every((state) => state === 'UNSPENT')) {
        return finish({
          status: 'recovery_blocked',
          evidenceCode: 'melt_unpaid_inputs_unspent_without_replay_fence',
        });
      }
      if (states.every((state) => state === 'PENDING')) return finish({ status: 'ambiguous' });
      return finish({
        status: 'recovery_blocked',
        evidenceCode: 'melt_quote_proof_state_conflict',
      });
    }
    if (!(await this.#lightningSettled(material.invoice, prepared.quoteHash ?? ''))) {
      return finish({
        status: 'recovery_blocked',
        evidenceCode: 'lightning_settlement_unverified',
      });
    }
    const preview = portableDecode(material.preview);
    const outputData = objectArray(preview, 'outputData');
    const signatures = optionalObjectArray(quote, 'change');
    if (signatures.length > outputData.length) {
      return finish({
        status: 'recovery_blocked',
        evidenceCode: 'nut08_change_cardinality_invalid',
      });
    }
    let change: readonly CashuTsLifecycleStoredProof[];
    try {
      change = client
        .createMeltChangeProofs(outputData, signatures)
        .map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    } catch {
      return finish({ status: 'recovery_blocked', evidenceCode: 'nut08_change_invalid' });
    }
    if (
      change.some((proof) => material.inputProofIds.includes(proof.proofId)) ||
      change.length !== signatures.length ||
      new Set(change.map((proof) => proof.proofId)).size !== change.length
    ) {
      return finish({ status: 'recovery_blocked', evidenceCode: 'nut08_change_invalid' });
    }
    const proofs = await this.#store.listProofs(this.#mintUrl, this.#unit);
    const inputs = proofs.filter((proof) => material.inputProofIds.includes(proof.proofId));
    if (inputs.length !== material.inputProofIds.length) {
      return finish({
        status: 'recovery_blocked',
        evidenceCode: 'melt_input_material_missing',
      });
    }
    const inputTotal = inputs.reduce((total, proof) => total + proof.amount, 0);
    const changeAmount = change.reduce((total, proof) => total + proof.amount, 0);
    const inputFee = prepared.inputFee ?? 0;
    const actualFee = inputTotal - observed.amount - changeAmount - inputFee;
    if (actualFee < 0 || actualFee > observed.feeReserve) {
      return finish({
        status: 'recovery_blocked',
        evidenceCode: 'melt_recovered_value_invalid',
      });
    }
    return finish({
      status: 'succeeded',
      amount: observed.amount,
      inputFee,
      feeReserve: observed.feeReserve,
      actualFee,
      change: changeAmount,
      ...(prepared.quoteHash === undefined ? {} : { quoteHash: prepared.quoteHash }),
      evidence: [
        lightningSettlementEvidence(
          material.operationId,
          material.invoice,
          prepared.quoteHash ?? '',
        ),
      ],
      proofChanges: {
        add: change,
        update: material.inputProofIds.map((proofId) => ({
          proofId,
          state: 'SPENT' as const,
          bucket: 'reserved' as const,
        })),
      },
    });
  }

  async #recoverMint(
    material: MintRequestMaterial,
    prepared: CashuTsLifecyclePreparedRequest,
  ): Promise<CashuTsLifecycleResult> {
    const client = await this.#client();
    let checked: { readonly quoteId: string; readonly state: 'UNPAID' | 'PAID' | 'ISSUED' };
    let checkedValue: unknown;
    try {
      const original = mintQuote(portableDecode(material.quote), material.amount, this.#unit);
      checkedValue = await client.checkMintQuoteBolt11(portableDecode(material.quote));
      checked = mintQuote(checkedValue, material.amount, this.#unit);
      if (checked.quoteId !== original.quoteId) {
        return {
          status: 'recovery_blocked',
          evidenceCode: 'mint_quote_identity_changed',
          recoveryMechanism: 'quote_state',
        };
      }
      if (original.state === 'PAID' && checked.state === 'UNPAID') {
        return {
          status: 'recovery_blocked',
          evidenceCode: 'mint_quote_state_regressed',
          recoveryMechanism: 'quote_state',
          quoteObservations: [quoteObservation('mint', checked.state, checkedValue)],
        };
      }
    } catch {
      return {
        status: 'recovery_blocked',
        evidenceCode: 'mint_quote_unavailable',
        recoveryMechanism: 'quote_state',
      };
    }
    const quoteObservations = [quoteObservation('mint', checked.state, checkedValue)];
    const preview = portableDecode(material.preview);
    const outputs = objectArray(preview, 'outputData');
    let restored: readonly unknown[];
    try {
      restored = await client.restoreOutputs(outputs);
    } catch {
      restored = [];
    }
    if (restored.length === outputs.length) {
      let records: readonly CashuTsLifecycleStoredProof[];
      try {
        records = restored.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
      } catch {
        return {
          status: 'recovery_blocked',
          evidenceCode: 'nut09_restore_invalid',
          recoveryMechanism: 'nut09_restore',
          quoteObservations,
        };
      }
      if (
        new Set(records.map((proof) => proof.proofId)).size !== records.length ||
        records.reduce((total, proof) => total + proof.amount, 0) !== material.amount
      ) {
        return {
          status: 'recovery_blocked',
          evidenceCode: 'nut09_restore_value_invalid',
          recoveryMechanism: 'nut09_restore',
          quoteObservations,
        };
      }
      return {
        status: 'succeeded',
        amount: material.amount,
        ...(prepared.quoteHash === undefined ? {} : { quoteHash: prepared.quoteHash }),
        proofChanges: { add: records, update: [] },
        recoveryMechanism: 'nut09_restore',
        quoteObservations,
      };
    }
    if (checked.state === 'ISSUED') {
      return {
        status: 'recovery_blocked',
        evidenceCode: 'nut09_restore_incomplete',
        recoveryMechanism: 'nut09_restore',
        quoteObservations,
      };
    }
    if (checked.state === 'UNPAID') {
      return {
        status: 'failed_definitive',
        evidenceCode: 'mint_quote_unpaid',
        recoveryMechanism: 'quote_state',
        quoteObservations,
      };
    }
    return {
      status: 'recovery_blocked',
      evidenceCode: 'nut09_restore_incomplete',
      recoveryMechanism: 'nut09_restore',
      quoteObservations,
    };
  }

  async #client(): Promise<CashuTsLifecycleClient> {
    if (this.#clientValue !== undefined) return this.#clientValue;
    const seed = await this.#store.loadSeed();
    if (seed === undefined) throw new Error('Cashu lifecycle wallet seed is unavailable');
    const client = this.#walletFactory(seedBytes(seed));
    await client.loadMint();
    this.#clientValue = client;
    return client;
  }

  async #lightningSettled(invoice: string, quoteHash: string): Promise<boolean> {
    if (this.#lightning === undefined) return false;
    try {
      return await this.#lightning.settled(invoice, quoteHash);
    } catch {
      return false;
    }
  }
}
