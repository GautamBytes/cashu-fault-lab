const MANIFEST_KEYS = new Set(['schemaVersion', 'adapters']);
const ADAPTER_KEYS = new Set(['id', 'url', 'tokenEnv']);
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TOKEN_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ADAPTERS = 64;

export interface AdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly tokenEnv: string;
}

export interface AdapterManifest {
  readonly schemaVersion: 1;
  readonly adapters: readonly AdapterRegistration[];
}

export interface ResolvedAdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly token: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Adapter manifest must be an object');
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('Adapter manifest contains an unknown field');
  }
}

function adapterUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Adapter manifest URL must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Adapter manifest URL is invalid');
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.port.length === 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (value !== url.origin && value !== `${url.origin}/`)
  ) {
    throw new Error('Adapter manifest URL must be an origin-only loopback HTTP URL');
  }
  return url.origin;
}

function adapter(value: unknown): AdapterRegistration {
  const input = record(value);
  exactKeys(input, ADAPTER_KEYS);
  if (typeof input.id !== 'string' || !ADAPTER_ID.test(input.id)) {
    throw new Error('Adapter manifest ID is invalid');
  }
  if (typeof input.tokenEnv !== 'string' || !TOKEN_ENV.test(input.tokenEnv)) {
    throw new Error('Adapter manifest token environment variable is invalid');
  }
  return { id: input.id, url: adapterUrl(input.url), tokenEnv: input.tokenEnv };
}

export function parseAdapterManifest(value: unknown): AdapterManifest {
  const input = record(value);
  exactKeys(input, MANIFEST_KEYS);
  if (input.schemaVersion !== 1) {
    throw new Error('Adapter manifest schemaVersion must be 1');
  }
  if (
    !Array.isArray(input.adapters) ||
    input.adapters.length === 0 ||
    input.adapters.length > MAX_ADAPTERS
  ) {
    throw new Error(`Adapter manifest must contain between 1 and ${MAX_ADAPTERS} adapters`);
  }
  const adapters = input.adapters.map(adapter);
  const ids = new Set<string>();
  for (const registration of adapters) {
    if (ids.has(registration.id)) {
      throw new Error(`Duplicate adapter ID: ${registration.id}`);
    }
    ids.add(registration.id);
  }
  return { schemaVersion: 1, adapters };
}

export function resolveAdapterManifest(
  manifest: AdapterManifest,
  env: Readonly<Record<string, string | undefined>>,
): readonly ResolvedAdapterRegistration[] {
  return manifest.adapters.map((registration) => {
    const token = env[registration.tokenEnv];
    if (token === undefined || token.trim().length === 0 || /[\r\n]/u.test(token)) {
      throw new Error(`Adapter control token ${registration.tokenEnv} is missing or invalid`);
    }
    return { id: registration.id, url: registration.url, token };
  });
}
