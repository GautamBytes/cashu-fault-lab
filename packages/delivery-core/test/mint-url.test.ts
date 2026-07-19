import { describe, expect, it } from 'vitest';
import { DeliveryValidationError, normalizeMintUrl } from '../src/index';

describe('normalizeMintUrl', () => {
  it.each([
    ['HTTPS://Mint.Example:443/', 'https://mint.example'],
    ['https://Mint.Example/cashu/', 'https://mint.example/cashu'],
    ['http://localhost:3338/', 'http://localhost:3338'],
    ['http://127.0.0.1:3338/', 'http://127.0.0.1:3338'],
    ['http://[::1]:3338/', 'http://[::1]:3338'],
    ['https://BÜCHER.example:443/cashu/', 'https://xn--bcher-kva.example/cashu'],
    ['https://mint.example/a%20b/', 'https://mint.example/a%20b'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeMintUrl(input)).toBe(expected);
  });

  it.each([
    ['http://mint.example', 'INSECURE_MINT_URL'],
    ['ftp://mint.example', 'INVALID_MINT_URL'],
    ['https://user:password@mint.example', 'INVALID_MINT_URL'],
    ['https://mint.example?tenant=one', 'INVALID_MINT_URL'],
    ['https://mint.example/#fragment', 'INVALID_MINT_URL'],
    ['https://mint.example?', 'INVALID_MINT_URL'],
    ['https://mint.example#', 'INVALID_MINT_URL'],
    ['https://@mint.example', 'INVALID_MINT_URL'],
    [' https://mint.example', 'INVALID_MINT_URL'],
    ['https://mint.example ', 'INVALID_MINT_URL'],
    ['https://mint.example\\cashu', 'INVALID_MINT_URL'],
    ['not a URL', 'INVALID_MINT_URL'],
  ] as const)('rejects an unsafe mint URL: %s', (input, expectedCode) => {
    try {
      normalizeMintUrl(input);
      throw new Error('expected normalizeMintUrl to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(DeliveryValidationError);
      expect((error as DeliveryValidationError).code).toBe(expectedCode);
    }
  });
});
