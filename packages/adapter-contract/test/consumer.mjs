import { validateAdapterRequest, validateDeliveryPayload } from '@cashu-fault-lab/adapter-contract';

if (!validateAdapterRequest('reset', { seed: 'consumer-smoke' }).ok) {
  throw new Error('adapter request validation failed');
}

if (
  validateDeliveryPayload({
    id: 'AAECAwQFBgcICQoLDA0ODw',
    mint: 'https://mint.example',
    unit: 'sat',
    proofs: [],
    delivery: {
      v: 1,
      id: 'EBESExQVFhcYGRobHB0eHw',
      created_at: 1,
      expires_at: 2,
    },
  }).ok !== true
) {
  throw new Error('delivery payload validation failed');
}

console.log('adapter-contract consumer smoke test passed');
