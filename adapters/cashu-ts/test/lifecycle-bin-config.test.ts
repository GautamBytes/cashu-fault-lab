import { describe, expect, test } from 'vitest';
import { lifecycleListenHost } from '../src/bin-config.js';

describe('cashu-ts lifecycle CLI config', () => {
  test('requires lifecycle mode to bind to loopback', () => {
    expect(lifecycleListenHost(undefined, true)).toBe('127.0.0.1');
    expect(lifecycleListenHost('127.0.0.1', true)).toBe('127.0.0.1');
    expect(() => lifecycleListenHost('0.0.0.0', true)).toThrow(
      'CFL_CASHU_TS_HOST must be 127.0.0.1 when lifecycle mode is enabled',
    );
  });

  test('keeps the existing funded adapter bind options without lifecycle mode', () => {
    expect(lifecycleListenHost('0.0.0.0', false)).toBe('0.0.0.0');
  });
});
