#!/usr/bin/env node
import { buildFundedCashuTsAdapterServer } from './funded-server.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function listenHost(value: string | undefined): string {
  const host = value ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('CFL_CASHU_TS_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

function optionalClaimKey(): Uint8Array | undefined {
  const value = process.env.CFL_CASHU_TS_CLAIM_KEY;
  if (value === undefined || value.length === 0) return undefined;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32) {
    throw new Error('CFL_CASHU_TS_CLAIM_KEY must decode to exactly 32 bytes');
  }
  return decoded;
}

const port = positiveInteger(process.env.CFL_CASHU_TS_PORT, 4101, 'CFL_CASHU_TS_PORT');
const host = listenHost(process.env.CFL_CASHU_TS_HOST);
const proofClaimKey = optionalClaimKey();
const paymentTarget =
  proofClaimKey === undefined
    ? undefined
    : (process.env.CFL_CASHU_TS_PAYMENT_TARGET ?? `http://127.0.0.1:${port}/pay`);
const app = await buildFundedCashuTsAdapterServer({
  mintUrl: required('CFL_CASHU_TS_MINT_URL'),
  controlToken: required('CFL_CASHU_TS_CONTROL_TOKEN'),
  fundingAmount: positiveInteger(
    process.env.CFL_CASHU_TS_FUNDING_AMOUNT,
    64,
    'CFL_CASHU_TS_FUNDING_AMOUNT',
  ),
  ...(proofClaimKey === undefined ? {} : { proofClaimKey }),
  ...(paymentTarget === undefined ? {} : { paymentTarget }),
});

const close = async (): Promise<void> => {
  await app.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await app.listen({ host, port });
