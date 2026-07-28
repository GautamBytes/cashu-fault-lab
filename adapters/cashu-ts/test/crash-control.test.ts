import type { CrashArmInput } from '@cashu-fault-lab/adapter-contract';
import type { CrashBoundary } from '@cashu-fault-lab/delivery-core';
import { describe, expect, it } from 'vitest';
import {
  PostgresCrashCheckpoint,
  buildCashuTsAdapterServer,
  type CrashArm,
  type CrashArmStore,
  type ProcessTerminator,
} from '../src/index.js';

class MemoryCrashArmStore implements CrashArmStore {
  readonly arms = new Map<string, CrashArm>();
  armCalls = 0;
  active: string | undefined;

  async arm(input: Omit<CrashArm, 'hits' | 'consumed'>): Promise<void> {
    this.armCalls += 1;
    const key = `${input.runId}:${input.component}:${input.boundary}`;
    if (this.arms.has(key)) throw new Error('Crash arm already exists');
    this.arms.set(key, { ...input, hits: 0, consumed: false });
  }

  async hit(input: Pick<CrashArm, 'runId' | 'component' | 'boundary'>): Promise<boolean> {
    const key = `${input.runId}:${input.component}:${input.boundary}`;
    const arm = this.arms.get(key);
    if (arm === undefined || arm.consumed) return false;
    const hits = arm.hits + 1;
    const consumed = hits === arm.occurrence;
    this.arms.set(key, { ...arm, hits, consumed });
    return consumed;
  }

  async list(runId: string): Promise<readonly CrashArm[]> {
    return [...this.arms.values()].filter((arm) => arm.runId === runId);
  }

  async reset(runId: string): Promise<void> {
    for (const [key, arm] of this.arms) {
      if (arm.runId === runId) this.arms.delete(key);
    }
    this.active = runId;
  }

  async activeRun(): Promise<string | undefined> {
    return this.active;
  }
}

class Terminated extends Error {}

class FakeTerminator implements ProcessTerminator {
  calls = 0;

  terminate(): never {
    this.calls += 1;
    throw new Terminated('terminated');
  }
}

function crashArm(overrides: Partial<CrashArmInput> = {}): CrashArmInput {
  return {
    runId: 'run-a',
    component: 'sender',
    boundary: 'sender_before_proof_reservation',
    occurrence: 1,
    ...overrides,
  };
}

describe('cashu-ts crash controls', () => {
  it('terminates exactly once after durable one-shot consumption', async () => {
    const store = new MemoryCrashArmStore();
    const terminator = new FakeTerminator();
    const checkpoint = new PostgresCrashCheckpoint({ store, terminator });
    await checkpoint.reset('run-a');
    await checkpoint.arm(crashArm({ occurrence: 2 }));

    await checkpoint.hit('sender_before_proof_reservation', 'delivery-a');
    await expect(
      checkpoint.hit('sender_before_proof_reservation', 'delivery-a'),
    ).rejects.toBeInstanceOf(Terminated);
    await checkpoint.hit('sender_before_proof_reservation', 'delivery-a');

    expect(terminator.calls).toBe(1);
    expect(await checkpoint.status()).toEqual([
      expect.objectContaining({ hits: 2, consumed: true }),
    ]);

    const replacement = new PostgresCrashCheckpoint({ store, terminator });
    await replacement.initialize();
    expect(replacement.activeRunId()).toBe('run-a');
    expect(await replacement.status()).toEqual([
      expect.objectContaining({ runId: 'run-a', consumed: true }),
    ]);
  });

  it('accepts dotted scenario seeds as crash-control run IDs', async () => {
    const checkpoint = new PostgresCrashCheckpoint({
      store: new MemoryCrashArmStore(),
      terminator: new FakeTerminator(),
    });

    await expect(checkpoint.reset('cashu-fault-lab-v0.1.0-demo')).resolves.toBeUndefined();
    expect(checkpoint.activeRunId()).toBe('cashu-fault-lab-v0.1.0-demo');
  });

  it('keeps routes disabled by default and bearer-gates enabled controls', async () => {
    const disabled = await buildCashuTsAdapterServer({
      controlToken: 'control-token',
      now: () => 1,
    });
    try {
      expect((await disabled.inject({ method: 'GET', url: '/v1/test/crashes' })).statusCode).toBe(
        401,
      );
      expect(
        (
          await disabled.inject({
            method: 'GET',
            url: '/v1/test/crashes',
            headers: { authorization: 'Bearer control-token' },
          })
        ).statusCode,
      ).toBe(501);
    } finally {
      await disabled.close();
    }

    const store = new MemoryCrashArmStore();
    const control = new PostgresCrashCheckpoint({
      store,
      terminator: new FakeTerminator(),
    });
    const enabled = await buildCashuTsAdapterServer({
      controlToken: 'control-token',
      crashControl: control,
      now: () => 1,
    });
    const auth = { authorization: 'Bearer control-token' };
    try {
      expect(
        (
          await enabled.inject({
            method: 'POST',
            url: '/v1/reset',
            headers: auth,
            payload: { seed: 'run-a' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await enabled.inject({
            method: 'POST',
            url: '/v1/test/crashes',
            headers: { authorization: 'Bearer wrong-token' },
            payload: crashArm(),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await enabled.inject({
            method: 'POST',
            url: '/v1/test/crashes',
            headers: auth,
            payload: { ...crashArm(), occurrence: 0, extra: true },
          })
        ).statusCode,
      ).toBe(422);
      expect(store.armCalls).toBe(0);
      expect(
        (
          await enabled.inject({
            method: 'POST',
            url: '/v1/test/crashes',
            headers: auth,
            payload: crashArm(),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await enabled.inject({
            method: 'GET',
            url: '/v1/test/crashes',
            headers: auth,
          })
        ).json(),
      ).toEqual([expect.objectContaining({ runId: 'run-a', consumed: false })]);
      const capabilities = (
        await enabled.inject({ method: 'GET', url: '/v1/capabilities', headers: auth })
      ).json();
      expect(capabilities.testControls.crashBoundaries).toContain(
        'receiver_after_credit_before_receipt_persistence' satisfies CrashBoundary,
      );
      expect(
        (
          await enabled.inject({
            method: 'POST',
            url: '/v1/test/crashes',
            headers: { ...auth, 'content-type': 'application/json' },
            payload: JSON.stringify({ value: 'x'.repeat(20_000) }),
          })
        ).statusCode,
      ).toBe(413);
    } finally {
      await enabled.close();
    }
  });
});
