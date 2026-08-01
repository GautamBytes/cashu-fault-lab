import { describe, expect, test } from 'vitest';
import {
  createOperation,
  parseOperationId,
  transitionOperation,
  type LifecycleOperationIdentity,
  type LifecyclePhase,
} from '../src/index.js';

const identity: LifecycleOperationIdentity = {
  operationId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'mint',
  mint: 'http://127.0.0.1:3338',
  unit: 'sat',
  intentHash: 'a'.repeat(64),
};

describe('lifecycle operation identity', () => {
  test('accepts only canonical 128-bit base64url operation IDs', () => {
    expect(parseOperationId(identity.operationId)).toBe(identity.operationId);

    for (const invalid of [
      '',
      'short',
      '!!!!!!!!!!!!!!!!!!!!!!',
      'AAAAAAAAAAAAAAAAAAAAA=',
      'AAAAAAAAAAAAAAAAAAAAAAA',
      '______________________',
    ]) {
      expect(() => parseOperationId(invalid)).toThrow('operation ID');
    }
  });

  test('creates an immutable record from a bounded canonical identity', () => {
    const operation = createOperation(identity);

    expect(operation).toEqual({ ...identity, phase: 'created' });
    expect(Object.isFrozen(operation)).toBe(true);
  });

  test.each([
    [{ ...identity, kind: 'unknown' }, 'kind'],
    [{ ...identity, mint: 'https://user:pass@mint.example' }, 'mint URL'],
    [{ ...identity, mint: 'https://mint.example/?secret=1' }, 'mint URL'],
    [{ ...identity, unit: '' }, 'unit'],
    [{ ...identity, unit: 'SAT' }, 'unit'],
    [{ ...identity, intentHash: 'ABC' }, 'intent hash'],
  ])('rejects malformed identity fields', (candidate, message) => {
    expect(() => createOperation(candidate as LifecycleOperationIdentity)).toThrow(message);
  });
});

describe('lifecycle operation transitions', () => {
  test('allows the successful lifecycle path without mutating previous records', () => {
    const created = createOperation(identity);
    const prepared = transitionOperation(created, 'prepared');
    const submitted = transitionOperation(prepared, 'submitted');
    const succeeded = transitionOperation(submitted, 'succeeded');

    expect(created.phase).toBe('created');
    expect(prepared.phase).toBe('prepared');
    expect(submitted.phase).toBe('submitted');
    expect(succeeded.phase).toBe('succeeded');
    expect(Object.isFrozen(succeeded)).toBe(true);
  });

  test('allows ambiguous operations to reconcile to every evidenced terminal state', () => {
    for (const [terminal, evidenceCode] of [
      ['succeeded', undefined],
      ['failed_definitive', 'inputs_unspent'],
      ['recovery_blocked', 'nut09_unavailable'],
    ] as const) {
      let operation = createOperation(identity);
      for (const phase of ['prepared', 'submitted', 'ambiguous', 'reconciling'] as const) {
        operation = transitionOperation(operation, phase);
      }

      expect(transitionOperation(operation, terminal, evidenceCode)).toMatchObject({
        phase: terminal,
        ...(evidenceCode === undefined ? {} : { evidenceCode }),
      });
    }
  });

  test('treats a repeated phase and evidence as an idempotent observation', () => {
    const created = createOperation(identity);
    const prepared = transitionOperation(created, 'prepared');
    const repeated = transitionOperation(prepared, 'prepared');

    expect(repeated).toEqual(prepared);
    expect(repeated).not.toBe(prepared);
  });

  test.each([
    ['created', 'submitted'],
    ['created', 'succeeded'],
    ['created', 'failed_definitive'],
    ['prepared', 'succeeded'],
    ['prepared', 'failed_definitive'],
    ['submitted', 'failed_definitive'],
    ['submitted', 'created'],
    ['ambiguous', 'succeeded'],
    ['reconciling', 'submitted'],
    ['succeeded', 'reconciling'],
    ['failed_definitive', 'reconciling'],
    ['recovery_blocked', 'reconciling'],
  ] satisfies readonly (readonly [LifecyclePhase, LifecyclePhase])[])(
    'rejects the transition %s -> %s',
    (from, to) => {
      const record = Object.freeze({ ...identity, phase: from });
      expect(() =>
        transitionOperation(
          record,
          to,
          to === 'failed_definitive' ? 'definitive_failure' : undefined,
        ),
      ).toThrow('invalid lifecycle transition');
    },
  );

  test.each(['failed_definitive', 'recovery_blocked'] as const)(
    'requires a stable evidence code for %s',
    (terminal) => {
      const reconciling = Object.freeze({ ...identity, phase: 'reconciling' as const });
      expect(() => transitionOperation(reconciling, terminal)).toThrow('evidence code');
      expect(() => transitionOperation(reconciling, terminal, 'UPPERCASE')).toThrow(
        'evidence code',
      );
    },
  );
});
