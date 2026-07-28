const MANIFEST_KEYS = new Set(['schemaVersion', 'adapters']);
const ADAPTER_V1_KEYS = new Set(['id', 'url', 'tokenEnv']);
const ADAPTER_V2_KEYS = new Set(['id', 'url', 'tokenEnv', 'evidence']);
const EVIDENCE_KEYS = new Set(['ledger', 'mint']);
const AUTHORITY_KEYS = new Set(['url', 'tokenEnv']);
const ADAPTER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TOKEN_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_ADAPTERS = 64;

export interface AdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly tokenEnv: string;
  readonly evidence?: EvidenceAuthorityRegistrations;
}

export interface EvidenceAuthorityRegistration {
  readonly url: string;
  readonly tokenEnv: string;
}

export interface EvidenceAuthorityRegistrations {
  readonly ledger?: EvidenceAuthorityRegistration;
  readonly mint?: EvidenceAuthorityRegistration;
}

export interface AdapterManifest {
  readonly schemaVersion: 1 | 2;
  readonly adapters: readonly AdapterRegistration[];
}

export interface ResolvedAdapterRegistration {
  readonly id: string;
  readonly url: string;
  readonly token: string;
  readonly evidence?: ResolvedEvidenceAuthorities;
}

export interface ResolvedEvidenceAuthority {
  readonly url: string;
  readonly token: string;
}

export interface ResolvedEvidenceAuthorities {
  readonly ledger?: ResolvedEvidenceAuthority;
  readonly mint?: ResolvedEvidenceAuthority;
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

function authority(value: unknown): EvidenceAuthorityRegistration {
  const input = record(value);
  exactKeys(input, AUTHORITY_KEYS);
  if (typeof input.tokenEnv !== 'string' || !TOKEN_ENV.test(input.tokenEnv)) {
    throw new Error('Adapter manifest evidence token environment variable is invalid');
  }
  return { url: adapterUrl(input.url), tokenEnv: input.tokenEnv };
}

function evidenceAuthorities(
  value: unknown,
  adapterOrigin: string,
): EvidenceAuthorityRegistrations {
  const input = record(value);
  exactKeys(input, EVIDENCE_KEYS);
  const evidence = {
    ...(input.ledger === undefined ? {} : { ledger: authority(input.ledger) }),
    ...(input.mint === undefined ? {} : { mint: authority(input.mint) }),
  };
  if (evidence.ledger === undefined && evidence.mint === undefined) {
    throw new Error('Adapter manifest evidence must configure ledger or mint authority');
  }
  if (
    evidence.ledger?.url === adapterOrigin ||
    evidence.mint?.url === adapterOrigin
  ) {
    throw new Error('Adapter manifest evidence authority must be independent from the adapter');
  }
  return evidence;
}

function adapter(value: unknown, schemaVersion: 1 | 2): AdapterRegistration {
  const input = record(value);
  exactKeys(input, schemaVersion === 1 ? ADAPTER_V1_KEYS : ADAPTER_V2_KEYS);
  if (typeof input.id !== 'string' || !ADAPTER_ID.test(input.id)) {
    throw new Error('Adapter manifest ID is invalid');
  }
  if (typeof input.tokenEnv !== 'string' || !TOKEN_ENV.test(input.tokenEnv)) {
    throw new Error('Adapter manifest token environment variable is invalid');
  }
  const url = adapterUrl(input.url);
  return {
    id: input.id,
    url,
    tokenEnv: input.tokenEnv,
    ...(input.evidence === undefined
      ? {}
      : { evidence: evidenceAuthorities(input.evidence, url) }),
  };
}

export function parseAdapterManifest(value: unknown): AdapterManifest {
  const input = record(value);
  exactKeys(input, MANIFEST_KEYS);
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2) {
    throw new Error('Adapter manifest schemaVersion must be 1 or 2');
  }
  if (
    !Array.isArray(input.adapters) ||
    input.adapters.length === 0 ||
    input.adapters.length > MAX_ADAPTERS
  ) {
    throw new Error(`Adapter manifest must contain between 1 and ${MAX_ADAPTERS} adapters`);
  }
  const schemaVersion = input.schemaVersion;
  const adapters = input.adapters.map((value) => adapter(value, schemaVersion));
  const ids = new Set<string>();
  for (const registration of adapters) {
    if (ids.has(registration.id)) {
      throw new Error(`Duplicate adapter ID: ${registration.id}`);
    }
    ids.add(registration.id);
  }
  return { schemaVersion, adapters };
}

function token(
  env: Readonly<Record<string, string | undefined>>,
  tokenEnv: string,
): string {
  const value = env[tokenEnv];
  if (value === undefined || value.trim().length === 0 || /[\r\n]/u.test(value)) {
    throw new Error(`Adapter control token ${tokenEnv} is missing or invalid`);
  }
  return value;
}

export function resolveAdapterManifest(
  manifest: AdapterManifest,
  env: Readonly<Record<string, string | undefined>>,
): readonly ResolvedAdapterRegistration[] {
  return manifest.adapters.map((registration) => {
    const evidence =
      registration.evidence === undefined
        ? undefined
        : {
            ...(registration.evidence.ledger === undefined
              ? {}
              : {
                  ledger: {
                    url: registration.evidence.ledger.url,
                    token: token(env, registration.evidence.ledger.tokenEnv),
                  },
                }),
            ...(registration.evidence.mint === undefined
              ? {}
              : {
                  mint: {
                    url: registration.evidence.mint.url,
                    token: token(env, registration.evidence.mint.tokenEnv),
                  },
                }),
          };
    return {
      id: registration.id,
      url: registration.url,
      token: token(env, registration.tokenEnv),
      ...(evidence === undefined ? {} : { evidence }),
    };
  });
}
