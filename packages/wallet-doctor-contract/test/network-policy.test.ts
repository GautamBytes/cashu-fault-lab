import { describe, expect, it, vi } from 'vitest';
import {
  assertResolvedAddressesSafe,
  assertSafeHttpUrl,
  assertSafeRelayUrl,
  createPinnedLookup,
  isPublicAddress,
} from '../src/index.js';

describe('wallet-doctor outbound network policy', () => {
  it('rejects private, link-local, reserved, and IPv4-mapped IPv6 targets', () => {
    for (const address of [
      '10.0.0.1',
      '169.254.169.254',
      '192.168.1.2',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('keeps loopback HTTP and WS behind explicit lab mode', () => {
    expect(() => assertSafeHttpUrl('http://127.0.0.1:3338', false)).toThrow(/explicit lab mode/u);
    expect(() => assertSafeRelayUrl('ws://[::1]:4400', false)).toThrow(/explicit lab mode/u);
    expect(assertSafeHttpUrl('http://127.0.0.1:3338', true).hostname).toBe('127.0.0.1');
    expect(assertSafeRelayUrl('ws://[::1]:4400', true).hostname).toBe('[::1]');
  });

  it('rejects mixed public/private DNS answers and pins the approved answer into the socket lookup', async () => {
    expect(() =>
      assertResolvedAddressesSafe(
        'rebind.example',
        [
          { address: '8.8.8.8', family: 4 },
          { address: '169.254.169.254', family: 4 },
        ],
        false,
      ),
    ).toThrow(/private or reserved/u);

    const resolver = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const lookup = createPinnedLookup(false, resolver);
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup('mint.example', {}, (error, address, family) => {
        if (error !== null) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });
    expect(result).toEqual({ address: '8.8.8.8', family: 4 });
    expect(resolver).toHaveBeenCalledTimes(1);
  });
});
