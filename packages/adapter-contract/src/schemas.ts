import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type JsonSchema = Readonly<Record<string, unknown>>;

function loadSchema(name: string): JsonSchema {
  const path = fileURLToPath(new URL(`../../../spec/schemas/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as JsonSchema;
}

export const deliveryRequestSchema = loadSchema('delivery-request.schema.json');
export const deliveryPayloadSchema = loadSchema('delivery-payload.schema.json');
export const deliveryReceiptSchema = loadSchema('delivery-receipt.schema.json');
export const adapterCapabilitiesSchema = loadSchema('adapter-capabilities.schema.json');
export const scenarioResultSchema = loadSchema('scenario-result.schema.json');
export const scenarioSpecSchema = loadSchema('scenario-spec.schema.json');
