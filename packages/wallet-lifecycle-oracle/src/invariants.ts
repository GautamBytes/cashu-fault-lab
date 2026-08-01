import {
  createOperation,
  transitionOperation,
  type LifecycleOperationRecord,
} from '@cashu-fault-lab/wallet-lifecycle-core';
import type {
  LifecycleEvaluation,
  LifecycleModel,
  LifecycleObservation,
  LifecycleProofState,
} from './model.js';

type ValueMovement = Extract<LifecycleObservation, { readonly type: 'value_moved' }>;
type RequestDispatch = Extract<LifecycleObservation, { readonly type: 'request_dispatched' }>;
type QuoteObservation = Extract<LifecycleObservation, { readonly type: 'mint_quote_observed' }>;
type ProofObservation = Extract<LifecycleObservation, { readonly type: 'proof_state_observed' }>;
type SettlementObservation = Extract<
  LifecycleObservation,
  { readonly type: 'lightning_settlement_observed' }
>;
type OutputsObservation = Extract<LifecycleObservation, { readonly type: 'outputs_persisted' }>;

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const EFFECT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UNIT_PATTERN = /^[a-z0-9_-]{1,16}$/u;
const PATH_PATTERN = /^\/v1\/[a-z0-9/_-]{1,128}$/u;

function fail(message: string): never {
  throw new Error(`Lifecycle oracle safety violation: ${message}`);
}

function sameOperation(left: LifecycleOperationRecord, right: LifecycleOperationRecord): boolean {
  return (
    left.operationId === right.operationId &&
    left.kind === right.kind &&
    left.mint === right.mint &&
    left.unit === right.unit &&
    left.intentHash === right.intentHash
  );
}

function sameMovement(left: ValueMovement, right: ValueMovement): boolean {
  return (
    left.operationId === right.operationId &&
    left.effectId === right.effectId &&
    left.unit === right.unit &&
    left.amount === right.amount &&
    left.from === right.from &&
    left.to === right.to
  );
}

function sameRequest(left: RequestDispatch, right: RequestDispatch): boolean {
  return (
    left.operationId === right.operationId &&
    left.requestKind === right.requestKind &&
    left.method === right.method &&
    left.path === right.path &&
    left.bodyHash === right.bodyHash
  );
}

function sameSettlement(left: SettlementObservation, right: SettlementObservation): boolean {
  return (
    left.operationId === right.operationId &&
    left.invoiceHash === right.invoiceHash &&
    left.paymentHash === right.paymentHash &&
    left.amount === right.amount &&
    left.unit === right.unit
  );
}

function sameOutputs(left: OutputsObservation, right: OutputsObservation): boolean {
  return (
    left.operationId === right.operationId &&
    left.outputPlanHash === right.outputPlanHash &&
    left.amount === right.amount &&
    left.unit === right.unit
  );
}

function operationFor(
  operations: ReadonlyMap<string, LifecycleOperationRecord>,
  operationId: string,
): LifecycleOperationRecord {
  const operation = operations.get(operationId);
  if (operation === undefined) fail(`operation ${operationId} was not observed`);
  return operation;
}

function safeNonNegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function safePositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validAccount(value: string): boolean {
  const parts = value.split(':');
  if (parts[0] === 'external' || parts[0] === 'transfer' || parts[0] === 'lightning') {
    return parts.length === 2 && IDENTIFIER_PATTERN.test(parts[1] ?? '');
  }
  if (parts[0] === 'wallet') {
    return (
      parts.length === 3 &&
      IDENTIFIER_PATTERN.test(parts[1] ?? '') &&
      ['available', 'reserved', 'recoverable'].includes(parts[2] ?? '')
    );
  }
  if (parts[0] === 'fee') {
    return (
      parts.length === 3 &&
      ['mint', 'lightning'].includes(parts[1] ?? '') &&
      IDENTIFIER_PATTERN.test(parts[2] ?? '')
    );
  }
  return false;
}

function trackedAccount(value: string): boolean {
  return value.startsWith('wallet:') || value.startsWith('transfer:');
}

function balanceKey(unit: string, account: string): string {
  return `${unit}\0${account}`;
}

function moveValue(
  balances: Map<string, number>,
  observation: ValueMovement,
  operation: LifecycleOperationRecord,
): void {
  if (
    !EFFECT_ID_PATTERN.test(observation.effectId) ||
    !UNIT_PATTERN.test(observation.unit) ||
    observation.unit !== operation.unit ||
    !safePositive(observation.amount) ||
    !validAccount(observation.from) ||
    !validAccount(observation.to) ||
    observation.from === observation.to
  ) {
    fail(`value movement ${observation.effectId} is invalid`);
  }
  const fromKey = balanceKey(observation.unit, observation.from);
  const toKey = balanceKey(observation.unit, observation.to);
  const fromBalance = (balances.get(fromKey) ?? 0) - observation.amount;
  if (trackedAccount(observation.from) && fromBalance < 0) {
    fail(`${observation.from} cannot become negative`);
  }
  balances.set(fromKey, fromBalance);
  balances.set(toKey, (balances.get(toKey) ?? 0) + observation.amount);
}

function validProofTransition(from: LifecycleProofState, to: LifecycleProofState): boolean {
  if (from === to) return true;
  if (from === 'UNSPENT') return to === 'PENDING' || to === 'SPENT';
  if (from === 'PENDING') return to === 'UNSPENT' || to === 'SPENT';
  return false;
}

export function evaluateLifecycleModel(model: LifecycleModel): LifecycleEvaluation {
  const operations = new Map<string, LifecycleOperationRecord>();
  const balances = new Map<string, number>();
  const effects = new Map<string, ValueMovement>();
  const requests = new Map<string, RequestDispatch>();
  const quotes = new Map<string, QuoteObservation>();
  const proofs = new Map<string, ProofObservation>();
  const settlements = new Map<string, SettlementObservation>();
  const outputs = new Map<string, OutputsObservation>();

  for (const observation of model.observations) {
    switch (observation.type) {
      case 'operation_observed': {
        let created: LifecycleOperationRecord;
        try {
          created = createOperation(observation.operation);
        } catch {
          fail(`operation ${observation.operation.operationId} has invalid identity`);
        }
        if (
          observation.operation.phase !== 'created' ||
          observation.operation.evidenceCode !== undefined
        ) {
          fail(`operation ${created.operationId} must first be observed in created phase`);
        }
        const previous = operations.get(created.operationId);
        if (previous !== undefined && !sameOperation(previous, created)) {
          fail(`operation ${created.operationId} identity changed`);
        }
        operations.set(created.operationId, previous ?? created);
        break;
      }
      case 'phase_observed': {
        const current = operationFor(operations, observation.operationId);
        let next: LifecycleOperationRecord;
        try {
          next = transitionOperation(
            current,
            observation.phase,
            ...(observation.evidenceCode === undefined ? [] : [observation.evidenceCode]),
          );
        } catch (error) {
          fail(error instanceof Error ? error.message : 'operation phase is invalid');
        }
        operations.set(observation.operationId, next);
        break;
      }
      case 'value_moved': {
        const operation = operationFor(operations, observation.operationId);
        const previous = effects.get(observation.effectId);
        if (previous !== undefined) {
          if (!sameMovement(previous, observation)) {
            fail(`effect ${observation.effectId} conflicts with its first observation`);
          }
          break;
        }
        moveValue(balances, observation, operation);
        effects.set(observation.effectId, observation);
        break;
      }
      case 'request_dispatched': {
        operationFor(operations, observation.operationId);
        if (
          observation.method !== 'POST' ||
          !PATH_PATTERN.test(observation.path) ||
          !HASH_PATTERN.test(observation.bodyHash)
        ) {
          fail(`operation ${observation.operationId} request evidence is invalid`);
        }
        const key = `${observation.operationId}\0${observation.requestKind}`;
        const previous = requests.get(key);
        if (previous !== undefined && !sameRequest(previous, observation)) {
          fail(
            `operation ${observation.operationId} ${observation.requestKind} request digest changed`,
          );
        }
        requests.set(key, previous ?? observation);
        break;
      }
      case 'mint_quote_observed': {
        operationFor(operations, observation.operationId);
        if (
          !HASH_PATTERN.test(observation.quoteHash) ||
          !safeNonNegative(observation.amountPaid) ||
          !safeNonNegative(observation.amountIssued) ||
          !safeNonNegative(observation.updatedAt)
        ) {
          fail(`operation ${observation.operationId} mint quote evidence is invalid`);
        }
        if (observation.amountIssued > observation.amountPaid) {
          fail(`operation ${observation.operationId} amount issued exceeds amount paid`);
        }
        const previous = quotes.get(observation.quoteHash);
        if (previous !== undefined) {
          if (previous.operationId !== observation.operationId) {
            fail(`mint quote ${observation.quoteHash} owner changed`);
          }
          const amountsChanged =
            previous.amountPaid !== observation.amountPaid ||
            previous.amountIssued !== observation.amountIssued;
          if (
            observation.amountPaid < previous.amountPaid ||
            observation.amountIssued < previous.amountIssued ||
            observation.updatedAt < previous.updatedAt ||
            (amountsChanged && observation.updatedAt <= previous.updatedAt)
          ) {
            fail(`operation ${observation.operationId} mint quote regressed`);
          }
        }
        quotes.set(observation.quoteHash, observation);
        break;
      }
      case 'proof_state_observed': {
        operationFor(operations, observation.operationId);
        if (
          !HASH_PATTERN.test(observation.proofId) ||
          !IDENTIFIER_PATTERN.test(observation.owner.replace(/^wallet:/u, ''))
        ) {
          fail(`operation ${observation.operationId} proof evidence is invalid`);
        }
        const previous = proofs.get(observation.proofId);
        if (previous !== undefined) {
          if (previous.owner !== observation.owner) {
            fail(`proof owner changed for ${observation.proofId}`);
          }
          if (!validProofTransition(previous.state, observation.state)) {
            fail(`proof state regressed for ${observation.proofId}`);
          }
        }
        proofs.set(observation.proofId, observation);
        break;
      }
      case 'lightning_settlement_observed': {
        const operation = operationFor(operations, observation.operationId);
        if (
          operation.kind !== 'melt' ||
          !HASH_PATTERN.test(observation.invoiceHash) ||
          !HASH_PATTERN.test(observation.paymentHash) ||
          !safePositive(observation.amount) ||
          observation.unit !== operation.unit
        ) {
          fail(`operation ${observation.operationId} Lightning settlement evidence is invalid`);
        }
        const previous = settlements.get(observation.invoiceHash);
        if (previous !== undefined && !sameSettlement(previous, observation)) {
          fail(`Lightning invoice settled more than once: ${observation.invoiceHash}`);
        }
        settlements.set(observation.invoiceHash, previous ?? observation);
        break;
      }
      case 'outputs_persisted': {
        const operation = operationFor(operations, observation.operationId);
        if (
          !HASH_PATTERN.test(observation.outputPlanHash) ||
          !safePositive(observation.amount) ||
          observation.unit !== operation.unit
        ) {
          fail(`operation ${observation.operationId} output evidence is invalid`);
        }
        const previous = outputs.get(observation.operationId);
        if (previous !== undefined && !sameOutputs(previous, observation)) {
          fail(`operation ${observation.operationId} output plan changed`);
        }
        outputs.set(observation.operationId, previous ?? observation);
        break;
      }
    }
  }

  return {
    operations,
    balances,
    effects,
    requests,
    quotes,
    proofs,
    settlements,
    outputs,
  };
}

export function assertLifecycleSafety(model: LifecycleModel): void {
  evaluateLifecycleModel(model);
}

export function assertLifecycleQuiescence(model: LifecycleModel): void {
  const evaluation = evaluateLifecycleModel(model);
  const terminal = new Set(['succeeded', 'failed_definitive', 'recovery_blocked']);
  for (const operation of evaluation.operations.values()) {
    if (!terminal.has(operation.phase)) {
      fail(`operation ${operation.operationId} is not quiescent`);
    }
    if (
      operation.phase === 'succeeded' &&
      ['mint', 'swap', 'receive', 'restore'].includes(operation.kind) &&
      !evaluation.outputs.has(operation.operationId)
    ) {
      fail(`operation ${operation.operationId} has no persisted outputs`);
    }
    if (
      operation.phase === 'succeeded' &&
      operation.kind === 'melt' &&
      ![...evaluation.settlements.values()].some(
        (settlement) => settlement.operationId === operation.operationId,
      )
    ) {
      fail(`operation ${operation.operationId} has no Lightning settlement`);
    }
  }
}
