import type {
  LifecycleOperationInput,
  LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import {
  createOperation,
  transitionOperation,
  type LifecyclePhase,
} from '@cashu-fault-lab/wallet-lifecycle-core';
import { createHash } from 'node:crypto';
import type {
  CashuTsLifecycleCreateResult,
  CashuTsLifecyclePreparedRequest,
  CashuTsLifecycleResult,
  CashuTsLifecycleStore,
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
  readonly #claims = new Map<string, Promise<void>>();
  readonly #onWrite: ((phase: LifecyclePhase) => void) | undefined;

  constructor(options: MemoryCashuTsLifecycleStoreOptions = {}) {
    this.#onWrite = options.onWrite;
  }

  async reset(_seed: string): Promise<void> {
    this.#records.clear();
    this.#claims.clear();
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
}

export interface CashuTsLifecycleOperationsOptions {
  readonly store: CashuTsLifecycleStore;
  readonly wallet: CashuTsLifecycleWalletPort;
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

  constructor(options: CashuTsLifecycleOperationsOptions) {
    this.#store = options.store;
    this.#wallet = options.wallet;
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
