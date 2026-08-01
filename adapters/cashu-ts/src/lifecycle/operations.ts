import type {
  LifecycleCapabilities,
  LifecycleEvidenceView,
  LifecycleOperationInput,
  LifecycleOperationView,
  LifecycleWalletView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import {
  createOperation,
  transitionOperation,
  type LifecyclePhase,
} from '@cashu-fault-lab/wallet-lifecycle-core';
import { createHash } from 'node:crypto';
import type {
  CashuTsLifecycleCreateResult,
  CashuTsLifecycleEvidenceInput,
  CashuTsLifecyclePreparedRequest,
  CashuTsLifecycleProofChanges,
  CashuTsLifecycleResult,
  CashuTsLifecycleStore,
  CashuTsLifecycleStoredProof,
  CashuTsLifecycleWalletPort,
  CashuTsStoredLifecycleOperation,
} from './types.js';

export type {
  CashuTsLifecyclePreparedRequest,
  CashuTsLifecycleResult,
  CashuTsLifecycleStore,
  CashuTsLifecycleWalletPort,
  CashuTsStoredLifecycleOperation,
} from './types.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function cashuTsLifecycleIntentHash(input: LifecycleOperationInput): string {
  return createHash('sha256')
    .update('cashu-fault-lab/cashu-ts-lifecycle-intent-v1\0')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameIdentity(
  left: CashuTsStoredLifecycleOperation,
  right: CashuTsStoredLifecycleOperation,
): boolean {
  return (
    left.view.operationId === right.view.operationId &&
    left.view.intentHash === right.view.intentHash &&
    left.view.kind === right.view.kind &&
    left.view.mint === right.view.mint &&
    left.view.unit === right.view.unit
  );
}

export interface MemoryCashuTsLifecycleStoreOptions {
  readonly onWrite?: (phase: LifecyclePhase) => void;
}

export class MemoryCashuTsLifecycleStore implements CashuTsLifecycleStore {
  readonly #records = new Map<string, CashuTsStoredLifecycleOperation>();
  readonly #proofs = new Map<string, CashuTsLifecycleStoredProof>();
  readonly #evidenceByEffect = new Map<string, CashuTsLifecycleEvidenceInput>();
  readonly #evidenceLog: LifecycleEvidenceView[] = [];
  readonly #claims = new Map<string, Promise<void>>();
  readonly #onWrite: ((phase: LifecyclePhase) => void) | undefined;
  #seed: string | undefined;

  constructor(options: MemoryCashuTsLifecycleStoreOptions = {}) {
    this.#onWrite = options.onWrite;
  }

  async reset(seed: string): Promise<void> {
    this.#seed = seed;
    this.#records.clear();
    this.#proofs.clear();
    this.#evidenceByEffect.clear();
    this.#evidenceLog.length = 0;
    this.#claims.clear();
  }

  async loadSeed(): Promise<string | undefined> {
    return this.#seed;
  }

  async create(operation: CashuTsStoredLifecycleOperation): Promise<CashuTsLifecycleCreateResult> {
    const previous = this.#records.get(operation.view.operationId);
    if (previous !== undefined) {
      if (!sameIdentity(previous, operation)) {
        throw new Error('Lifecycle operation identity conflicts');
      }
      return { created: false, operation: clone(previous) };
    }
    const stored = clone(operation);
    this.#records.set(operation.view.operationId, stored);
    this.#onWrite?.(stored.view.phase);
    return { created: true, operation: clone(stored) };
  }

  async get(operationId: string): Promise<CashuTsStoredLifecycleOperation | undefined> {
    const operation = this.#records.get(operationId);
    return operation === undefined ? undefined : clone(operation);
  }

  async put(operation: CashuTsStoredLifecycleOperation): Promise<void> {
    const previous = this.#records.get(operation.view.operationId);
    if (previous === undefined) throw new Error('Lifecycle operation is not journaled');
    if (!sameIdentity(previous, operation)) {
      throw new Error('Lifecycle operation identity conflicts');
    }
    this.#records.set(operation.view.operationId, clone(operation));
    this.#onWrite?.(operation.view.phase);
  }

  async claim<T>(operationId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#claims.get(operationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#claims.set(operationId, queued);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.#claims.get(operationId) === queued) this.#claims.delete(operationId);
    }
  }

  async listProofs(mint: string, unit: string): Promise<readonly CashuTsLifecycleStoredProof[]> {
    return [...this.#proofs.values()]
      .filter((proof) => proof.mint === mint && proof.unit === unit)
      .sort((left, right) => left.proofId.localeCompare(right.proofId))
      .map(clone);
  }

  async applyProofChanges(changes: CashuTsLifecycleProofChanges): Promise<void> {
    if (!this.#records.has(changes.operationId)) {
      throw new Error('Lifecycle proof operation was not found');
    }
    const next = new Map(this.#proofs);
    for (const proof of changes.add) {
      assertStoredProof(proof);
      const previous = next.get(proof.proofId);
      if (
        previous !== undefined &&
        JSON.stringify(canonical(previous)) !== JSON.stringify(canonical(proof))
      ) {
        throw new Error('Lifecycle proof identity conflicts');
      }
      next.set(proof.proofId, clone(previous ?? proof));
    }
    for (const update of changes.update) {
      assertProofId(update.proofId);
      const previous = next.get(update.proofId);
      if (previous === undefined) throw new Error('Lifecycle proof was not found');
      if (!validProofTransition(previous.state, update.state)) {
        throw new Error('Lifecycle proof state transition is invalid');
      }
      next.set(update.proofId, { ...previous, state: update.state, bucket: update.bucket });
    }
    this.#proofs.clear();
    for (const [proofId, proof] of next) this.#proofs.set(proofId, proof);
  }

  async walletView(walletId: string, mint: string, unit: string): Promise<LifecycleWalletView> {
    const proofs = await this.listProofs(mint, unit);
    const balance = (bucket: CashuTsLifecycleStoredProof['bucket']): number =>
      proofs
        .filter((proof) => proof.bucket === bucket && proof.state !== 'SPENT')
        .reduce((total, proof) => total + proof.amount, 0);
    return {
      walletId,
      mint,
      unit,
      balances: {
        available: balance('available'),
        reserved: balance('reserved'),
        recoverable: balance('recoverable'),
      },
      proofs: proofs.map(({ proofId, state }) => ({ proofId, state })),
    };
  }

  async appendEvidence(evidence: CashuTsLifecycleEvidenceInput): Promise<void> {
    assertEvidence(evidence);
    const previous = this.#evidenceByEffect.get(evidence.effectId);
    if (previous !== undefined) {
      if (JSON.stringify(previous) !== JSON.stringify(evidence)) {
        throw new Error('Lifecycle evidence effect identity conflicts');
      }
      return;
    }
    this.#evidenceByEffect.set(evidence.effectId, clone(evidence));
    const { effectId: _effectId, ...view } = evidence;
    this.#evidenceLog.push({ sequence: this.#evidenceLog.length + 1, ...clone(view) });
  }

  async evidence(): Promise<readonly LifecycleEvidenceView[]> {
    return this.#evidenceLog.map(clone);
  }
}

export interface CashuTsLifecycleOperationsOptions {
  readonly store: CashuTsLifecycleStore;
  readonly wallet: CashuTsLifecycleWalletPort;
  readonly walletId?: string;
  readonly mint?: string;
  readonly unit?: string;
  readonly capabilities?: LifecycleCapabilities;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const EVENT_PATTERN = /^[a-z0-9_]{1,64}$/u;
const EFFECT_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;

function assertProofId(value: string): void {
  if (!HASH_PATTERN.test(value)) throw new Error('Lifecycle proof identity is invalid');
}

function assertStoredProof(proof: CashuTsLifecycleStoredProof): void {
  assertProofId(proof.proofId);
  if (!Number.isSafeInteger(proof.amount) || proof.amount < 1) {
    throw new Error('Lifecycle proof amount is invalid');
  }
  createOperation({
    operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
    kind: 'receive',
    mint: proof.mint,
    unit: proof.unit,
    intentHash: 'a'.repeat(64),
  });
}

function validProofTransition(
  from: CashuTsLifecycleStoredProof['state'],
  to: CashuTsLifecycleStoredProof['state'],
): boolean {
  return (
    from === to ||
    (from === 'UNSPENT' && (to === 'PENDING' || to === 'SPENT')) ||
    (from === 'PENDING' && (to === 'UNSPENT' || to === 'SPENT'))
  );
}

function assertEvidence(evidence: CashuTsLifecycleEvidenceInput): void {
  if (!EFFECT_PATTERN.test(evidence.effectId) || !EVENT_PATTERN.test(evidence.event)) {
    throw new Error('Lifecycle evidence identity is invalid');
  }
  if (!HASH_PATTERN.test(evidence.dataHash)) throw new Error('Lifecycle evidence hash is invalid');
  createOperation({
    operationId: evidence.operationId,
    kind: 'reconcile',
    mint: 'http://127.0.0.1',
    unit: 'sat',
    intentHash: 'a'.repeat(64),
  });
}

function operationView(input: LifecycleOperationInput): LifecycleOperationView {
  const record = createOperation({
    operationId: input.operationId,
    kind: input.kind,
    mint: input.mint,
    unit: input.unit,
    intentHash: cashuTsLifecycleIntentHash(input),
  });
  return {
    ...record,
    ...('amount' in input ? { amount: input.amount } : {}),
  };
}

function withPhase(
  view: LifecycleOperationView,
  phase: LifecyclePhase,
  evidenceCode?: string,
): LifecycleOperationView {
  return {
    ...view,
    ...transitionOperation(view, phase, evidenceCode),
  };
}

function withPrepared(
  view: LifecycleOperationView,
  prepared: CashuTsLifecyclePreparedRequest,
): LifecycleOperationView {
  return {
    ...withPhase(view, 'prepared'),
    ...(prepared.amount === undefined ? {} : { amount: prepared.amount }),
    ...(prepared.inputFee === undefined ? {} : { inputFee: prepared.inputFee }),
    ...(prepared.feeReserve === undefined ? {} : { feeReserve: prepared.feeReserve }),
    ...(prepared.requestHash === undefined ? {} : { requestHash: prepared.requestHash }),
    ...(prepared.quoteHash === undefined ? {} : { quoteHash: prepared.quoteHash }),
    ...(prepared.outputPlanHash === undefined ? {} : { outputPlanHash: prepared.outputPlanHash }),
  };
}

function withResult(
  view: LifecycleOperationView,
  result: CashuTsLifecycleResult,
): LifecycleOperationView {
  const phase = result.status;
  const transitioned =
    phase === 'ambiguous'
      ? withPhase(view, phase)
      : withPhase(view, phase, phase === 'succeeded' ? undefined : result.evidenceCode);
  if (result.status === 'ambiguous') return transitioned;
  return {
    ...transitioned,
    ...(result.amount === undefined ? {} : { amount: result.amount }),
    ...(result.inputFee === undefined ? {} : { inputFee: result.inputFee }),
    ...(result.feeReserve === undefined ? {} : { feeReserve: result.feeReserve }),
    ...(result.actualFee === undefined ? {} : { actualFee: result.actualFee }),
    ...(result.change === undefined ? {} : { change: result.change }),
    ...(result.quoteHash === undefined ? {} : { quoteHash: result.quoteHash }),
  };
}

export class CashuTsLifecycleOperations {
  readonly #store: CashuTsLifecycleStore;
  readonly #wallet: CashuTsLifecycleWalletPort;
  readonly #walletId: string;
  readonly #mint: string | undefined;
  readonly #unit: string | undefined;
  readonly #capabilities: LifecycleCapabilities | undefined;

  constructor(options: CashuTsLifecycleOperationsOptions) {
    this.#store = options.store;
    this.#wallet = options.wallet;
    this.#walletId = options.walletId ?? 'cashu-ts';
    this.#mint = options.mint;
    this.#unit = options.unit;
    this.#capabilities = options.capabilities;
  }

  async capabilities(): Promise<LifecycleCapabilities> {
    if (this.#capabilities === undefined) {
      throw new Error('Lifecycle capabilities are not configured');
    }
    return structuredClone(this.#capabilities);
  }

  async reset(seed: string): Promise<void> {
    await this.#store.reset(seed);
    await this.#wallet.reset(seed);
  }

  async start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    const initial: CashuTsStoredLifecycleOperation = {
      input: clone(input),
      view: operationView(input),
    };
    await this.#store.create(initial);
    return this.#store.claim(input.operationId, async () => {
      const stored = await this.#required(input.operationId);
      if (stored.view.intentHash !== initial.view.intentHash) {
        throw new Error('Lifecycle operation identity conflicts');
      }
      if (stored.view.phase !== 'created') return stored.view;
      return this.#prepareAndSubmit(stored);
    });
  }

  async resume(operationId: string): Promise<LifecycleOperationView> {
    return this.#store.claim(operationId, async () => {
      let stored = await this.#required(operationId);
      if (
        stored.view.phase === 'succeeded' ||
        stored.view.phase === 'failed_definitive' ||
        stored.view.phase === 'recovery_blocked'
      ) {
        return stored.view;
      }
      if (stored.view.phase === 'created') return this.#prepareAndSubmit(stored);
      if (stored.view.phase === 'prepared') return this.#submit(stored);
      if (stored.view.phase === 'submitted') {
        stored = { ...stored, view: withPhase(stored.view, 'ambiguous') };
        await this.#store.put(stored);
      }
      if (stored.view.phase === 'ambiguous') {
        stored = { ...stored, view: withPhase(stored.view, 'reconciling') };
        await this.#store.put(stored);
      }
      if (stored.view.phase !== 'reconciling') {
        throw new Error('Lifecycle operation cannot be resumed');
      }
      const result = await this.#wallet.recover(stored.input, stored.view, stored.prepared);
      const recovered = { ...stored, view: withResult(stored.view, result) };
      await this.#store.put(recovered);
      return recovered.view;
    });
  }

  async operation(operationId: string): Promise<LifecycleOperationView> {
    return (await this.#required(operationId)).view;
  }

  async wallet(): Promise<LifecycleWalletView> {
    if (this.#mint === undefined || this.#unit === undefined) {
      throw new Error('Lifecycle wallet identity is not configured');
    }
    return this.#store.walletView(this.#walletId, this.#mint, this.#unit);
  }

  evidence(): Promise<readonly LifecycleEvidenceView[]> {
    return this.#store.evidence();
  }

  async #prepareAndSubmit(
    stored: CashuTsStoredLifecycleOperation,
  ): Promise<LifecycleOperationView> {
    const prepared = await this.#wallet.prepare(stored.input);
    const next = {
      ...stored,
      prepared: clone(prepared),
      view: withPrepared(stored.view, prepared),
    };
    await this.#store.put(next);
    return this.#submit(next);
  }

  async #submit(stored: CashuTsStoredLifecycleOperation): Promise<LifecycleOperationView> {
    const prepared = stored.prepared;
    if (prepared === undefined) throw new Error('Lifecycle prepared request is missing');
    const submitted = { ...stored, view: withPhase(stored.view, 'submitted') };
    await this.#store.put(submitted);
    const result = await this.#wallet.submit(prepared);
    const completed = { ...submitted, view: withResult(submitted.view, result) };
    await this.#store.put(completed);
    return completed.view;
  }

  async #required(operationId: string): Promise<CashuTsStoredLifecycleOperation> {
    const stored = await this.#store.get(operationId);
    if (stored === undefined) throw new Error('Lifecycle operation was not found');
    return stored;
  }
}
