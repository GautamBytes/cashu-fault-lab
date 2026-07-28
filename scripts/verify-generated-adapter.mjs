#!/usr/bin/env node

import {
  AdapterNotApplicableError,
  HttpAdapterClient,
} from '../packages/adapter-contract/dist/index.js';

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const MAX_STARTUP_TIMEOUT_MS = 60_000;
const CLIENT_TIMEOUT_MS = 2_000;

function parseArguments(argv) {
  if (argv.length === 0 || argv.length % 2 !== 0) {
    throw new Error(
      'Usage: verify-generated-adapter --base-url <loopback-origin> --token <token> [--startup-timeout-ms <milliseconds>]',
    );
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--base-url', '--token', '--startup-timeout-ms'].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }

  const baseUrl = values.get('--base-url');
  const token = values.get('--token');
  if (baseUrl === undefined || token === undefined) {
    throw new Error('--base-url and --token are required');
  }
  if (token.length === 0 || token.length > 512 || /[\u0000-\u001f\u007f]/u.test(token)) {
    throw new Error('Adapter token is invalid');
  }

  const url = new URL(baseUrl);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('--base-url must be an HTTP loopback origin');
  }

  const timeoutText = values.get('--startup-timeout-ms');
  const startupTimeoutMs =
    timeoutText === undefined ? DEFAULT_STARTUP_TIMEOUT_MS : Number(timeoutText);
  if (
    !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1 ||
    startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS
  ) {
    throw new Error('--startup-timeout-ms must be an integer from 1 to 60000');
  }

  return { baseUrl: url.origin, token, startupTimeoutMs };
}

async function waitForCapabilities(client, startupTimeoutMs) {
  const deadline = Date.now() + startupTimeoutMs;
  while (true) {
    try {
      return await client.capabilities();
    } catch {
      if (Date.now() >= deadline) {
        throw new Error('Generated adapter did not become contract-ready before the timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function requireAuthentication(baseUrl) {
  const response = await fetch(new URL('/v1/capabilities', baseUrl), {
    redirect: 'manual',
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  await response.body?.cancel();
  if (response.status !== 401) {
    throw new Error(`Generated adapter accepted an unauthenticated request (${response.status})`);
  }
}

async function requireNotApplicable(operation) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AdapterNotApplicableError) return;
    throw error;
  }
  throw new Error('Generated adapter did not return canonical N/A for an unsupported operation');
}

async function main() {
  const { baseUrl, token, startupTimeoutMs } = parseArguments(process.argv.slice(2));
  const client = new HttpAdapterClient({
    baseUrl,
    token,
    timeoutMs: CLIENT_TIMEOUT_MS,
    maxResponseBytes: 256 * 1024,
  });

  await waitForCapabilities(client, startupTimeoutMs);
  await requireAuthentication(baseUrl);
  await client.reset('generated-adapter-conformance');
  await requireNotApplicable(() => client.ledger());
  process.stdout.write(`verified generated adapter at ${baseUrl}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown verification error';
  process.stderr.write(`generated adapter verification failed: ${message}\n`);
  process.exitCode = 1;
}
