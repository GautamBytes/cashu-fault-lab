import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const environmentHelper = await readFile(
  new URL('./test-environment.mjs', import.meta.url),
  'utf8',
);
const lifecycleComposeFiles = await Promise.all(
  ['wallet-lifecycle.compose.yml', 'lightning-regtest.compose.yml'].map((file) =>
    readFile(new URL(`../infra/compose/${file}`, import.meta.url), 'utf8'),
  ),
);

test('default tests are Docker-free and explicit tiers are available', () => {
  assert.equal(root.scripts.test, 'pnpm test:unit');
  assert.match(root.scripts['test:unit'], /test:unit:packages/);
  assert.match(root.scripts['test:integration'], /--skip-unavailable/);
  assert.match(root.scripts['test:integration'], /test:integration:run/);
  assert.doesNotMatch(root.scripts['test:funded'], /--skip-unavailable/);
  assert.match(root.scripts['test:funded'], /test:funded:run/);
  assert.match(root.scripts['test:lifecycle:funded'], /lifecycle-funded/);
  assert.match(root.scripts['test:lifecycle:funded'], /test:lifecycle:funded:run/);
  assert.match(root.scripts['test:lifecycle:regtest'], /lifecycle-regtest/);
  assert.match(root.scripts['test:lifecycle:regtest'], /test:lifecycle:regtest:run/);
  assert.equal(
    root.scripts['test:all'],
    'pnpm test:unit && pnpm test:integration && pnpm test:funded',
  );
});

test('funded stack consumers run before the crash suite takes ownership of compose', () => {
  const command = root.scripts['test:funded:run'];
  assert.match(
    command,
    /cross-language-docker\.test\.ts[^&]*&&[^&]*funded-crash-boundaries\.test\.ts/,
  );
  assert.doesNotMatch(
    command,
    /vitest run[^&]*cross-language-docker\.test\.ts[^&]*funded-crash-boundaries\.test\.ts/,
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
    'funded-lifecycle.test.ts',
    'regtest-melt.test.ts',
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
  assert.match(environmentHelper, /CFL_WALLET_LIFECYCLE_E2E:\s*'1'/);
  assert.match(environmentHelper, /CFL_WALLET_LIFECYCLE_REGTEST:\s*'1'/);
  assert.match(environmentHelper, /pass <= 2/);
});

test('lifecycle compose wrappers use flags supported by GitHub hosted runners', () => {
  assert.doesNotMatch(environmentHelper, /--quiet-build/);
});

test('lifecycle CDK state keys are valid 32-byte base64url values', () => {
  const keys = lifecycleComposeFiles.flatMap((compose) =>
    [...compose.matchAll(/CASHU_FAULT_LAB_CDK_LIFECYCLE_STATE_KEY:\s+([A-Za-z0-9_-]+)/g)].map(
      (match) => match[1],
    ),
  );
  assert.ok(keys.length > 0);
  for (const key of keys) {
    const decoded = Buffer.from(key, 'base64url');
    assert.equal(decoded.length, 32);
    assert.equal(decoded.toString('base64url'), key);
  }
});

test('lifecycle CDK healthchecks do not require a wallet before reset', () => {
  for (const compose of lifecycleComposeFiles) {
    assert.doesNotMatch(compose, /curl[^\n]*\/v1\/lifecycle\/capabilities/);
  }
});

test('lifecycle suites build the runner dependency graph before executing specs', () => {
  for (const scriptName of ['test:lifecycle:funded:run', 'test:lifecycle:regtest:run']) {
    const command = root.scripts[scriptName];
    assert.match(
      command,
      /^pnpm exec turbo run build --filter=@cashu-fault-lab\/wallet-lifecycle-runner\.\.\. && /,
    );
    assert.match(command, /vitest run test\/(?:funded-lifecycle|regtest-melt)\.test\.ts/);
  }

  const funded = root.scripts['test:lifecycle:funded:run'];
  assert.match(funded, /turbo run build --filter=@cashu-fault-lab\/lab-cli\.\.\./);
  assert.match(
    funded,
    /docker compose -f infra\/compose\/wallet-lifecycle\.compose\.yml up -d --no-deps --force-recreate --wait --wait-timeout 120 cdk-nutshell cdk-mintd/,
  );
  assert.match(
    funded,
    /node apps\/lab-cli\/dist\/bin\.js lifecycle matrix --profile wallet-lifecycle-v1 --seed wallet-lifecycle-funded --json$/,
  );
  assert.match(
    root.scripts['test:lifecycle:regtest:run'],
    /vitest run test\/regtest-melt\.test\.ts$/,
  );
});
