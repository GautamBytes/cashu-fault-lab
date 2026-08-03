import { developmentIdentity, type AdapterCapabilities } from '@cashu-fault-lab/adapter-contract';
import type { MatrixCaseResult } from '@cashu-fault-lab/scenario-runner';
import { describe, expect, it } from 'vitest';
import type { AdapterPreflightReport } from '../src/adapter-preflight.js';
import {
  createAdapterPreviewArtifacts,
  validateLocalFaultGateway,
} from '../src/adapter-preview.js';

const capability: AdapterCapabilities = {
  schemaVersion: 2,
  implementation: developmentIdentity({
    id: 'my-wallet',
    version: '0.1.0',
    language: 'typescript',
    runtime: 'node-24',
  }),
  roles: {
    sender: {
      transports: ['http'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T1', sources: ['adapter'] },
    },
    receiver: {
      transports: ['http'],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T1', sources: ['adapter'] },
    },
  },
  nuts: [18],
  encodings: ['creqA'],
  mints: [],
};

const preflight: AdapterPreflightReport = {
  schemaVersion: 1,
  ok: true,
  profile: 'delivery-v1',
  adapters: [
    {
      id: 'my-wallet',
      url: 'http://127.0.0.1:4100',
      implementation: capability.implementation,
      capabilities: capability,
    },
  ],
  checks: [
    {
      adapterId: 'my-wallet',
      stage: 'connectivity',
      status: 'passed',
      code: 'ADAPTER_REACHABLE',
      message: 'Adapter is reachable.',
    },
  ],
};

const result: MatrixCaseResult = {
  profile: 'delivery-v1',
  sender: 'my-wallet',
  receiver: 'my-wallet',
  status: 'passed',
  senderCapabilities: capability,
  receiverCapabilities: capability,
  invariants: [],
  mints: [],
  scenarios: [
    {
      id: 'retry-response-lost',
      seed: 'scenario-seed',
      status: 'passed',
      requiredInvariants: ['retry-convergence'],
      invariants: [
        {
          id: 'retry-convergence',
          status: 'passed',
          confidence: 'adapter_claimed',
          evidence: [{ source: 'receipt', description: 'Retry converged.' }],
        },
      ],
    },
  ],
  releaseSuiteDigest: `sha256:${'ab'.repeat(32)}`,
};

describe('maintainer preview artifacts', () => {
  it('requires an authenticated loopback HTTP fault gateway', () => {
    expect(() => validateLocalFaultGateway({})).toThrowError(/FAULT_GATEWAY_REQUIRED/u);
    expect(() =>
      validateLocalFaultGateway({
        CFL_HTTP_FAULT_GATEWAY_URL: 'https://wallet.example/faults',
        CFL_HTTP_FAULT_GATEWAY_TOKEN: 'secret-token',
      }),
    ).toThrowError(/FAULT_GATEWAY_NOT_LOOPBACK/u);

    expect(
      validateLocalFaultGateway({
        CFL_HTTP_FAULT_GATEWAY_URL: 'http://127.0.0.1:4300',
        CFL_HTTP_FAULT_GATEWAY_TOKEN: 'secret-token',
      }),
    ).toEqual({
      url: 'http://127.0.0.1:4300',
      token: 'secret-token',
    });
  });

  it('renders a shareable non-qualifying result set with exact rerun commands', () => {
    const artifacts = createAdapterPreviewArtifacts({
      profile: 'delivery-v1',
      seed: 'preview-seed',
      sender: 'my-wallet',
      receiver: 'my-wallet',
      preflight,
      manifestPath: 'fixtures/custom manifest.json',
      result,
      cliVersion: '0.1.4',
      runtime: {
        node: 'v24.18.1',
        platform: 'darwin',
        architecture: 'arm64',
      },
      scenarios: [
        {
          id: 'retry-response-lost',
          path: 'scenarios/retry/response-lost.json',
          seed: 'scenario-seed',
        },
      ],
    });

    expect([...artifacts.keys()].sort()).toEqual([
      'README.txt',
      'preflight.json',
      'preview.html',
      'preview.json',
      'preview.junit.xml',
    ]);
    const preview = JSON.parse(artifacts.get('preview.json') ?? '{}');
    expect(preview).toMatchObject({
      schemaVersion: 1,
      kind: 'cashu-fault-lab-maintainer-preview',
      qualification: false,
      cliVersion: '0.1.4',
      runtime: { node: 'v24.18.1', platform: 'darwin', architecture: 'arm64' },
      matrix: { summary: { passed: 1, total: 1 } },
    });
    expect(artifacts.get('preview.html')).toContain('<!doctype html>');
    expect(artifacts.get('preview.html')).toContain('not release qualification');
    expect(artifacts.get('preview.junit.xml')).toContain('<testsuite');
    expect(artifacts.get('README.txt')).toContain(
      'cashu-fault-lab run scenarios/retry/response-lost.json --seed scenario-seed',
    );
    expect(artifacts.get('README.txt')).toContain("--adapters 'fixtures/custom manifest.json'");
    expect(preview.rerun[0].command).toContain("--adapters 'fixtures/custom manifest.json'");
    expect([...artifacts.values()].join('\n')).not.toContain('Bearer');
  });
});
