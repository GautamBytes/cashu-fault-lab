#!/usr/bin/env node
import { buildFundedReceiverAdapterServer } from './funded-server.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65,535`);
  }
  return parsed;
}

function listenHost(value: string | undefined): string {
  const host = value ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('CFL_REFERENCE_RECEIVER_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

const port = positiveInteger(process.env.CFL_REFERENCE_RECEIVER_PORT, 4200, 'port');
const host = listenHost(process.env.CFL_REFERENCE_RECEIVER_HOST);
const proofClaimKey = Buffer.from(required('CFL_REFERENCE_RECEIVER_CLAIM_KEY'), 'base64url');
if (proofClaimKey.byteLength !== 32) {
  throw new Error('CFL_REFERENCE_RECEIVER_CLAIM_KEY must decode to exactly 32 bytes');
}
const app = await buildFundedReceiverAdapterServer({
  mintUrl: required('CFL_REFERENCE_RECEIVER_MINT_URL'),
  controlToken: required('CFL_REFERENCE_RECEIVER_CONTROL_TOKEN'),
  paymentTarget: process.env.CFL_REFERENCE_RECEIVER_PAYMENT_TARGET ?? `http://${host}:${port}/pay`,
  proofClaimKey,
});

const close = async (): Promise<void> => {
  await app.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await app.listen({ host, port });
