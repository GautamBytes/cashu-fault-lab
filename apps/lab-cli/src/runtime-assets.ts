import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGED_RUNTIME_ROOT = fileURLToPath(new URL('../runtime/', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const IS_PACKAGED_DISTRIBUTION = existsSync(PACKAGED_RUNTIME_ROOT);

export function runtimeAssetPath(...segments: readonly string[]): string {
  const packaged = join(PACKAGED_RUNTIME_ROOT, ...segments);
  if (IS_PACKAGED_DISTRIBUTION) return packaged;

  const [group, ...rest] = segments;
  if (group === 'compose') return join(REPOSITORY_ROOT, 'infra', 'compose', ...rest);
  return join(REPOSITORY_ROOT, ...segments);
}
