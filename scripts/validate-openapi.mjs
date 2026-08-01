import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

async function text(path) {
  return readFile(resolve(root, path), 'utf8');
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const openapi = await text('spec/openapi.yaml');
const lifecycleOpenapi = await text('spec/lifecycle-openapi.yaml');
const capabilitiesSchema = JSON.parse(await text('spec/schemas/adapter-capabilities.schema.json'));
const lifecycleCapabilitiesSchema = JSON.parse(
  await text('spec/schemas/lifecycle-capabilities.schema.json'),
);

if (!/^openapi:\s*['"]?3\.1\.0['"]?/m.test(openapi)) {
  fail('spec/openapi.yaml must declare OpenAPI 3.1.0');
}

if (!/^openapi:\s*['"]?3\.1\.0['"]?/m.test(lifecycleOpenapi)) {
  fail('spec/lifecycle-openapi.yaml must declare OpenAPI 3.1.0');
}

for (const operationId of [
  'getLifecycleCapabilities',
  'resetLifecycleWallet',
  'startLifecycleOperation',
  'resumeLifecycleOperation',
  'getLifecycleOperation',
  'getLifecycleWallet',
  'getLifecycleEvidence',
]) {
  if (!new RegExp(`operationId:\\s*${operationId}\\b`).test(lifecycleOpenapi)) {
    fail(`spec/lifecycle-openapi.yaml is missing operationId ${operationId}`);
  }
}

const lifecycleOperationIds = [...lifecycleOpenapi.matchAll(/operationId:\s*([A-Za-z0-9_]+)/g)].map(
  (match) => match[1],
);
if (new Set(lifecycleOperationIds).size !== lifecycleOperationIds.length) {
  fail('spec/lifecycle-openapi.yaml contains duplicate operationId values');
}

if (lifecycleCapabilitiesSchema.properties?.schemaVersion?.const !== 1) {
  fail('lifecycle-capabilities schema must use schemaVersion const 1');
}

const requiredOperations = [
  'getCapabilities',
  'reset',
  'createRequest',
  'sendPayment',
  'getDeliveryReceipt',
  'getLedger',
  'getProofs',
];

for (const operationId of requiredOperations) {
  if (!new RegExp(`operationId:\\s*${operationId}\\b`).test(openapi)) {
    fail(`spec/openapi.yaml is missing operationId ${operationId}`);
  }
}

const operationIds = [...openapi.matchAll(/operationId:\s*([A-Za-z0-9_]+)/g)].map(
  (match) => match[1],
);
if (new Set(operationIds).size !== operationIds.length) {
  fail('spec/openapi.yaml contains duplicate operationId values');
}

const schemaNames = [...openapi.matchAll(/^    ([A-Za-z0-9_]+):\n/gm)].map((match) => match[1]);
const schemaSet = new Set(schemaNames);
for (const ref of openapi.matchAll(/\$ref:\s*['"]#\/components\/schemas\/([^'"]+)['"]/g)) {
  if (!schemaSet.has(ref[1])) fail(`OpenAPI component ref is missing schema ${ref[1]}`);
}

if (capabilitiesSchema.properties?.schemaVersion?.const !== 2) {
  fail('adapter-capabilities schema must use schemaVersion const 2');
}

const batch = await text('spec/codegen/batch.yaml');
for (const config of [
  'spec/codegen/config.typescript.json',
  'spec/codegen/config.rust.json',
  'spec/codegen/config.python.json',
]) {
  if (!batch.includes(config)) fail(`spec/codegen/batch.yaml is missing ${config}`);
  const parsed = JSON.parse(await text(config));
  if (parsed.inputSpec !== 'spec/openapi.yaml') {
    fail(`${config} must use spec/openapi.yaml as inputSpec`);
  }
}
