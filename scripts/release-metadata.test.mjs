import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const workspacePackages = [
  'package.json',
  'adapters/cashu-ts/package.json',
  'adapters/template/package.json',
  'apps/http-fault-gateway/package.json',
  'apps/lab-cli/package.json',
  'apps/nostr-fault-relay/package.json',
  'apps/reference-receiver/package.json',
  'apps/reference-sender/package.json',
  'packages/adapter-contract/package.json',
  'packages/delivery-core/package.json',
  'packages/nostr-delivery/package.json',
  'packages/oracle/package.json',
  'packages/report/package.json',
  'packages/scenario-runner/package.json',
];
const releaseVersion = '0.1.0';
const demoSeed = 'cashu-fault-lab-v0.1.0-demo';
const demoCommand =
  `pnpm lab demo --seed ${demoSeed} ` +
  '--artifact docs/examples/v0.1.0-demo.json --report docs/examples/v0.1.0-demo.html';

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('workspace and Rust adapter versions identify the v0.1 developer preview', async () => {
  for (const path of workspacePackages) {
    const manifest = JSON.parse(await text(path));
    assert.equal(manifest.version, releaseVersion, `${path} version`);
  }
  assert.match(await text('adapters/cdk/Cargo.toml'), /^version = "0\.1\.0"$/mu);
  assert.match(
    await text('adapters/cdk/Cargo.lock'),
    /name = "cashu-fault-lab-cdk-adapter"\nversion = "0\.1\.0"/u,
  );
  assert.equal(JSON.parse(await text('apps/npm-cli/package.json')).version, '0.1.2');
});

test('release docs make the preview, demo, and certification boundary explicit', async () => {
  const readme = await text('README.md');
  const notes = await text('docs/releases/v0.1.0.md');
  const checklist = await text('docs/releases/v0.1.0-checklist.md');

  for (const contents of [readme, notes]) {
    assert.match(contents, /experimental v0\.1 developer preview/iu);
    assert.match(contents, /not (?:a )?certification/iu);
    assert.ok(contents.includes(demoCommand), 'release docs must include the deterministic demo');
  }
  assert.match(checklist, /- \[ \].*independent wallet receiver/iu);
  assert.match(checklist, /- \[ \].*external endorsement/iu);
  assert.match(checklist, /- \[ \].*distinct mint identit/iu);
});

test('v0.1.2 maintainer documentation stays aligned with the shipped adapter workflow', async () => {
  const readme = await text('README.md');
  const contributing = await text('CONTRIBUTING.md');
  const adapterGuide = await text('docs/adapter-guide.md');
  const deliveryProfile = await text('spec/delivery-v1.md');
  const threatModel = await text('spec/threat-model.md');
  const checklist = await text('docs/releases/v0.1.2-checklist.md');

  assert.match(readme, /\[v0\.1\.2 release notes\]\(docs\/releases\/v0\.1\.2\.md\)/u);
  assert.match(readme, /npx cashu-fault-lab@0\.1\.2 adapter init/u);
  assert.match(readme, /npx cashu-fault-lab@0\.1\.2 adapter preflight/u);
  assert.match(readme, /npx cashu-fault-lab@0\.1\.2 adapter preview/u);

  assert.match(contributing, /npx cashu-fault-lab@0\.1\.2 adapter init/u);
  assert.match(contributing, /Implement the 8 HTTP routes/u);
  assert.match(contributing, /adapter preflight/u);
  assert.match(contributing, /adapter preview/u);

  assert.match(adapterGuide, /Version 0\.1\.2 accepts these routes only on loopback origins/iu);
  assert.match(deliveryProfile, /GET \/v1\/redemptions/u);
  assert.match(deliveryProfile, /cumulative redemption-start count/iu);

  assert.doesNotMatch(
    threatModel,
    /Full named process restarts,[\s\S]*real Nostr relay remain release-gated/iu,
  );
  assert.match(threatModel, /internal evidence, not independent release qualification/iu);

  assert.match(checklist, /^# v0\.1\.2 maintainer-preview checklist$/mu);
  assert.match(checklist, /- \[x\].*adapter preflight/iu);
  assert.match(checklist, /- \[x\].*adapter preview/iu);
  assert.match(checklist, /- \[ \].*independent wallet receiver/iu);
});

test('checked-in demo artifacts are valid, deterministic, and secret-free', async () => {
  const json = await text('docs/examples/v0.1.0-demo.json');
  const html = await text('docs/examples/v0.1.0-demo.html');
  const artifact = JSON.parse(json);

  assert.equal(artifact.seed, demoSeed);
  assert.equal(artifact.status, 'passed');
  assert.ok(!json.includes('"0.0.0"'), 'JSON demo contains placeholder component versions');
  assert.ok(
    !html.includes('&quot;0.0.0&quot;'),
    'HTML demo contains placeholder component versions',
  );
  assert.match(html, new RegExp(demoSeed, 'u'));
  for (const secret of [
    'lab-only-cashu-ts-token',
    'lab-only-cdk-token',
    'lab-only-receiver-token',
    'lab-only-fault-token',
    'proof-secret',
  ]) {
    assert.ok(!json.includes(secret), `JSON demo leaks ${secret}`);
    assert.ok(!html.includes(secret), `HTML demo leaks ${secret}`);
  }
});

test('runtime metadata and coverage claims match the v0.1 preview', async () => {
  for (const path of [
    'apps/lab-cli/src/index.ts',
    'apps/lab-cli/src/packaged-runtime.ts',
    'apps/reference-receiver/src/funded-adapter.ts',
    'packages/scenario-runner/src/reference-capabilities.ts',
    'packages/scenario-runner/src/reference-probe.ts',
  ]) {
    assert.ok(!(await text(path)).includes("'0.0.0'"), `${path} contains a placeholder version`);
  }
  assert.doesNotMatch(
    await text('README.md'),
    /Receiver persistence and recovery[^\n]*Every named process-crash boundary/iu,
  );
});
