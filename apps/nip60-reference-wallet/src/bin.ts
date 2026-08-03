#!/usr/bin/env node
import { CashuTsMintWallet } from './cashu-wallet.js';
import { publishLabEvent } from './publish.js';
import { createFixtureServer } from './server.js';

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
    throw new Error('CFL_NIP60_FIXTURE_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const mint = required('CFL_NIP60_FIXTURE_MINT');
const publicMintEnv = process.env.CFL_NIP60_FIXTURE_PUBLIC_MINT;
const publicMint =
  publicMintEnv === undefined || publicMintEnv.trim() === '' ? mint : publicMintEnv.trim();
const relays = required('CFL_NIP60_FIXTURE_RELAYS')
  .split(',')
  .map((relay) => relay.trim())
  .filter((relay) => relay.length > 0);
if (relays.length === 0) throw new Error('CFL_NIP60_FIXTURE_RELAYS must list at least one relay');

const fixture = createFixtureServer({
  mint,
  publicMint,
  relays,
  token: required('CFL_NIP60_FIXTURE_TOKEN'),
  walletFactory: (mintUrl) => new CashuTsMintWallet(mintUrl),
  publish: (relayUrl, event) => publishLabEvent(relayUrl, event),
});

const port = positiveInteger(process.env.CFL_NIP60_FIXTURE_PORT, 4500, 'CFL_NIP60_FIXTURE_PORT');
const host = listenHost(process.env.CFL_NIP60_FIXTURE_HOST);

const close = async (): Promise<void> => {
  if (fixture.server.listening) {
    await new Promise<void>((resolve, reject) =>
      fixture.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());

await new Promise<void>((resolve, reject) => {
  fixture.server.once('error', reject);
  fixture.server.listen(port, host, resolve);
});
process.stdout.write(`nip60 reference wallet listening at http://${host}:${port}\n`);
