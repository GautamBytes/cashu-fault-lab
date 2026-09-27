import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = join(root, 'adapters/cdk/target/debug/cdk-payment-request');
const cli = join(root, 'apps/lab-cli/dist/bin.js');
function run(codec, ...args) {
  return spawnSync(
    process.execPath,
    [cli, 'payment-request', 'matrix', '--cdk-codec', codec, ...args],
    {
      cwd: tmpdir(),
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
}

test('native cross-language matrix is deterministic and strict mode exposes SDK gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cashu-codecs-'));
  try {
    const path = join(directory, 'report.json');
    const first = run(binary, '--output', path);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(await readFile(path, 'utf8'), first.stdout);
    const report = JSON.parse(first.stdout);
    assert.equal(report.profile, 'nut26-bech32m-v1');
    assert.equal(report.regressionGate, 'passed');
    assert.equal(report.conformance, 'incomplete');
    assert.equal(report.vectors, 26);
    assert.equal(report.results.length, 108);
    assert.equal(report.results.filter((r) => r.status === 'known_gap').length, 20);
    assert.equal(
      report.results.some((r) => r.status === 'failed'),
      false,
    );
    const strict = run(binary, '--strict');
    assert.equal(strict.status, 1, strict.stderr);
    assert.equal(strict.stdout, first.stdout);
    const manifest = JSON.parse(await readFile(join(root, 'apps/lab-cli/package.json'), 'utf8'));
    assert.equal(report.implementations['cashu-ts'], manifest.dependencies['@cashu/cashu-ts']);
    assert.match(
      await readFile(join(root, 'adapters/cdk/Cargo.toml'), 'utf8'),
      new RegExp(`cdk = \\{ version = "=${report.implementations.cdk.replaceAll('.', '\\.')}"`),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native failures and dishonest rejection cannot turn the matrix green', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cashu-codec-canary-'));
  try {
    assert.equal(run(join(directory, 'missing')).status, 2);
    const fake = join(directory, 'codec');
    for (const [source, status] of [
      ['console.log(JSON.stringify({accepted:false}))', 1],
      ['console.log("invalid-json")', 2],
      ['process.stdout.write("x".repeat(70000))', 2],
      ['process.exit(1)', 2],
    ]) {
      await writeFile(
        fake,
        `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end',()=>{${source}});\n`,
      );
      await chmod(fake, 0o700);
      const result = run(fake);
      assert.equal(result.status, status, result.stderr);
      if (status === 1) assert.equal(JSON.parse(result.stdout).regressionGate, 'failed');
    }
    const oversized = spawnSync(binary, [], {
      input: 'x'.repeat(65537),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(oversized.status, 0);
    assert.equal(oversized.stdout, '');
    const invalid = spawnSync(binary, [], { input: '{}', encoding: 'utf8', timeout: 5000 });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
