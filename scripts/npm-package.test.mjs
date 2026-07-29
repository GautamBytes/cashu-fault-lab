import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function manifest(path) {
  return JSON.parse(await readFile(new URL(path, root), 'utf8'));
}

test('the public npm package exposes only the bundled CLI and runtime assets', async () => {
  assert.equal(existsSync(new URL('apps/npm-cli/package.json', root)), true);
  const workspace = await manifest('package.json');
  const packageManifest = await manifest('apps/npm-cli/package.json');

  assert.equal(workspace.name, '@cashu-fault-lab/workspace');
  assert.equal(packageManifest.name, 'cashu-fault-lab');
  assert.equal(packageManifest.private, false);
  assert.deepEqual(packageManifest.bin, { 'cashu-fault-lab': './dist/bin.js' });
  assert.deepEqual(packageManifest.files, ['dist', 'runtime', 'README.md', 'LICENSE']);
  assert.deepEqual(packageManifest.dependencies, {});
});

test('the npm demo compose file pulls versioned runtime images instead of building the repository', async () => {
  const path = new URL('infra/compose/npm-runtime.compose.yml', root);
  assert.equal(existsSync(path), true);
  const compose = await readFile(path, 'utf8');

  assert.doesNotMatch(compose, /^\s*build:/mu);
  for (const image of [
    'ghcr.io/gautambytes/cashu-fault-lab-node-wallets:0.1.0',
    'ghcr.io/gautambytes/cashu-fault-lab-cdk-adapter:0.1.0',
    'ghcr.io/gautambytes/cashu-fault-lab-netns:0.1.0',
  ]) {
    assert.ok(compose.includes(image), `missing ${image}`);
  }
});

test('publishing is blocked until the runtime images support anonymous pulls', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish.yml', root), 'utf8');

  assert.match(workflow, /Verify public runtime images/u);
  assert.match(workflow, /docker manifest inspect/u);
  assert.match(workflow, /CFL_NPM_E2E_DEMO: '1'/u);
});
