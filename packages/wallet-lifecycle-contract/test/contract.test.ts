import { describe, expect, test } from 'vitest';
import {
  validateLifecycleRequest,
  validateLifecycleResponse,
  type LifecycleCapabilities,
  type LifecycleOperationInput,
  type LifecycleOperationView,
} from '../src/index.js';

const operationId = 'AAAAAAAAAAAAAAAAAAAAAA';
const mint = 'http://127.0.0.1:3338';

const capabilities: LifecycleCapabilities = {
  schemaVersion: 1,
  implementation: {
    id: 'cashu-ts',
    version: '2.8.1',
    language: 'typescript',
    runtime: 'node-24',
    sourceDigest: `sha256:${'a'.repeat(64)}`,
    buildDigest: `sha256:${'b'.repeat(64)}`,
  },
  operations: ['mint', 'swap', 'send', 'receive', 'melt', 'restore', 'reconcile'],
  nuts: [3, 4, 5, 7, 8, 9, 13, 19, 20, 23],
  durability: 'restart_safe',
  recovery: ['quote_state', 'proof_state', 'nut09_restore', 'nut19_replay'],
  mints: [{ id: 'nutshell-local', implementation: 'nutshell', version: '0.20.2' }],
};

const mintInput: LifecycleOperationInput = {
  operationId,
  kind: 'mint',
  mint,
  unit: 'sat',
  amount: 64,
  method: 'bolt11',
};

const operationView: LifecycleOperationView = {
  operationId,
  kind: 'mint',
  mint,
  unit: 'sat',
  intentHash: 'c'.repeat(64),
  phase: 'created',
  amount: 64,
  requestHash: 'd'.repeat(64),
};

describe('lifecycle adapter contract', () => {
  test('accepts strict capabilities and rejects unknown fields', () => {
    expect(validateLifecycleResponse('capabilities', capabilities)).toEqual({ ok: true });
    expect(
      validateLifecycleResponse('capabilities', { ...capabilities, walletSeed: 'secret' }),
    ).toMatchObject({ ok: false, errorCode: 'SCHEMA_ADDITIONAL_PROPERTY' });
  });

  test('accepts every closed operation discriminator', () => {
    const inputs: readonly LifecycleOperationInput[] = [
      mintInput,
      { operationId, kind: 'swap', mint, unit: 'sat', amount: 64 },
      { operationId, kind: 'send', mint, unit: 'sat', amount: 64, recipient: 'bob' },
      { operationId, kind: 'receive', mint, unit: 'sat', token: 'cashuBtest' },
      {
        operationId,
        kind: 'melt',
        mint,
        unit: 'sat',
        invoice: 'lnbcrt1test',
        preferAsync: true,
      },
      { operationId, kind: 'restore', mint, unit: 'sat' },
      { operationId, kind: 'reconcile', mint, unit: 'sat', targetOperationId: operationId },
    ];

    for (const input of inputs) {
      expect(validateLifecycleRequest('start', input)).toEqual({ ok: true });
    }
  });

  test('rejects unsafe amounts, mixed discriminator fields, and unknown operations', () => {
    expect(
      validateLifecycleRequest('start', { ...mintInput, amount: Number.MAX_SAFE_INTEGER + 1 }),
    ).toMatchObject({ ok: false, errorCode: 'SCHEMA_MAXIMUM' });
    expect(
      validateLifecycleRequest('start', { ...mintInput, invoice: 'lnbcrt1test' }),
    ).toMatchObject({
      ok: false,
    });
    expect(validateLifecycleRequest('unknown' as 'start', mintInput)).toMatchObject({
      ok: false,
      errorCode: 'UNKNOWN_OPERATION',
    });
  });

  test('accepts sanitized operation evidence and rejects bearer material', () => {
    expect(validateLifecycleResponse('operation', operationView)).toEqual({ ok: true });
    for (const secretField of ['proofs', 'secret', 'seed', 'quoteId', 'preimage', 'signature']) {
      expect(
        validateLifecycleResponse('operation', { ...operationView, [secretField]: 'canary' }),
      ).toMatchObject({ ok: false, errorCode: 'SCHEMA_ADDITIONAL_PROPERTY' });
    }
  });

  test('requires canonical mint URLs and canonical 128-bit operation IDs', () => {
    expect(validateLifecycleRequest('start', { ...mintInput, mint: `${mint}/` })).toMatchObject({
      ok: false,
      errorCode: 'SCHEMA_FORMAT',
    });
    expect(
      validateLifecycleRequest('start', { ...mintInput, operationId: 'not-an-id' }),
    ).toMatchObject({
      ok: false,
      errorCode: 'SCHEMA_PATTERN',
    });
  });
});
