#!/usr/bin/env node
import { NostrFaultRelay } from './relay.js';

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
    throw new Error('CFL_NOSTR_FAULT_RELAY_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return host;
}

const relay = new NostrFaultRelay();

const close = async (): Promise<void> => {
  await relay.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await relay.listen(
  positiveInteger(process.env.CFL_NOSTR_FAULT_RELAY_PORT, 4400, 'CFL_NOSTR_FAULT_RELAY_PORT'),
  listenHost(process.env.CFL_NOSTR_FAULT_RELAY_HOST),
);
