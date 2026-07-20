#!/usr/bin/env node
import { HttpFaultGateway } from './proxy.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function port(value: string | undefined): number {
  const parsed = value === undefined ? 4300 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('CFL_HTTP_FAULT_GATEWAY_PORT must be an integer from 1 to 65,535');
  }
  return parsed;
}

function host(value: string | undefined): string {
  const parsed = value ?? '127.0.0.1';
  if (parsed !== '127.0.0.1' && parsed !== '0.0.0.0') {
    throw new Error('CFL_HTTP_FAULT_GATEWAY_HOST must be 127.0.0.1 or 0.0.0.0');
  }
  return parsed;
}

const gateway = new HttpFaultGateway({
  downstream: required('CFL_HTTP_FAULT_GATEWAY_DOWNSTREAM'),
  controlToken: required('CFL_HTTP_FAULT_GATEWAY_CONTROL_TOKEN'),
});

const close = async (): Promise<void> => {
  await gateway.close();
  process.exitCode = 0;
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
await gateway.listen(
  port(process.env.CFL_HTTP_FAULT_GATEWAY_PORT),
  host(process.env.CFL_HTTP_FAULT_GATEWAY_HOST),
);
