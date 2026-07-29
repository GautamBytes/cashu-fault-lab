import { readFileSync } from 'node:fs';
import { specAssetPath } from './spec-assets.js';

export type JsonSchema = Readonly<Record<string, unknown>>;

function loadSchema(name: string): JsonSchema {
  const path = specAssetPath('schemas', name);
  return JSON.parse(readFileSync(path, 'utf8')) as JsonSchema;
}

export const deliveryRequestSchema = loadSchema('delivery-request.schema.json');
export const deliveryPayloadSchema = loadSchema('delivery-payload.schema.json');
export const deliveryReceiptSchema = loadSchema('delivery-receipt.schema.json');
export const adapterCapabilitiesSchema = loadSchema('adapter-capabilities.schema.json');
export const scenarioResultSchema = loadSchema('scenario-result.schema.json');
export const scenarioSpecSchema = loadSchema('scenario-spec.schema.json');
export const releasePolicySchema = loadSchema('release-policy.schema.json');
export const releaseSuiteSchema = loadSchema('release-suite.schema.json');
export const crashControlSchema = loadSchema('crash-control.schema.json');
