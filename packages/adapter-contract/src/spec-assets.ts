import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGED_SPEC_ROOT = fileURLToPath(new URL('../runtime/spec/', import.meta.url));
const REPOSITORY_SPEC_ROOT = fileURLToPath(new URL('../../../spec/', import.meta.url));
const IS_PACKAGED_DISTRIBUTION = existsSync(PACKAGED_SPEC_ROOT);

export function specAssetPath(...segments: readonly string[]): string {
  const root = IS_PACKAGED_DISTRIBUTION ? PACKAGED_SPEC_ROOT : REPOSITORY_SPEC_ROOT;
  return join(root, ...segments);
}
