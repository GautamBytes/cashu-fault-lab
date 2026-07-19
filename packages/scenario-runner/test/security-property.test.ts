import { parseDeliveryPayloadJson } from '@cashu-fault-lab/delivery-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

function stableFailure(payload: Uint8Array): string {
  try {
    parseDeliveryPayloadJson(payload, 1_784_399_400);
    return 'accepted';
  } catch (error) {
    if (!(error instanceof Error)) return 'Error:unknown';
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
    return `${code}:${error.message}`;
  }
}

describe('malformed payload property lane', () => {
  it('fails arbitrary invalid UTF-8 deterministically with bounded stable errors', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4_096 }), (tail) => {
        const payload = Uint8Array.of(0xff, ...tail);
        const first = stableFailure(payload);
        const second = stableFailure(payload);

        expect(first).not.toBe('accepted');
        expect(second).toBe(first);
        expect(first.length).toBeLessThanOrEqual(256);
      }),
      { numRuns: 1_000, seed: 0x43415348 },
    );
  });
});
