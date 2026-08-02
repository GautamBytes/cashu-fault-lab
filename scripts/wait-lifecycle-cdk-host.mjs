#!/usr/bin/env node

const DEFAULT_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
const POLL_MS = 500;

const lanes = [
  {
    id: 'cdk-nutshell',
    env: 'CFL_LIFECYCLE_CDK_NUTSHELL_URL',
    fallbackUrl: 'http://127.0.0.1:4121',
  },
  {
    id: 'cdk-mintd',
    env: 'CFL_LIFECYCLE_CDK_MINTD_URL',
    fallbackUrl: 'http://127.0.0.1:4122',
  },
];

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

function adapterOrigin(value, env) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${env} must be a valid URL`);
  }
  const loopbackHost = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    url.protocol !== 'http:' ||
    !loopbackHost ||
    url.origin === 'null' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error(`${env} must be a loopback HTTP origin`);
  }
  return url.origin;
}

function describeError(error, signal) {
  if (signal.aborted) return 'request timed out';
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
  return 'request failed';
}

async function capabilitiesFailure(lane, token) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(new URL('/v1/lifecycle/capabilities', lane.origin), {
      redirect: 'manual',
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
    });
  } catch (error) {
    return describeError(error, signal);
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return `redirected with HTTP ${response.status}`;
  }

  let value;
  try {
    value = await response.json();
  } catch {
    return `returned HTTP ${response.status} with invalid JSON`;
  }

  if (!response.ok) return `returned HTTP ${response.status}`;
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value.implementation?.id !== 'cdk'
  ) {
    return 'returned a non-CDK lifecycle capability document';
  }
  return undefined;
}

async function main() {
  const timeoutMs = positiveIntegerEnv('CFL_LIFECYCLE_CDK_HOST_WAIT_MS', DEFAULT_TIMEOUT_MS);
  const token = process.env.CFL_LIFECYCLE_CDK_TOKEN ?? 'lifecycle-cdk-token';
  if (token.length === 0 || /[\r\n]/u.test(token)) {
    throw new Error('CFL_LIFECYCLE_CDK_TOKEN is invalid');
  }

  const configuredLanes = lanes.map((lane) => ({
    id: lane.id,
    origin: adapterOrigin(process.env[lane.env] ?? lane.fallbackUrl, lane.env),
  }));
  const lastFailures = new Map(configuredLanes.map((lane) => [lane.id, 'not probed']));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const results = await Promise.all(
      configuredLanes.map(async (lane) => [lane, await capabilitiesFailure(lane, token)]),
    );
    for (const [lane, failure] of results) {
      if (failure === undefined) lastFailures.delete(lane.id);
      else lastFailures.set(lane.id, failure);
    }
    if (lastFailures.size === 0) {
      console.log(
        `lifecycle CDK host adapters reachable: ${configuredLanes
          .map((lane) => lane.id)
          .join(', ')}`,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  console.error('lifecycle CDK host adapters did not become reachable:');
  for (const lane of configuredLanes) {
    const failure = lastFailures.get(lane.id);
    if (failure !== undefined) console.error(`- ${lane.id} (${lane.origin}): ${failure}`);
  }
  process.exitCode = 1;
}

await main();
