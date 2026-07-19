import { describe, expect, it, vi } from 'vitest';
import { VirtualScheduler } from '../src/index.js';

describe('VirtualScheduler', () => {
  it('runs scheduled work only after virtual time reaches its deadline', () => {
    const events: string[] = [];
    const scheduler = new VirtualScheduler(0);
    scheduler.schedule(250, () => events.push('retry'));

    scheduler.advanceBy(249);
    expect(events).toEqual([]);
    expect(scheduler.now).toBe(249);
    scheduler.advanceBy(1);
    expect(events).toEqual(['retry']);
    expect(scheduler.now).toBe(250);
  });

  it('uses FIFO order for equal deadlines and runs nested due work deterministically', () => {
    const events: string[] = [];
    const scheduler = new VirtualScheduler(10);
    scheduler.schedule(5, () => {
      events.push('a');
      scheduler.schedule(0, () => events.push('c'));
    });
    scheduler.schedule(5, () => events.push('b'));

    scheduler.advanceBy(5);
    expect(events).toEqual(['a', 'b', 'c']);
  });

  it('supports cancellation and an execution limit', () => {
    const scheduler = new VirtualScheduler();
    const callback = vi.fn();
    const handle = scheduler.schedule(1, callback);
    handle.cancel();
    scheduler.runUntilIdle();
    expect(callback).not.toHaveBeenCalled();

    const spin = (): void => {
      scheduler.schedule(0, spin);
    };
    spin();
    expect(() => scheduler.runUntilIdle(10)).toThrowError(/limit/i);
  });

  it('rejects invalid virtual timestamps', () => {
    expect(() => new VirtualScheduler(-1)).toThrowError(/time/i);
    const scheduler = new VirtualScheduler();
    expect(() => scheduler.advanceBy(-1)).toThrowError(/time/i);
    expect(() => scheduler.schedule(1.5, () => undefined)).toThrowError(/time/i);
  });
});
