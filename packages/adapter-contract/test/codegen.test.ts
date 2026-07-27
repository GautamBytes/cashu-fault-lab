import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  generatedAdapterContract,
  type AdapterCapabilities,
  validateAdapterResponse,
} from '../src/index.js';

function repoFile(path: string): string {
  return fileURLToPath(new URL(`../../../${path}`, import.meta.url));
}

describe('generated adapter contract artifacts', () => {
  it('publishes deterministic TypeScript models beside the curated wrappers', () => {
    const capabilities: generatedAdapterContract.AdapterCapabilities = {
      schemaVersion: 2,
      implementation: {
        id: 'generated-fixture',
        version: '1.0.0',
        language: 'typescript',
        runtime: 'node-24',
        sourceDigest: `sha256:${'ab'.repeat(32)}`,
        buildDigest: `sha256:${'cd'.repeat(32)}`,
      },
      roles: {
        sender: {
          transports: ['http'],
          profiles: ['delivery-v1'],
          durability: 'process',
          evidence: { tier: 'T0', sources: ['adapter'] },
        },
      },
      nuts: [18],
      encodings: ['creqA'],
      mints: [],
    };

    const maintained: AdapterCapabilities = capabilities;
    expect(validateAdapterResponse('capabilities', maintained)).toEqual({ ok: true });
    expect(generatedAdapterContract.generatedContract.generator).toBe('openapi-generator-cli');
    expect(generatedAdapterContract.generatedContract.targets).toEqual([
      'typescript-fetch',
      'rust',
      'python',
    ]);
  });

  it('commits Rust and Python generated package skeletons for consumers', async () => {
    await expect(
      readFile(repoFile('packages/adapter-contract/generated/rust/Cargo.toml'), 'utf8'),
    ).resolves.toContain('cashu_fault_lab_adapter_contract');
    await expect(
      readFile(
        repoFile(
          'packages/adapter-contract/generated/python/cashu_fault_lab_adapter_contract/__init__.py',
        ),
        'utf8',
      ),
    ).resolves.toContain('__openapi_generator_version__');
  });
});
