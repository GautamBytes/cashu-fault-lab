import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dockerignoreUrl = new URL('../.dockerignore', import.meta.url);

function activeEntries(contents) {
  return new Set(
    contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

test('local worktrees and pnpm stores are excluded from the Docker context', async () => {
  const entries = activeEntries(await readFile(dockerignoreUrl, 'utf8'));

  for (const required of ['.worktrees', '.worktrees/', '.pnpm-store', '.pnpm-store/']) {
    assert.ok(entries.has(required), `.dockerignore must contain exact entry ${required}`);
  }
});
