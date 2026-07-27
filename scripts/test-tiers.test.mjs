import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const environmentHelper = await readFile(
  new URL('./test-environment.mjs', import.meta.url),
  'utf8',
);

test('default tests are Docker-free and explicit tiers are available', () => {
  assert.equal(root.scripts.test, 'pnpm test:unit');
  assert.match(root.scripts['test:unit'], /test:unit:packages/);
  assert.match(root.scripts['test:integration'], /--skip-unavailable/);
  assert.match(root.scripts['test:integration'], /test:integration:run/);
  assert.doesNotMatch(root.scripts['test:funded'], /--skip-unavailable/);
  assert.match(root.scripts['test:funded'], /test:funded:run/);
  assert.equal(
    root.scripts['test:all'],
    'pnpm test:unit && pnpm test:integration && pnpm test:funded',
  );
});

test('unit package tests exclude every container-backed suite', () => {
  const command = root.scripts['test:unit:packages'];
  for (const suite of [
    'postgres-state.test.ts',
    'postgres-store.test.ts',
    'crash-recovery.test.ts',
    'postgres-receiver-store.test.ts',
    'docker-mint-e2e.test.ts',
    'docker-funded-e2e.test.ts',
    'nostr-relay-e2e.test.ts',
    'cross-language-docker.test.ts',
  ]) {
    assert.match(command, new RegExp(suite.replaceAll('.', '\\.')));
  }
});

test('strict funded preflight accepts a command without optional flags', () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL('./test-environment.mjs', import.meta.url).pathname,
      'funded',
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ],
    { encoding: 'utf8', env: {} },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^test:funded blocked:/);
  assert.doesNotMatch(result.stderr, /usage:/);
});

test('environment preflight enables every opt-in lane it owns', () => {
  assert.match(environmentHelper, /CFL_POSTGRES_E2E:\s*'1'/);
  assert.match(environmentHelper, /CFL_NOSTR_RELAY_E2E:\s*'1'/);
  assert.match(environmentHelper, /'CFL_REAL_MINT_URL'/);
});
