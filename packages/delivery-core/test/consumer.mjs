import assert from 'node:assert/strict';

import {
  computePayloadHash,
  generateProtocolId,
  normalizeMintUrl,
  parseDeliveryReceipt,
} from '../dist/index.js';

const requestId = generateProtocolId(() =>
  Uint8Array.from({ length: 16 }, (_, index) => index),
);
const deliveryId = generateProtocolId(() =>
  Uint8Array.from({ length: 16 }, (_, index) => 255 - index),
);
const mint = normalizeMintUrl('https://MINT.EXAMPLE/');
const payloadHash = computePayloadHash({
  requestId,
  memo: null,
  mint,
  unit: 'sat',
  proofs: [],
  createdAt: 1_720_000_000,
  expiresAt: 1_720_000_060,
});

const receipt = parseDeliveryReceipt({
  profile: 'cashu-delivery-v1',
  request_id: requestId,
  delivery_id: deliveryId,
  payload_hash: payloadHash,
  status: 'settled',
  status_version: 2,
  mint,
  unit: 'sat',
  amount: 0,
  detail_code: 'settled',
});

assert.equal(mint, 'https://mint.example');
assert.equal(payloadHash.length, 64);
assert.equal(receipt.status, 'settled');

console.log('delivery-core consumer smoke test passed');
