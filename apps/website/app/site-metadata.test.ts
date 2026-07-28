import { describe, expect, it } from 'vitest';
import { resolveSiteUrl, serializeJsonLd } from './site-metadata';

describe('resolveSiteUrl', () => {
  it('prefers the sanitized production host and adds HTTPS', () => {
    expect(
      resolveSiteUrl({
        VERCEL_PROJECT_PRODUCTION_URL: 'cashu-fault-lab.example',
        VERCEL_URL: 'preview.example',
      }).toString(),
    ).toBe('https://cashu-fault-lab.example/');
  });

  it('normalizes an accidental scheme without duplicating it', () => {
    expect(
      resolveSiteUrl({
        VERCEL_PROJECT_PRODUCTION_URL: 'https://cashu-fault-lab.example',
        VERCEL_URL: undefined,
      }).toString(),
    ).toBe('https://cashu-fault-lab.example/');
  });

  it('falls through unsafe hosts and then defaults to localhost', () => {
    expect(
      resolveSiteUrl({
        VERCEL_PROJECT_PRODUCTION_URL: 'production.example/unexpected-path',
        VERCEL_URL: 'preview.example',
      }).toString(),
    ).toBe('https://preview.example/');

    expect(
      resolveSiteUrl({
        VERCEL_PROJECT_PRODUCTION_URL: 'production.example/#fragment',
        VERCEL_URL: 'preview.example/path',
      }).toString(),
    ).toBe('http://localhost:3000/');
  });
});

describe('serializeJsonLd', () => {
  it('escapes markup that could close the script element', () => {
    const serialized = serializeJsonLd({
      description: '</script><script>alert("unsafe")</script>',
    });

    expect(serialized).not.toContain('<');
    expect(serialized).toContain('\\u003c/script>');
  });
});
