import { describe, expect, it } from 'vitest';
import { NostrRelayClient } from '../src/index.js';

describe('NostrRelayClient', () => {
  it('normalizes wss relay URLs', () => {
    const client = new NostrRelayClient({
      relayUrl: 'wss://relay.example.com/',
      timeoutMs: 2_000,
    });
    expect(client).toBeDefined();
  });

  it('rejects non-ws relay URLs', () => {
    expect(
      () =>
        new NostrRelayClient({
          relayUrl: 'http://relay.example.com',
          timeoutMs: 2_000,
        }),
    ).toThrow();
  });

  it('rejects relay URLs with credentials', () => {
    expect(
      () =>
        new NostrRelayClient({
          relayUrl: 'wss://user:pass@relay.example.com',
          timeoutMs: 2_000,
        }),
    ).toThrow();
  });

  it('rejects a timeout below 1ms', () => {
    expect(
      () =>
        new NostrRelayClient({
          relayUrl: 'wss://relay.example.com',
          timeoutMs: 0,
        }),
    ).toThrow('must be an integer from 1');
  });

  it('rejects a timeout above 5 minutes', () => {
    expect(
      () =>
        new NostrRelayClient({
          relayUrl: 'wss://relay.example.com',
          timeoutMs: 300_001,
        }),
    ).toThrow('must be an integer from 1');
  });

  it('rejects a maximumEvents below 1', () => {
    expect(
      () =>
        new NostrRelayClient({
          relayUrl: 'wss://relay.example.com',
          timeoutMs: 2_000,
          maximumEvents: 0,
        }),
    ).toThrow('must be an integer from 1');
  });

  it('rejects a maximumEvents above 100,000', () => {
    expect(
      () =>
        new NostrRelayClient({
          relayUrl: 'wss://relay.example.com',
          timeoutMs: 2_000,
          maximumEvents: 100_001,
        }),
    ).toThrow('must be an integer from 1');
  });

  it('accepts valid timeout and event limit', () => {
    const client = new NostrRelayClient({
      relayUrl: 'wss://relay.example.com',
      timeoutMs: 5_000,
      maximumEvents: 500,
    });
    expect(client).toBeDefined();
  });
});
