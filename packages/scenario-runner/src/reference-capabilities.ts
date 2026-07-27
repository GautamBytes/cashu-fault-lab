import {
  developmentIdentity,
  type AdapterCapabilities,
  type AdapterTransport,
} from '@cashu-fault-lab/adapter-contract';

export function referenceCapabilities(
  transports: readonly AdapterTransport[],
): Readonly<Record<string, unknown>> {
  const role = () =>
    ({
      transports: [...transports],
      profiles: ['delivery-v1'],
      durability: 'process',
      evidence: { tier: 'T0', sources: ['adapter', 'runner', 'transport'] },
    }) as const;
  const capabilities: AdapterCapabilities = {
    schemaVersion: 2,
    implementation: developmentIdentity({
      id: 'reference-ts',
      version: '0.0.0',
      language: 'typescript',
      runtime: 'node-24',
    }),
    // Keep role records structurally independent. The artifact redactor treats
    // repeated object identities as cycles, even when the data is acyclic.
    roles: { sender: role(), receiver: role() },
    nuts: [2, 3, 7, 9, 10, 12, 18, 19],
    encodings: ['creqA'],
    mints: [],
  };
  return {
    ...capabilities,
    componentVersions: { 'reference-ts': '0.0.0' },
  };
}
