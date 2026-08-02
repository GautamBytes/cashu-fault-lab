import { spawnSync } from 'node:child_process';

const REQUIRED_FUNDED_ENV = [
  'CFL_REAL_MINT_URL',
  'CFL_CASHU_TS_TOKEN',
  'CFL_CDK_TOKEN',
  'CFL_REFERENCE_RECEIVER_TOKEN',
  'CFL_REFERENCE_RECEIVER_CLAIM_KEY',
  'CFL_HTTP_FAULT_GATEWAY_TOKEN',
];
const LIFECYCLE_COMPOSE = 'infra/compose/wallet-lifecycle.compose.yml';
const LIFECYCLE_ENV = {
  CFL_HTTP_FAULT_GATEWAY_TOKEN: 'lifecycle-fault-token',
  CFL_LIFECYCLE_CASHU_TS_TOKEN: 'lifecycle-cashu-ts-token',
  CFL_LIFECYCLE_CDK_TOKEN: 'lifecycle-cdk-token',
};
const LIFECYCLE_REGTEST_COMPOSE = 'infra/compose/lightning-regtest.compose.yml';
const LIFECYCLE_REGTEST_ENV = {
  CFL_LIGHTNING_PROBE_TOKEN: 'lifecycle-regtest-probe-token',
  CFL_HTTP_FAULT_GATEWAY_TOKEN: 'lifecycle-regtest-fault-token',
  CFL_LIFECYCLE_CASHU_TS_TOKEN: 'lifecycle-regtest-cashu-ts-token',
};

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const separator = process.argv.indexOf('--');
if (separator < 3 || separator === process.argv.length - 1) {
  fail(
    'usage: node scripts/test-environment.mjs <docker|funded|lifecycle-funded|lifecycle-regtest> [--skip-unavailable] -- <command> [args...]',
  );
} else {
  const mode = process.argv[2];
  const options = new Set(process.argv.slice(3, separator));
  const command = process.argv[separator + 1];
  const args = process.argv.slice(separator + 2);
  if (
    mode !== 'docker' &&
    mode !== 'funded' &&
    mode !== 'lifecycle-funded' &&
    mode !== 'lifecycle-regtest'
  ) {
    fail(`unknown test environment mode: ${mode}`);
  } else if (options.size > 1 || [...options].some((value) => value !== '--skip-unavailable')) {
    fail(`unknown test environment option: ${[...options].join(', ')}`);
  } else {
    const docker = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (docker.status !== 0) {
      if (options.has('--skip-unavailable')) {
        process.stdout.write(
          'test:integration skipped: Docker daemon unavailable; pnpm test:unit remains runnable\n',
        );
      } else {
        fail('test:funded blocked: Docker daemon unavailable');
      }
    } else if (mode === 'lifecycle-regtest') {
      const environment = { ...process.env, ...LIFECYCLE_REGTEST_ENV };
      let failed = false;
      const clean = spawnSync(
        'docker',
        ['compose', '-f', LIFECYCLE_REGTEST_COMPOSE, 'down', '--volumes', '--remove-orphans'],
        { stdio: 'inherit', env: environment, timeout: 120_000 },
      );
      if (clean.status !== 0) {
        fail('test:lifecycle:regtest could not clean the Compose stack');
        failed = true;
      }
      if (!failed) {
        const up = spawnSync(
          'docker',
          ['compose', '-f', LIFECYCLE_REGTEST_COMPOSE, 'up', '--build', '-d', '--wait'],
          { stdio: 'inherit', env: environment, timeout: 900_000 },
        );
        if (up.status !== 0) {
          fail('test:lifecycle:regtest could not start the Compose stack');
          failed = true;
        }
      }
      if (!failed) {
        const result = spawnSync(command, args, {
          stdio: 'inherit',
          env: { ...environment, CFL_WALLET_LIFECYCLE_REGTEST: '1' },
        });
        if (result.status !== 0) {
          process.exitCode = result.status ?? 1;
          failed = true;
        }
      }
      const down = spawnSync(
        'docker',
        ['compose', '-f', LIFECYCLE_REGTEST_COMPOSE, 'down', '--volumes', '--remove-orphans'],
        { stdio: 'inherit', env: environment, timeout: 120_000 },
      );
      if (down.status !== 0 && !failed) fail('test:lifecycle:regtest could not clean up Compose');
    } else if (mode === 'lifecycle-funded') {
      const environment = { ...process.env, ...LIFECYCLE_ENV };
      let failed = false;
      for (let pass = 1; pass <= 2 && !failed; pass += 1) {
        const clean = spawnSync(
          'docker',
          ['compose', '-f', LIFECYCLE_COMPOSE, 'down', '--volumes', '--remove-orphans'],
          { stdio: 'inherit', env: environment, timeout: 120_000 },
        );
        if (clean.status !== 0) {
          fail(`test:lifecycle:funded pass ${pass} could not clean the Compose stack`);
          failed = true;
          break;
        }
        const up = spawnSync(
          'docker',
          ['compose', '-f', LIFECYCLE_COMPOSE, 'up', '--build', '-d', '--wait'],
          { stdio: 'inherit', env: environment, timeout: 900_000 },
        );
        if (up.status !== 0) {
          fail(`test:lifecycle:funded pass ${pass} could not start the Compose stack`);
          failed = true;
          break;
        }
        const result = spawnSync(command, args, {
          stdio: 'inherit',
          env: { ...environment, CFL_WALLET_LIFECYCLE_E2E: '1' },
        });
        if (result.status !== 0) {
          process.exitCode = result.status ?? 1;
          failed = true;
        } else {
          process.stdout.write(`test:lifecycle:funded pass ${pass} passed\n`);
        }
      }
      const down = spawnSync(
        'docker',
        ['compose', '-f', LIFECYCLE_COMPOSE, 'down', '--volumes', '--remove-orphans'],
        { stdio: 'inherit', env: environment, timeout: 120_000 },
      );
      if (down.status !== 0 && !failed) fail('test:lifecycle:funded could not clean up Compose');
    } else if (mode === 'funded') {
      const missing = REQUIRED_FUNDED_ENV.filter((name) => !process.env[name]?.trim());
      if (missing.length > 0) {
        fail(`test:funded blocked: missing ${missing.join(', ')}`);
      } else {
        const result = spawnSync(command, args, {
          stdio: 'inherit',
          env: {
            ...process.env,
            CFL_NOSTR_RELAY_E2E: '1',
            CFL_FUNDED_CRASH_E2E: '1',
          },
        });
        process.exitCode = result.status ?? 1;
      }
    } else {
      const result = spawnSync(command, args, {
        stdio: 'inherit',
        env: { ...process.env, CFL_POSTGRES_E2E: '1' },
      });
      process.exitCode = result.status ?? 1;
    }
  }
}
