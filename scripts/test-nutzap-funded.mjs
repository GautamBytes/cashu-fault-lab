import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const mints = [
  {
    name: 'nutshell',
    compose: 'infra/compose/nutshell.compose.yml',
    port: 'CFL_NUTSHELL_PORT',
    version: 'Nutshell/0.20.2',
  },
  {
    name: 'mintd',
    compose: 'infra/compose/cdk-mint.compose.yml',
    port: 'CFL_CDK_MINT_PORT',
    version: 'cdk-mintd/0.17.3',
  },
];
const args = process.argv.slice(2);
if (
  args.length &&
  (args.length !== 2 || args[0] !== '--mint' || !mints.some((m) => m.name === args[1]))
) {
  console.error('Usage: pnpm test:nutzap:funded [--mint nutshell|mintd]');
  process.exit(1);
}
const selected = args.length ? mints.filter((m) => m.name === args[1]) : mints;
const runId = randomUUID();
const baseEnv = {
  ...process.env,
  CFL_NUTZAP_CDK_RECEIVER:
    process.env.CFL_NUTZAP_CDK_RECEIVER ??
    resolve(process.env.CARGO_TARGET_DIR ?? 'adapters/cdk/target', 'debug/cdk-nutzap-receiver'),
};
async function run(command, args, env = baseEnv, timeout = 180000) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(Error(`${command} failed (${code})`));
    });
  });
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
try {
  if (!process.env.CFL_NUTZAP_CDK_RECEIVER)
    await run(
      'cargo',
      [
        'build',
        '--locked',
        '--manifest-path',
        'adapters/cdk/Cargo.toml',
        '--bin',
        'cdk-nutzap-receiver',
      ],
      baseEnv,
      600000,
    );
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], baseEnv, 10000);
  await run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@cashu-fault-lab/nutzap-recovery']);
  for (const mint of selected) {
    const port = await freePort();
    const reports = resolve('artifacts/nutzap-funded', runId, mint.name);
    const env = {
      ...baseEnv,
      [mint.port]: String(port),
      CFL_NUTZAP_MINT_URL: `http://127.0.0.1:${port}`,
      CFL_NUTZAP_EXPECTED_MINT: mint.version,
      CFL_NUTZAP_REPORT_DIR: reports,
    };
    const compose = [
      'compose',
      '-p',
      `cashu-nip61-${mint.name}-${runId.slice(0, 8)}`,
      '-f',
      mint.compose,
    ];
    await mkdir(reports, { recursive: true, mode: 0o700 });
    console.log(`NIP-61 funded lane: ${mint.version}`);
    try {
      await run('docker', [...compose, 'up', '-d', '--wait'], env, 300000);
      await run(
        'pnpm',
        [
          '--filter',
          '@cashu-fault-lab/nutzap-recovery',
          'exec',
          'vitest',
          'run',
          'test/nutzap-funded.test.ts',
        ],
        env,
      );
      await run('pnpm', ['test:npm-package'], env);
      console.log(`NIP-61 ${mint.name} reports: ${reports}`);
    } finally {
      await run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], env);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
