import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';

test('every public route runs Axe before the overflow check', async () => {
  const portalSpec = await readFile(
    path.join(import.meta.dirname, '..', 'e2e', 'portal.spec.ts'),
    'utf8',
  );
  const publicRouteTest = portalSpec.match(/test\('every public route[\s\S]*?\n}\);/)?.[0];

  expect(publicRouteTest).toBeDefined();
  expect(publicRouteTest).toMatch(
    /await page\.goto\(route\);\s+await expectNoSeriousAccessibilityViolations\(page\);\s+await expectNoPageOverflow\(page\);/,
  );
});
