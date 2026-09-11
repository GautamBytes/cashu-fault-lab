import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
const compose = [
  'compose',
  '-p',
  `cashu-nip61-${randomUUID().slice(0, 8)}`,
  '-f',
  'infra/compose/nutshell.compose.yml',
];
const server = createServer();
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const env = {
  ...process.env,
  CFL_NUTSHELL_PORT: String(port),
  CFL_NUTZAP_MINT_URL: `http://127.0.0.1:${port}`,
};
async function run(command, args, timeout = 180000) {
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
let started = false;
try {
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], 10000);
  started = true;
  await run('docker', [...compose, 'up', '-d', '--wait'], 300000);
  await run('pnpm', ['exec', 'turbo', 'run', 'build', '--filter=@cashu-fault-lab/nutzap-recovery']);
  await run('pnpm', [
    '--filter',
    '@cashu-fault-lab/nutzap-recovery',
    'exec',
    'vitest',
    'run',
    'test/nutzap-funded.test.ts',
  ]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (started)
    try {
      await run('docker', [...compose, 'down', '--volumes', '--remove-orphans']);
    } catch {
      console.error('Nutzap test stack cleanup failed');
      process.exitCode = 1;
    }
}
