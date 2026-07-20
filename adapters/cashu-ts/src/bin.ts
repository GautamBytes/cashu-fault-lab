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

const app = await buildFundedCashuTsAdapterServer({
  mintUrl: required('CFL_CASHU_TS_MINT_URL'),
  controlToken: required('CFL_CASHU_TS_CONTROL_TOKEN'),
  fundingAmount: positiveInteger(
    process.env.CFL_CASHU_TS_FUNDING_AMOUNT,
    64,
    'CFL_CASHU_TS_FUNDING_AMOUNT',
  ),
});
const port = positiveInteger(process.env.CFL_CASHU_TS_PORT, 4101, 'CFL_CASHU_TS_PORT');

const close = async (): Promise<void> => {
  await app.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await app.listen({ host: '127.0.0.1', port });
