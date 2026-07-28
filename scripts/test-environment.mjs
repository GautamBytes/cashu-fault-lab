import { spawnSync } from 'node:child_process';

const REQUIRED_FUNDED_ENV = [
  'CFL_REAL_MINT_URL',
  'CFL_CASHU_TS_TOKEN',
  'CFL_CDK_TOKEN',
  'CFL_REFERENCE_RECEIVER_TOKEN',
  'CFL_REFERENCE_RECEIVER_CLAIM_KEY',
  'CFL_HTTP_FAULT_GATEWAY_TOKEN',
];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const separator = process.argv.indexOf('--');
if (separator < 3 || separator === process.argv.length - 1) {
  fail(
    'usage: node scripts/test-environment.mjs <docker|funded> [--skip-unavailable] -- <command> [args...]',
  );
} else {
  const mode = process.argv[2];
  const options = new Set(process.argv.slice(3, separator));
  const command = process.argv[separator + 1];
  const args = process.argv.slice(separator + 2);
  if (mode !== 'docker' && mode !== 'funded') {
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
