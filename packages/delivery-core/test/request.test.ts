import { describe, expect, it } from 'vitest';
import { DeliveryValidationError, parseDeliveryNegotiation } from '../src/index';

describe('delivery negotiation', () => {
  it('parses exact version-one transport tags', () => {
    expect(
      parseDeliveryNegotiation(
        [
          ['delivery', '1'],
          ['expires_at', '1784400300'],
        ],
        1_784_399_400,
      ),
    ).toEqual({ version: 1, expiresAt: 1_784_400_300 });
  });

  it('treats absent and unknown versions as unsupported', () => {
    expect(parseDeliveryNegotiation([], 100)).toBeUndefined();
    expect(parseDeliveryNegotiation([['delivery', '2']], 100)).toBeUndefined();
  });

  it.each([
    [[['delivery', '1']], 'expiry'],
    [
      [
        ['delivery', '1'],
        ['delivery', '1'],
        ['expires_at', '101'],
      ],
      'duplicate',
    ],
    [
      [
        ['delivery', '1'],
        ['expires_at', 'not-a-time'],
      ],
      'expiry',
    ],
    [
      [
        ['delivery', '1'],
        ['expires_at', '100'],
      ],
      'expired',
    ],
    [
      [
        ['delivery', '1'],
        ['expires_at', '86502'],
      ],
      '24 hours',
    ],
  ] as const)('rejects malformed version-one tags: %s', (tags, message) => {
    expect(() => parseDeliveryNegotiation(tags, 100)).toThrowError(
      expect.objectContaining<Partial<DeliveryValidationError>>({
        name: 'DeliveryValidationError',
        message: expect.stringMatching(new RegExp(message, 'i')),
      }),
    );
  });
});
