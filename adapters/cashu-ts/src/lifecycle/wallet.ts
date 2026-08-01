import { Amount, OutputData, Wallet } from '@cashu/cashu-ts';
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

export interface CashuTsLifecycleClient {
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
}

export interface CashuTsLifecycleWalletOptions {
  readonly mintUrl: string;
  readonly unit: string;
  readonly store: CashuTsLifecycleStore;
  readonly walletFactory?: (seed: Uint8Array) => CashuTsLifecycleClient;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
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

function quoteState(quote: unknown): string | undefined {
  if (typeof quote !== 'object' || quote === null) return undefined;
  const state = Reflect.get(quote, 'state');
  return typeof state === 'string' ? state.toUpperCase() : undefined;
}

function counterFor(operationId: string): number {
  return createHash('sha256')
    .update('cashu-fault-lab/cashu-ts-lifecycle-counter-v1\0')
    .update(operationId)
    .digest()
    .readUInt32BE(0);
}

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

export class CashuTsLifecycleWallet implements CashuTsLifecycleWalletPort {
  readonly #mintUrl: string;
  readonly #unit: string;
  readonly #store: CashuTsLifecycleStore;
  readonly #walletFactory: (seed: Uint8Array) => CashuTsLifecycleClient;
  readonly #pollAttempts: number;
  readonly #pollIntervalMs: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  #clientValue: CashuTsLifecycleClient | undefined;

  constructor(options: CashuTsLifecycleWalletOptions) {
    this.#mintUrl = options.mintUrl;
    this.#unit = options.unit;
    this.#store = options.store;
    this.#walletFactory =
      options.walletFactory ??
      ((seed) =>
        new Wallet(this.#mintUrl, {
          unit: this.#unit,
          bip39seed: seed,
        }) as unknown as CashuTsLifecycleClient);
    this.#pollAttempts = positiveInteger(options.pollAttempts ?? 60, 'pollAttempts');
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 100, 'pollIntervalMs');
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async reset(seed: string): Promise<void> {
    const client = this.#walletFactory(seedBytes(seed));
    await client.loadMint();
    this.#clientValue = client;
  }

  async prepare(input: LifecycleOperationInput): Promise<CashuTsLifecyclePreparedRequest> {
    if (input.mint !== this.#mintUrl || input.unit !== this.#unit) {
      throw new Error('Cashu lifecycle wallet mint or unit is unsupported');
    }
    if (input.kind !== 'mint')
      throw new Error('Cashu lifecycle wallet operation is not implemented');
    const client = await this.#client();
    let quote = await client.createMintQuoteBolt11(input.amount, 'cashu-fault-lab lifecycle mint');
    for (
      let attempt = 0;
      quoteState(quote) !== 'PAID' && attempt < this.#pollAttempts;
      attempt += 1
    ) {
      quote = await client.checkMintQuoteBolt11(quote);
      if (quoteState(quote) !== 'PAID') await this.#sleep(this.#pollIntervalMs);
    }
    if (quoteState(quote) !== 'PAID')
      throw new Error('Cashu lifecycle mint quote did not become paid');
    const counter = counterFor(input.operationId);
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
    return {
      requestMaterial: material,
      requestHash: digest('cashu-ts-lifecycle-request', material),
      quoteHash: digest('cashu-ts-lifecycle-quote', quoteId(quote)),
      outputPlanHash: digest('cashu-ts-lifecycle-output-plan', [counter, material.preview]),
      amount: input.amount,
    };
  }

  async submit(prepared: CashuTsLifecyclePreparedRequest): Promise<CashuTsLifecycleResult> {
    const material = parseMintMaterial(prepared.requestMaterial);
    const client = await this.#client();
    const proofs = await client.completeMint(portableDecode(material.preview));
    const records = proofs.map((proof) => proofRecord(proof, this.#mintUrl, this.#unit));
    await this.#store.applyProofChanges({
      operationId: material.operationId,
      add: records,
      update: [],
    });
    const proofSetHash = digest(
      'cashu-ts-lifecycle-proof-set',
      records.map((proof) => proof.proofId).sort(),
    );
    await this.#store.appendEvidence({
      effectId: `mint-${proofSetHash.slice(0, 32)}`,
      operationId: material.operationId,
      source: 'durable_state',
      event: 'proofs_persisted',
      dataHash: proofSetHash,
    });
    return {
      status: 'succeeded',
      amount: records.reduce((total, proof) => total + proof.amount, 0),
      ...(prepared.quoteHash === undefined ? {} : { quoteHash: prepared.quoteHash }),
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
    if (input.kind !== 'mint') {
      return { status: 'recovery_blocked', evidenceCode: 'operation_not_supported' };
    }
    try {
      return await this.submit(prepared);
    } catch {
      return { status: 'recovery_blocked', evidenceCode: 'mint_recovery_failed' };
    }
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
}
