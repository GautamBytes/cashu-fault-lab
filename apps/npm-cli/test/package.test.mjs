import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = new URL('../', import.meta.url);

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), ...args],
      {
        cwd: new URL('../', import.meta.url),
        env: process.env,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test('the bundled executable and runtime assets exist', async () => {
  await Promise.all([
    access(new URL('dist/bin.js', packageRoot)),
    access(new URL('runtime/scenarios/retry/response-lost.json', packageRoot)),
    access(new URL('runtime/spec/maintainer-preview-suite.json', packageRoot)),
    access(new URL('runtime/compose/wallet-adapters.compose.yml', packageRoot)),
  ]);
  const compose = await readFile(
    new URL('runtime/compose/wallet-adapters.compose.yml', packageRoot),
    'utf8',
  );
  assert.doesNotMatch(compose, /^\s*build:/mu);
});

test('the generated runtime uses the npm package version for every lab image', async () => {
  const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
  const compose = await readFile(
    new URL('runtime/compose/wallet-adapters.compose.yml', packageRoot),
    'utf8',
  );

  for (const image of [
    'cashu-fault-lab-node-wallets',
    'cashu-fault-lab-cdk-adapter',
    'cashu-fault-lab-netns',
  ]) {
    assert.match(compose, new RegExp(`${image}:${manifest.version.replaceAll('.', '\\.')}`, 'u'));
  }
  assert.doesNotMatch(compose, /__CFL_PACKAGE_VERSION__/u);
});

test('the bundled CLI resolves its package-owned scenarios', async () => {
  const listed = await run(['ls', '--json']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  const scenarios = JSON.parse(listed.stdout);
  assert.ok(scenarios.some(({ path }) => path === 'retry/response-lost.json'));

  const validated = await run(['validate', 'retry/response-lost']);
  assert.equal(validated.exitCode, 0, validated.stderr);
  assert.match(validated.stdout, /^ok http-response-lost/u);
});
