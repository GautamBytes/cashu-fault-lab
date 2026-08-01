#!/usr/bin/env node
import type { LifecycleCapabilities } from '@cashu-fault-lab/wallet-lifecycle-contract';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { buildFundedCashuTsAdapterServer } from './funded-server.js';
import { CashuTsLifecycleOperations } from './lifecycle/operations.js';
import {
  PostgresCashuTsLifecycleStore,
  migratePostgresCashuTsLifecycleStore,
} from './lifecycle/postgres-store.js';
import { CashuTsLifecycleWallet } from './lifecycle/wallet.js';
import { createPostgresCashuTsReceiverStore } from './postgres-receiver-store.js';
import { PostgresCrashCheckpoint, SigkillProcessTerminator } from './postgres-crash-checkpoint.js';
import { PostgresCrashArmStore, migratePostgresCrashArmStore } from './postgres-crash-arm-store.js';
import {
  createPostgresCashuTsSenderStore,
  parseCashuTsSenderStateKeys,
} from './postgres-sender-store.js';

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
const senderDatabaseUrl = process.env.CFL_CASHU_TS_SENDER_DATABASE_URL;
const mintUrl = required('CFL_CASHU_TS_MINT_URL');
const durableSender =
  senderDatabaseUrl === undefined || senderDatabaseUrl.length === 0
    ? undefined
    : await createPostgresCashuTsSenderStore({
        connectionString: senderDatabaseUrl,
        runId: required('CFL_CASHU_TS_SENDER_RUN_ID'),
        keyRing: parseCashuTsSenderStateKeys({
          activeKeyVersion: positiveInteger(
            process.env.CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION,
            0,
            'CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION',
          ),
          encodedKeys: required('CFL_CASHU_TS_SENDER_STATE_KEYS'),
        }),
        ...(process.env.CFL_CASHU_TS_SENDER_TENANT_ID === undefined
          ? {}
          : { tenantId: process.env.CFL_CASHU_TS_SENDER_TENANT_ID }),
      });
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
const crashControlsEnabled = process.env.CFL_CASHU_TS_TEST_CRASH_CONTROL === '1';
if (
  process.env.CFL_CASHU_TS_TEST_CRASH_CONTROL !== undefined &&
  process.env.CFL_CASHU_TS_TEST_CRASH_CONTROL !== '0' &&
  process.env.CFL_CASHU_TS_TEST_CRASH_CONTROL !== '1'
) {
  throw new Error('CFL_CASHU_TS_TEST_CRASH_CONTROL must be 0 or 1');
}
if (crashControlsEnabled && durableSender === undefined) {
  throw new Error('Crash controls require the durable PostgreSQL sender store');
}
const crashControl =
  crashControlsEnabled && durableSender !== undefined
    ? new PostgresCrashCheckpoint({
        store: new PostgresCrashArmStore({
          pool: durableSender.pool,
          tenantId: process.env.CFL_CASHU_TS_CRASH_TENANT_ID ?? 'cashu-ts-crash',
        }),
        terminator: new SigkillProcessTerminator(),
      })
    : undefined;
if (crashControlsEnabled && durableSender !== undefined) {
  await migratePostgresCrashArmStore(durableSender.pool);
  await crashControl?.initialize();
}
const lifecycleDatabaseUrl = process.env.CFL_CASHU_TS_LIFECYCLE_DATABASE_URL;
const lifecycleStateKey = optionalBase64UrlKey('CFL_CASHU_TS_LIFECYCLE_STATE_KEY');
if ((lifecycleDatabaseUrl === undefined) !== (lifecycleStateKey === undefined)) {
  throw new Error(
    'CFL_CASHU_TS_LIFECYCLE_DATABASE_URL and CFL_CASHU_TS_LIFECYCLE_STATE_KEY must be configured together',
  );
}
const lifecyclePool =
  lifecycleDatabaseUrl === undefined
    ? undefined
    : new Pool({ connectionString: lifecycleDatabaseUrl, max: 10 });
let lifecycle: CashuTsLifecycleOperations | undefined;
if (lifecyclePool !== undefined && lifecycleStateKey !== undefined) {
  await migratePostgresCashuTsLifecycleStore(lifecyclePool);
  const lifecycleStore = new PostgresCashuTsLifecycleStore({
    pool: lifecyclePool,
    key: lifecycleStateKey,
    runId: required('CFL_CASHU_TS_LIFECYCLE_RUN_ID'),
    tenantId: process.env.CFL_CASHU_TS_LIFECYCLE_TENANT_ID ?? 'cashu-ts-lifecycle',
  });
  const digest = (domain: string): string =>
    `sha256:${createHash('sha256').update(`cashu-fault-lab/${domain}/v1`).digest('hex')}`;
  const lifecycleCapabilities: LifecycleCapabilities = {
    schemaVersion: 1,
    implementation: {
      id: 'cashu-ts',
      version: '4.7.2',
      language: 'typescript',
      runtime: 'node-24',
      sourceDigest: digest('cashu-ts-lifecycle-source'),
      buildDigest: digest('cashu-ts-lifecycle-build'),
    },
    operations: ['mint'],
    nuts: [4, 13, 19],
    durability: 'restart_safe',
    recovery: ['nut13_seed', 'nut19_replay'],
    mints: [{ id: 'configured-mint', implementation: 'configured' }],
  };
  lifecycle = new CashuTsLifecycleOperations({
    store: lifecycleStore,
    wallet: new CashuTsLifecycleWallet({ mintUrl, unit: 'sat', store: lifecycleStore }),
    mint: mintUrl,
    unit: 'sat',
    capabilities: lifecycleCapabilities,
  });
}
const app = await buildFundedCashuTsAdapterServer({
  mintUrl,
  controlToken: required('CFL_CASHU_TS_CONTROL_TOKEN'),
  fundingAmount: positiveInteger(
    process.env.CFL_CASHU_TS_FUNDING_AMOUNT,
    64,
    'CFL_CASHU_TS_FUNDING_AMOUNT',
  ),
  ...(proofClaimKey === undefined ? {} : { proofClaimKey }),
  ...(paymentTarget === undefined ? {} : { paymentTarget }),
  ...(durableSender === undefined ? {} : { store: durableSender.store }),
  ...(durableReceiver === undefined ? {} : { receiverStore: durableReceiver.store }),
  ...(senderNostrPrivateKey === undefined ? {} : { senderNostrPrivateKey }),
  ...(receiverNostrPrivateKey === undefined ? {} : { receiverNostrPrivateKey }),
  ...(nostrRelayUrls === undefined ? {} : { nostrRelayUrls }),
  ...(crashControl === undefined ? {} : { crashControl }),
  ...(crashControl?.activeRunId() === undefined
    ? {}
    : { resumeRunId: crashControl.activeRunId()! }),
  ...(lifecycle === undefined ? {} : { lifecycle }),
});

const close = async (): Promise<void> => {
  await app.close();
  await durableSender?.pool.end();
  await durableReceiver?.pool.end();
  await lifecyclePool?.end();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await app.listen({ host, port });
