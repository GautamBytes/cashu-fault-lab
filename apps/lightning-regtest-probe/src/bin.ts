import { LightningRegtestProbe } from './index.js';
import { readFileSync } from 'node:fs';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const probe = new LightningRegtestProbe({
  host: process.env.CFL_LIGHTNING_PROBE_HOST ?? '127.0.0.1',
  port: Number(process.env.CFL_LIGHTNING_PROBE_PORT ?? '4400'),
  token: required('CFL_LIGHTNING_PROBE_TOKEN'),
  lndUrl: required('CFL_LIGHTNING_PROBE_LND_URL'),
  ...(process.env.CFL_LIGHTNING_PROBE_MACAROON_PATH === undefined
    ? {}
    : {
        lndMacaroonHex: readFileSync(process.env.CFL_LIGHTNING_PROBE_MACAROON_PATH).toString('hex'),
      }),
});
await probe.start();

const close = async (): Promise<void> => {
  await probe.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
