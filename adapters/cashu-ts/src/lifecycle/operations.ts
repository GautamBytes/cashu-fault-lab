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
  CashuTsLifecycleQuoteObservation,
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
  readonly sendHandoffDurability = 'process-local' as const;
  readonly #records = new Map<string, CashuTsStoredLifecycleOperation>();
  readonly #proofs = new Map<string, CashuTsLifecycleStoredProof>();
  readonly #evidenceByEffect = new Map<string, CashuTsLifecycleEvidenceInput>();
  readonly #evidenceLog: LifecycleEvidenceView[] = [];
  readonly #claims = new Map<string, Promise<void>>();
  readonly #counterNext = new Map<string, number>();
  readonly #counterKeysets = new Map<string, Set<string>>();
  readonly #counterReservations = new Map<
    string,
    { readonly start: number; readonly count: number }
  >();
  readonly #sendHandoffs = new Map<
    string,
    {
      readonly recipient: string;
      readonly token: string;
      readonly tokenHash: string;
      claimedBy?: string;
      acknowledged?: boolean;
    }
  >();
  readonly #onWrite: ((phase: LifecyclePhase) => void) | undefined;
  #seed: string | undefined;
  #counterEpoch = 0;

  constructor(options: MemoryCashuTsLifecycleStoreOptions = {}) {
    this.#onWrite = options.onWrite;
  }

  async reset(seed: string): Promise<void> {
    this.#counterEpoch += 1;
    this.#seed = seed;
    this.#records.clear();
    this.#proofs.clear();
    this.#evidenceByEffect.clear();
    this.#evidenceLog.length = 0;
    this.#claims.clear();
    this.#sendHandoffs.clear();
  }

  async loadSeed(): Promise<string | undefined> {
    return this.#seed;
  }

  async reserveCounterRange(
    keysetId: string,
    reservationId: string,
    count: number,
  ): Promise<{ readonly start: number; readonly count: number }> {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('Lifecycle counter reservation count is invalid');
    }
    if (this.#seed === undefined) throw new Error('Lifecycle seed is unavailable');
    const counterIdentity = JSON.stringify([this.#seed, keysetId]);
    const identity = JSON.stringify([this.#seed, this.#counterEpoch, keysetId, reservationId]);
    const previous = this.#counterReservations.get(identity);
    if (previous !== undefined) return clone(previous);
    const start = this.#counterNext.get(counterIdentity) ?? 0;
    if (!Number.isSafeInteger(start + count)) {
      throw new Error('Lifecycle counter range is exhausted');
    }
    const range = { start, count } as const;
    this.#counterNext.set(counterIdentity, start + count);
    const keysets = this.#counterKeysets.get(this.#seed) ?? new Set<string>();
    keysets.add(keysetId);
    this.#counterKeysets.set(this.#seed, keysets);
    this.#counterReservations.set(identity, range);
    return clone(range);
  }

  async counterHighWatermark(keysetId: string): Promise<number> {
    if (this.#seed === undefined) throw new Error('Lifecycle seed is unavailable');
    return this.#counterNext.get(JSON.stringify([this.#seed, keysetId])) ?? 0;
  }

  async counterHighWatermarks(): Promise<
    readonly { readonly keysetId: string; readonly nextCounter: number }[]
  > {
    if (this.#seed === undefined) throw new Error('Lifecycle seed is unavailable');
    return [...(this.#counterKeysets.get(this.#seed) ?? [])]
      .map((keysetId) => ({
        keysetId,
        nextCounter: this.#counterNext.get(JSON.stringify([this.#seed, keysetId])) ?? 0,
      }))
      .sort((left, right) => left.keysetId.localeCompare(right.keysetId));
  }

  async putSendHandoff(operationId: string, recipient: string, token: string): Promise<string> {
    const tokenHash = createHash('sha256')
      .update('cashu-fault-lab/cashu-ts-lifecycle-send-token/v1\0')
      .update(token)
      .digest('hex');
    const previous = this.#sendHandoffs.get(operationId);
    if (
      previous !== undefined &&
      (previous.recipient !== recipient || previous.tokenHash !== tokenHash)
    ) {
      throw new Error('Lifecycle send handoff identity conflicts');
    }
    this.#sendHandoffs.set(operationId, previous ?? { recipient, token, tokenHash });
    return tokenHash;
  }

  async loadSendHandoff(
    operationId: string,
  ): Promise<
    { readonly recipient: string; readonly token: string; readonly tokenHash: string } | undefined
  > {
    const handoff = this.#sendHandoffs.get(operationId);
    return handoff === undefined ? undefined : clone(handoff);
  }

  async claimSendHandoff(consumerId: string): Promise<
    | {
        readonly operationId: string;
        readonly recipient: string;
        readonly token: string;
        readonly tokenHash: string;
      }
    | undefined
  > {
    if (consumerId.length === 0) throw new Error('Lifecycle send handoff consumer is invalid');
    for (const [operationId, handoff] of this.#sendHandoffs) {
      if (handoff.acknowledged === true) continue;
      if (handoff.claimedBy !== undefined && handoff.claimedBy !== consumerId) continue;
      handoff.claimedBy = consumerId;
      return {
        operationId,
        recipient: handoff.recipient,
        token: handoff.token,
        tokenHash: handoff.tokenHash,
      };
    }
    return undefined;
  }

  async ackSendHandoff(operationId: string, tokenHash: string, consumerId: string): Promise<void> {
    const handoff = this.#sendHandoffs.get(operationId);
    if (
      handoff === undefined ||
      handoff.tokenHash !== tokenHash ||
      handoff.claimedBy !== consumerId
    ) {
      throw new Error('Lifecycle send handoff claim conflicts');
    }
    handoff.acknowledged = true;
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

  async commit(
    operation: CashuTsStoredLifecycleOperation,
    proofChanges?: Omit<CashuTsLifecycleProofChanges, 'operationId'>,
    evidence: readonly CashuTsLifecycleEvidenceInput[] = [],
  ): Promise<void> {
    const previous = this.#records.get(operation.view.operationId);
    if (previous === undefined) throw new Error('Lifecycle operation is not journaled');
    if (!sameIdentity(previous, operation)) {
      throw new Error('Lifecycle operation identity conflicts');
    }
    const nextProofs = new Map(this.#proofs);
    if (proofChanges !== undefined) {
      applyMemoryProofChanges(nextProofs, {
        operationId: operation.view.operationId,
        ...proofChanges,
      });
    }
    const nextEvidenceByEffect = new Map(this.#evidenceByEffect);
    const nextEvidenceLog = this.#evidenceLog.map(clone);
    for (const item of evidence) {
      appendMemoryEvidence(nextEvidenceByEffect, nextEvidenceLog, item);
    }
    this.#records.set(operation.view.operationId, clone(operation));
    this.#proofs.clear();
    for (const [proofId, proof] of nextProofs) this.#proofs.set(proofId, proof);
    this.#evidenceByEffect.clear();
    for (const [effectId, item] of nextEvidenceByEffect) {
      this.#evidenceByEffect.set(effectId, item);
    }
    this.#evidenceLog.length = 0;
    this.#evidenceLog.push(...nextEvidenceLog);
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
    applyMemoryProofChanges(next, changes);
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
    appendMemoryEvidence(this.#evidenceByEffect, this.#evidenceLog, evidence);
  }

  async evidence(): Promise<readonly LifecycleEvidenceView[]> {
    return this.#evidenceLog.map(clone);
  }
}

function appendMemoryEvidence(
  evidenceByEffect: Map<string, CashuTsLifecycleEvidenceInput>,
  evidenceLog: LifecycleEvidenceView[],
  evidence: CashuTsLifecycleEvidenceInput,
): void {
  assertEvidence(evidence);
  const previous = evidenceByEffect.get(evidence.effectId);
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(evidence)) {
      throw new Error('Lifecycle evidence effect identity conflicts');
    }
    return;
  }
  evidenceByEffect.set(evidence.effectId, clone(evidence));
  const { effectId: _effectId, ...view } = evidence;
  evidenceLog.push({ sequence: evidenceLog.length + 1, ...clone(view) });
}

function applyMemoryProofChanges(
  proofs: Map<string, CashuTsLifecycleStoredProof>,
  changes: CashuTsLifecycleProofChanges,
): void {
  for (const proof of changes.add) {
    assertStoredProof(proof);
    const previous = proofs.get(proof.proofId);
    if (
      previous !== undefined &&
      JSON.stringify(canonical(previous)) !== JSON.stringify(canonical(proof))
    ) {
      throw new Error('Lifecycle proof identity conflicts');
    }
    proofs.set(proof.proofId, clone(previous ?? proof));
  }
  for (const update of changes.update) {
    assertProofId(update.proofId);
    const previous = proofs.get(update.proofId);
    if (previous === undefined) throw new Error('Lifecycle proof was not found');
    if (!validProofTransition(previous.state, update.state)) {
      throw new Error('Lifecycle proof state transition is invalid');
    }
    const reservationOperationId = update.reservationOperationId ?? changes.operationId;
    if (previous.state === 'PENDING' && previous.reservedByOperationId !== reservationOperationId) {
      throw new Error('Lifecycle proof is reserved by another operation');
    }
    const reservedByOperationId = update.state === 'PENDING' ? reservationOperationId : undefined;
    const { reservedByOperationId: _previousReservation, ...unreservedProof } = previous;
    proofs.set(update.proofId, {
      ...unreservedProof,
      state: update.state,
      bucket: update.bucket,
      ...(reservedByOperationId === undefined ? {} : { reservedByOperationId }),
    });
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
  const reconciled =
    (phase === 'failed_definitive' || phase === 'recovery_blocked') && view.phase === 'submitted'
      ? withPhase(withPhase(view, 'ambiguous'), 'reconciling')
      : view;
  const transitioned =
    phase === 'ambiguous' && reconciled.phase === 'reconciling'
      ? reconciled
      : phase === 'ambiguous'
        ? withPhase(reconciled, phase)
        : withPhase(reconciled, phase, phase === 'succeeded' ? undefined : result.evidenceCode);
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

function appendQuoteObservations(
  previous: readonly CashuTsLifecycleQuoteObservation[] = [],
  next: readonly CashuTsLifecycleQuoteObservation[] = [],
): readonly CashuTsLifecycleQuoteObservation[] {
  const observations = [...previous];
  const order = {
    mint: { UNPAID: 0, PAID: 1, ISSUED: 2 },
    melt: { UNPAID: 0, PENDING: 1, PAID: 2 },
  } as const;
  for (const observation of next) {
    if (
      !HASH_PATTERN.test(observation.dataHash) ||
      !(observation.state in order[observation.kind])
    ) {
      throw new Error('Lifecycle quote observation is invalid');
    }
    const last = observations.findLast((item) => item.kind === observation.kind);
    if (
      last !== undefined &&
      order[observation.kind][observation.state as keyof (typeof order)[typeof observation.kind]] <
        order[last.kind][last.state as keyof (typeof order)[typeof last.kind]]
    ) {
      throw new Error('Lifecycle quote state regressed');
    }
    observations.push(clone(observation));
  }
  return observations;
}

function operationEvidence(
  stage: 'submission' | 'recovery',
  operation: CashuTsStoredLifecycleOperation,
  result: CashuTsLifecycleResult,
): CashuTsLifecycleEvidenceInput {
  const publicResult = {
    status: result.status,
    ...('evidenceCode' in result ? { evidenceCode: result.evidenceCode } : {}),
    ...(result.recoveryMechanism === undefined
      ? {}
      : { recoveryMechanism: result.recoveryMechanism }),
    ...('amount' in result
      ? {
          amount: result.amount,
          inputFee: result.inputFee,
          feeReserve: result.feeReserve,
          actualFee: result.actualFee,
          change: result.change,
          quoteHash: result.quoteHash,
        }
      : {}),
    proofChanges:
      result.proofChanges === undefined
        ? undefined
        : {
            add: result.proofChanges.add.map(({ proofId, state, bucket }) => ({
              proofId,
              state,
              bucket,
            })),
            update: result.proofChanges.update.map(({ proofId, state, bucket }) => ({
              proofId,
              state,
              bucket,
            })),
          },
  };
  return {
    effectId: `${stage}-${operation.view.intentHash.slice(0, 16)}-${result.status}`,
    operationId: operation.view.operationId,
    source: 'adapter',
    event: `${stage}_${result.status}`,
    dataHash: createHash('sha256')
      .update('cashu-fault-lab/cashu-ts-lifecycle-evidence-v1\0')
      .update(operation.view.intentHash)
      .update('\0')
      .update(JSON.stringify(canonical(publicResult)))
      .digest('hex'),
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
    const discovered =
      this.#wallet.discoverSupportedNuts === undefined
        ? undefined
        : new Set(await this.#wallet.discoverSupportedNuts());
    if (discovered === undefined) return structuredClone(this.#capabilities);
    const nuts = this.#capabilities.nuts.filter((nut) =>
      nut === 13 ? discovered.has(9) : discovered.has(nut),
    );
    if (discovered.has(9) && this.#capabilities.nuts.includes(13) && !nuts.includes(13)) {
      nuts.push(13);
    }
    const operations = this.#capabilities.operations.filter((operation) => {
      if (operation === 'mint') return discovered.has(4);
      if (operation === 'swap' || operation === 'receive') return discovered.has(3);
      if (operation === 'send') {
        return discovered.has(3) && this.#wallet.supportsSendHandoff === true;
      }
      if (operation === 'melt') return discovered.has(5);
      if (operation === 'restore') return discovered.has(9);
      if (operation === 'reconcile') return discovered.has(7);
      return false;
    });
    const recovery = this.#capabilities.recovery.filter((mechanism) => {
      if (mechanism === 'quote_state') return discovered.has(4) || discovered.has(5);
      if (mechanism === 'proof_state') return discovered.has(7);
      if (mechanism === 'nut09_restore') return discovered.has(9);
      if (mechanism === 'nut13_seed') return discovered.has(9);
      if (mechanism === 'nut19_replay') return discovered.has(19);
      return false;
    });
    return structuredClone({ ...this.#capabilities, nuts, operations, recovery });
  }

  async reset(seed: string): Promise<void> {
    await this.#store.reset(seed);
    await this.#wallet.reset(seed);
  }

  async start(input: LifecycleOperationInput): Promise<LifecycleOperationView> {
    if (this.#capabilities !== undefined) {
      const capabilities = await this.capabilities();
      if (!capabilities.operations.includes(input.kind)) {
        throw new Error('Lifecycle operation is not advertised');
      }
    }
    const initial: CashuTsStoredLifecycleOperation = {
      input: clone(input),
      view: operationView(input),
      attemptCount: 0,
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
      }
      if (stored.view.phase !== 'reconciling') {
        throw new Error('Lifecycle operation cannot be resumed');
      }
      stored = { ...stored, attemptCount: (stored.attemptCount ?? 0) + 1 };
      await this.#store.put(stored);
      let result = await this.#wallet.recover(stored.input, stored.view, stored.prepared);
      let quoteObservations: readonly CashuTsLifecycleQuoteObservation[];
      try {
        quoteObservations = appendQuoteObservations(
          stored.quoteObservations,
          result.quoteObservations,
        );
      } catch (error) {
        result = {
          status: 'recovery_blocked',
          evidenceCode:
            error instanceof Error && error.message === 'Lifecycle quote state regressed'
              ? 'quote_state_regressed'
              : 'quote_observation_invalid',
          recoveryMechanism: 'quote_state',
        };
        quoteObservations = stored.quoteObservations ?? [];
      }
      const recovered = {
        ...stored,
        ...(result.recoveryMechanism === undefined
          ? {}
          : { recoveryMechanism: result.recoveryMechanism }),
        ...(quoteObservations.length === 0 ? {} : { quoteObservations }),
        ...(result.resultMaterial === undefined ? {} : { resultMaterial: result.resultMaterial }),
        view: withResult(stored.view, result),
      };
      await this.#store.commit(recovered, result.proofChanges, [
        ...(result.evidence ?? []),
        operationEvidence('recovery', stored, result),
      ]);
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
    const quoteObservations = appendQuoteObservations(undefined, prepared.quoteObservations);
    const next = {
      ...stored,
      prepared: clone(prepared),
      ...(quoteObservations.length === 0 ? {} : { quoteObservations }),
      view: withPrepared(stored.view, prepared),
    };
    await this.#store.commit(next, prepared.proofChanges);
    return this.#submit(next);
  }

  async #submit(stored: CashuTsStoredLifecycleOperation): Promise<LifecycleOperationView> {
    const prepared = stored.prepared;
    if (prepared === undefined) throw new Error('Lifecycle prepared request is missing');
    const submitted = {
      ...stored,
      attemptCount: (stored.attemptCount ?? 0) + 1,
      view: withPhase(stored.view, 'submitted'),
    };
    await this.#store.put(submitted);
    let result = await this.#wallet.submit(prepared);
    let quoteObservations: readonly CashuTsLifecycleQuoteObservation[];
    try {
      quoteObservations = appendQuoteObservations(
        submitted.quoteObservations,
        result.quoteObservations,
      );
    } catch (error) {
      result = {
        status: 'recovery_blocked',
        evidenceCode:
          error instanceof Error && error.message === 'Lifecycle quote state regressed'
            ? 'quote_state_regressed'
            : 'quote_observation_invalid',
        recoveryMechanism: 'quote_state',
      };
      quoteObservations = submitted.quoteObservations ?? [];
    }
    const completed = {
      ...submitted,
      ...(result.recoveryMechanism === undefined
        ? {}
        : { recoveryMechanism: result.recoveryMechanism }),
      ...(quoteObservations.length === 0 ? {} : { quoteObservations }),
      ...(result.resultMaterial === undefined ? {} : { resultMaterial: result.resultMaterial }),
      view: withResult(submitted.view, result),
    };
    await this.#store.commit(completed, result.proofChanges, [
      ...(result.evidence ?? []),
      operationEvidence('submission', submitted, result),
    ]);
    return completed.view;
  }

  async #required(operationId: string): Promise<CashuTsStoredLifecycleOperation> {
    const stored = await this.#store.get(operationId);
    if (stored === undefined) throw new Error('Lifecycle operation was not found');
    return stored;
  }
}
