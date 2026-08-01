import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('website response security headers', () => {
  it('applies browser hardening headers to every route', async () => {
    const source = await readFile(resolve(process.cwd(), 'next.config.mjs'), 'utf8');
    expect(source).toContain("source: '/:path*'");
    expect(source).toContain("{ key: 'X-Content-Type-Options', value: 'nosniff' }");
    expect(source).toContain("{ key: 'X-Frame-Options', value: 'DENY' }");
    expect(source).toContain(
      "{ key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }",
    );
    expect(source).toContain(
      "{ key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }",
    );
    expect(source).toContain("{ key: 'Cross-Origin-Opener-Policy', value: 'same-origin' }");
  });
});
