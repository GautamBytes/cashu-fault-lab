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
  assert.equal(packageManifest.version, '0.1.1');
  assert.equal(packageManifest.private, false);
  assert.deepEqual(packageManifest.bin, { 'cashu-fault-lab': 'dist/bin.js' });
  assert.deepEqual(packageManifest.files, ['dist', 'runtime', 'README.md', 'LICENSE']);
  assert.deepEqual(packageManifest.dependencies, {});
});

test('the npm demo compose file pulls versioned runtime images instead of building the repository', async () => {
  const path = new URL('infra/compose/npm-runtime.compose.yml', root);
  assert.equal(existsSync(path), true);
  const compose = await readFile(path, 'utf8');
  const packageManifest = await manifest('apps/npm-cli/package.json');

  assert.doesNotMatch(compose, /^\s*build:/mu);
  assert.doesNotMatch(
    compose,
    new RegExp(`:${packageManifest.version.replaceAll('.', '\\.')}`, 'u'),
  );
  assert.match(compose, /__CFL_PACKAGE_VERSION__/u);
  for (const image of [
    'ghcr.io/gautambytes/cashu-fault-lab-node-wallets',
    'ghcr.io/gautambytes/cashu-fault-lab-cdk-adapter',
    'ghcr.io/gautambytes/cashu-fault-lab-netns',
  ]) {
    assert.ok(compose.includes(image), `missing ${image}`);
  }
  assert.match(compose, /postgres:18-alpine@sha256:[a-f0-9]{64}/u);
});

test('the npm bundle omits source maps and preserves legal notices', async () => {
  const buildScript = await readFile(new URL('apps/npm-cli/scripts/build.mjs', root), 'utf8');

  assert.match(buildScript, /sourcemap: false/u);
  assert.match(buildScript, /legalComments: 'eof'/u);
});

test('publishing is blocked until the runtime images support anonymous pulls', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish.yml', root), 'utf8');

  assert.match(workflow, /Verify public runtime images/u);
  assert.match(workflow, /docker manifest inspect/u);
  assert.match(workflow, /CFL_NPM_E2E_DEMO: '1'/u);
});

test('the npm README stays concise and sends developers to the full website', async () => {
  const readme = await readFile(new URL('apps/npm-cli/README.md', root), 'utf8');
  const words = readme.trim().split(/\s+/u);

  assert.ok(words.length <= 220, `npm README should stay under 220 words; found ${words.length}`);
  assert.match(readme, /npx cashu-fault-lab doctor/u);
  assert.match(readme, /npx cashu-fault-lab demo/u);
  assert.match(readme, /https:\/\/cashu-fault-lab\.vercel\.app\//u);
  assert.match(readme, /experimental developer preview/iu);
  assert.match(readme, /not a certification/iu);
});

test('successful npm publication creates one idempotent GitHub Release', async () => {
  const workflow = await readFile(new URL('.github/workflows/publish.yml', root), 'utf8');

  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/u);
  assert.match(workflow, /^\s{2}github-release:/mu);
  assert.match(workflow, /needs: npm/u);
  assert.match(workflow, /contents: write/u);
  assert.match(workflow, /gh release view "\$\{GITHUB_REF_NAME\}"/u);
  assert.match(workflow, /gh release create "\$\{GITHUB_REF_NAME\}"/u);
  assert.match(workflow, /--verify-tag/u);
  assert.match(workflow, /--notes-file "\$\{notes\}"/u);
});

test('the package-only patch has concise release notes', async () => {
  const notes = await readFile(new URL('docs/releases/v0.1.1.md', root), 'utf8');
  const words = notes.trim().split(/\s+/u);

  assert.ok(words.length <= 180, `v0.1.1 notes should stay under 180 words; found ${words.length}`);
  assert.match(notes, /npm 12/iu);
  assert.match(notes, /npx cashu-fault-lab demo/u);
});

test('pull request CI runs the installed npm tarball through the real Docker demo', async () => {
  const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');

  assert.match(workflow, /CFL_NPM_E2E_DEMO: '1'/u);
  assert.match(workflow, /cashu-fault-lab-node-wallets/u);
  assert.match(workflow, /cashu-fault-lab-cdk-adapter/u);
  assert.match(workflow, /cashu-fault-lab-netns/u);
});
