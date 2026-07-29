import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { specAssetPath } from './spec-assets.js';
import type {
  AdapterCapabilities,
  AdapterCompatibilityResult,
  AdapterContractMetadata,
} from './types.js';

const SUPPORTED_API_VERSION = 1;
const SUPPORTED_SCHEMA_VERSION = 2;

let cached: AdapterContractMetadata | undefined;

function specDigest(): string {
  const path = specAssetPath('openapi.yaml');
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

export function currentAdapterContract(): AdapterContractMetadata {
  cached ??= {
    apiVersion: SUPPORTED_API_VERSION,
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    specDigest: specDigest(),
  };
  return cached;
}

export function validateAdapterCompatibility(
  capabilities: Readonly<Partial<AdapterCapabilities>>,
  expected: AdapterContractMetadata = currentAdapterContract(),
): AdapterCompatibilityResult {
  const actual = capabilities.contract;
  if (actual === undefined) {
    return {
      ok: true,
      warnings: [
        {
          code: 'ADAPTER_CONTRACT_LEGACY',
          message: 'Adapter capabilities do not include contract metadata.',
          remediation:
            'Accepting temporarily; regenerate the adapter/client from spec/openapi.yaml.',
        },
      ],
    };
  }
  if (actual.apiVersion !== expected.apiVersion) {
    return {
      ok: false,
      code: 'ADAPTER_CONTRACT_INCOMPATIBLE',
      reason: `Adapter contract apiVersion ${actual.apiVersion} is not supported by this lab (expected ${expected.apiVersion}).`,
      expected,
      actual,
    };
  }
  if (actual.schemaVersion !== expected.schemaVersion) {
    return {
      ok: false,
      code: 'ADAPTER_CONTRACT_INCOMPATIBLE',
      reason: `Adapter contract schemaVersion ${actual.schemaVersion} is not supported by this lab (expected ${expected.schemaVersion}).`,
      expected,
      actual,
    };
  }
  if (actual.specDigest !== expected.specDigest) {
    return {
      ok: false,
      code: 'ADAPTER_CONTRACT_INCOMPATIBLE',
      reason:
        'Adapter contract specDigest does not match this lab checkout; adapter/client regeneration is required.',
      expected,
      actual,
    };
  }
  return { ok: true, metadata: actual, warnings: [] };
}
