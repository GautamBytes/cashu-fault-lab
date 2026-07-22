#!/usr/bin/env node
import { buildFundedCashuTsAdapterServer } from './funded-server.js';
import { createPostgresCashuTsReceiverStore } from './postgres-receiver-store.js';

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

function optionalBase64UrlKey(name: string): Uint8Array | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || /=.*[^=]/u.test(value)) {
    throw new Error(`${name} must be base64url encoded`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes`);
  }
  return decoded;
}

function requiredBase64UrlKey(name: string): Uint8Array {
  const value = optionalBase64UrlKey(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function optionalCsv(name: string): readonly string[] | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0) return undefined;
  const values = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

const port = positiveInteger(process.env.CFL_CASHU_TS_PORT, 4101, 'CFL_CASHU_TS_PORT');
const host = listenHost(process.env.CFL_CASHU_TS_HOST);
const proofClaimKey = optionalBase64UrlKey('CFL_CASHU_TS_CLAIM_KEY');
const senderNostrPrivateKey = optionalBase64UrlKey('CFL_CASHU_TS_NOSTR_SENDER_KEY');
const receiverNostrPrivateKey = optionalBase64UrlKey('CFL_CASHU_TS_NOSTR_RECEIVER_KEY');
const nostrRelayUrls = optionalCsv('CFL_CASHU_TS_NOSTR_RELAYS');
const paymentTarget =
  proofClaimKey === undefined
    ? undefined
    : (process.env.CFL_CASHU_TS_PAYMENT_TARGET ?? `http://127.0.0.1:${port}/pay`);
const receiverDatabaseUrl = process.env.CFL_CASHU_TS_RECEIVER_DATABASE_URL;
const durableReceiver =
  receiverDatabaseUrl === undefined || receiverDatabaseUrl.length === 0
    ? undefined
    : await createPostgresCashuTsReceiverStore({
        connectionString: receiverDatabaseUrl,
        envelopeKey: requiredBase64UrlKey('CFL_CASHU_TS_RECEIVER_STATE_KEY'),
        ...(process.env.CFL_CASHU_TS_RECEIVER_TENANT_ID === undefined
          ? {}
          : { tenantId: process.env.CFL_CASHU_TS_RECEIVER_TENANT_ID }),
      });
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
  ...(durableReceiver === undefined ? {} : { receiverStore: durableReceiver.store }),
  ...(senderNostrPrivateKey === undefined ? {} : { senderNostrPrivateKey }),
  ...(receiverNostrPrivateKey === undefined ? {} : { receiverNostrPrivateKey }),
  ...(nostrRelayUrls === undefined ? {} : { nostrRelayUrls }),
});

const close = async (): Promise<void> => {
  await app.close();
  await durableReceiver?.pool.end();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await app.listen({ host, port });
