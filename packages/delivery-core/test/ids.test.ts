import { describe, expect, it } from 'vitest';
import { DeliveryValidationError, generateProtocolId, parseProtocolId } from '../src/index';

describe('protocol IDs', () => {
  it('encodes exactly 16 supplied bytes as canonical unpadded base64url', () => {
    const id = generateProtocolId(() => Uint8Array.from({ length: 16 }, (_, index) => index));

    expect(id).toBe('AAECAwQFBgcICQoLDA0ODw');
    expect(parseProtocolId(id)).toBe(id);
  });

  it.each(['', 'AAECAwQFBgcICQoLDA0ODw==', 'AAECAwQFBgcICQoLDA0OD', 'not+base64url/value____'])(
    'rejects a non-canonical or wrong-length ID: %s',
    (value) => {
      expect(() => parseProtocolId(value)).toThrowError(
        new DeliveryValidationError('INVALID_PROTOCOL_ID', 'Protocol ID must encode 16 bytes'),
      );
    },
  );

  it('rejects a random source that returns the wrong byte count', () => {
    expect(() => generateProtocolId(() => new Uint8Array(15))).toThrowError(
      new DeliveryValidationError('INVALID_RANDOM_SOURCE', 'Random source must return 16 bytes'),
    );
  });
});
