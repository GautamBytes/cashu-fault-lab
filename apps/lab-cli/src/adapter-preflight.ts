import {
  AdapterClientError,
  HttpAdapterClient,
  validateAdapterCompatibility,
  type AdapterCapabilities,
  type AdapterImplementationIdentity,
} from '@cashu-fault-lab/adapter-contract';
import type {
  AdapterManifest,
  AdapterRegistration,
  EvidenceAuthorityRegistration,
} from './adapter-manifest.js';

export type AdapterPreflightStatus = 'passed' | 'warning' | 'failed';

export interface AdapterPreflightCheck {
  readonly adapterId: string;
  readonly stage:
    'authentication' | 'connectivity' | 'identity' | 'contract' | 'profile' | 'evidence';
  readonly status: AdapterPreflightStatus;
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

export interface AdapterPreflightAdapter {
  readonly id: string;
  readonly url: string;
  readonly implementation?: AdapterImplementationIdentity;
  readonly capabilities?: AdapterCapabilities;
}

export interface AdapterPreflightReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly profile: string;
  readonly adapters: readonly AdapterPreflightAdapter[];
  readonly checks: readonly AdapterPreflightCheck[];
}

export interface LocalAdapterPreflightOptions {
  readonly manifest: AdapterManifest;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly profile?: string;
  readonly adapterId?: string;
  readonly fetch?: typeof fetch;
}

function validToken(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0 && !/[\r\n]/u.test(value);
}

function client(url: string, token: string, fetchOverride: typeof fetch | undefined) {
  return new HttpAdapterClient({
    baseUrl: url,
    token,
    ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }),
  });
}

function failure(
  adapterId: string,
  stage: AdapterPreflightCheck['stage'],
  code: string,
  message: string,
  remediation: string,
): AdapterPreflightCheck {
  return { adapterId, stage, status: 'failed', code, message, remediation };
}

function passed(
  adapterId: string,
  stage: AdapterPreflightCheck['stage'],
  code: string,
  message: string,
): AdapterPreflightCheck {
  return { adapterId, stage, status: 'passed', code, message };
}

function warning(
  adapterId: string,
  stage: AdapterPreflightCheck['stage'],
  code: string,
  message: string,
  remediation: string,
): AdapterPreflightCheck {
  return { adapterId, stage, status: 'warning', code, message, remediation };
}

function capabilityFailure(adapterId: string, error: unknown): AdapterPreflightCheck {
  const unavailable =
    error instanceof AdapterClientError &&
    (error.code === 'ADAPTER_UNAVAILABLE' || error.code === 'ADAPTER_TIMEOUT');
  return failure(
    adapterId,
    'connectivity',
    unavailable ? 'ADAPTER_UNREACHABLE' : 'ADAPTER_CAPABILITIES_INVALID',
    unavailable
      ? 'The adapter capability endpoint could not be reached.'
      : 'The adapter capability response does not satisfy the contract.',
    unavailable
      ? 'Start the loopback adapter and rerun adapter preflight.'
      : 'Validate GET /v1/capabilities against the current adapter contract.',
  );
}

function selectedRegistrations(
  options: LocalAdapterPreflightOptions,
): readonly AdapterRegistration[] {
  if (options.adapterId === undefined) return options.manifest.adapters;
  return options.manifest.adapters.filter(({ id }) => id === options.adapterId);
}

async function checkAuthority(
  adapterId: string,
  kind: 'ledger' | 'mint',
  registration: EvidenceAuthorityRegistration,
  env: Readonly<Record<string, string | undefined>>,
  fetchOverride: typeof fetch | undefined,
): Promise<readonly AdapterPreflightCheck[]> {
  const token = env[registration.tokenEnv];
  if (!validToken(token)) {
    return [
      failure(
        adapterId,
        'evidence',
        kind === 'ledger' ? 'LEDGER_AUTHORITY_TOKEN_MISSING' : 'MINT_AUTHORITY_TOKEN_MISSING',
        `The ${kind} evidence authority token is missing or invalid.`,
        `Set ${registration.tokenEnv} and rerun adapter preflight.`,
      ),
    ];
  }
  try {
    const authority = client(registration.url, token, fetchOverride);
    if (kind === 'ledger') {
      await authority.ledger();
    } else {
      await Promise.all([authority.proofs(), authority.redemptions()]);
    }
    return [
      passed(
        adapterId,
        'evidence',
        kind === 'ledger' ? 'LEDGER_AUTHORITY_REACHABLE' : 'MINT_AUTHORITY_REACHABLE',
        `The ${kind} evidence authority returned contract-valid read-only evidence.`,
      ),
    ];
  } catch {
    return [
      failure(
        adapterId,
        'evidence',
        kind === 'ledger' ? 'LEDGER_AUTHORITY_INVALID' : 'MINT_AUTHORITY_INVALID',
        `The ${kind} evidence authority could not return contract-valid evidence.`,
        `Check the ${kind} authority origin, token, and response schema.`,
      ),
    ];
  }
}

async function checkAdapter(
  registration: AdapterRegistration,
  options: LocalAdapterPreflightOptions,
  profile: string,
): Promise<{
  readonly adapter: AdapterPreflightAdapter;
  readonly checks: readonly AdapterPreflightCheck[];
}> {
  const checks: AdapterPreflightCheck[] = [];
  const token = options.env[registration.tokenEnv];
  if (!validToken(token)) {
    checks.push(
      failure(
        registration.id,
        'authentication',
        'ADAPTER_TOKEN_MISSING',
        'The adapter control token is missing or invalid.',
        `Set ${registration.tokenEnv} and rerun adapter preflight.`,
      ),
    );
    return { adapter: { id: registration.id, url: registration.url }, checks };
  }
  checks.push(
    passed(
      registration.id,
      'authentication',
      'ADAPTER_TOKEN_PRESENT',
      `Control token ${registration.tokenEnv} is present.`,
    ),
  );

  let capabilities: AdapterCapabilities;
  try {
    capabilities = await client(registration.url, token, options.fetch).capabilities();
  } catch (error) {
    checks.push(capabilityFailure(registration.id, error));
    return { adapter: { id: registration.id, url: registration.url }, checks };
  }
  checks.push(
    passed(
      registration.id,
      'connectivity',
      'ADAPTER_REACHABLE',
      'GET /v1/capabilities returned a contract-valid response.',
    ),
  );
  const adapter: AdapterPreflightAdapter = {
    id: registration.id,
    url: registration.url,
    implementation: capabilities.implementation,
    capabilities,
  };

  if (capabilities.implementation.id !== registration.id) {
    checks.push(
      failure(
        registration.id,
        'identity',
        'ADAPTER_IDENTITY_MISMATCH',
        `Manifest ID ${registration.id} does not match the capability identity.`,
        'Make the manifest ID and capabilities implementation.id identical.',
      ),
    );
    return { adapter, checks };
  }
  checks.push(
    passed(
      registration.id,
      'identity',
      'ADAPTER_IDENTITY_MATCH',
      'Manifest and capability identities match.',
    ),
  );

  const compatibility = validateAdapterCompatibility(capabilities);
  if (!compatibility.ok) {
    checks.push(
      failure(
        registration.id,
        'contract',
        compatibility.code,
        compatibility.reason,
        'Regenerate the adapter from the installed Cashu Fault Lab version.',
      ),
    );
    return { adapter, checks };
  }
  checks.push(
    passed(
      registration.id,
      'contract',
      'ADAPTER_CONTRACT_COMPATIBLE',
      'Adapter API, schema, and specification digest are compatible.',
    ),
  );
  for (const compatibilityWarning of compatibility.warnings) {
    checks.push(
      warning(
        registration.id,
        'contract',
        compatibilityWarning.code,
        compatibilityWarning.message,
        compatibilityWarning.remediation,
      ),
    );
  }

  const supportsProfile = Object.values(capabilities.roles).some((role) =>
    role?.profiles.includes(profile),
  );
  checks.push(
    supportsProfile
      ? passed(
          registration.id,
          'profile',
          'ADAPTER_PROFILE_SUPPORTED',
          `At least one declared role supports ${profile}.`,
        )
      : warning(
          registration.id,
          'profile',
          'ADAPTER_PROFILE_UNSUPPORTED',
          `No declared adapter role supports ${profile}.`,
          `Implement the profile before running adapter preview --profile ${profile}.`,
        ),
  );

  if (registration.evidence?.ledger !== undefined) {
    checks.push(
      ...(await checkAuthority(
        registration.id,
        'ledger',
        registration.evidence.ledger,
        options.env,
        options.fetch,
      )),
    );
  }
  if (registration.evidence?.mint !== undefined) {
    checks.push(
      ...(await checkAuthority(
        registration.id,
        'mint',
        registration.evidence.mint,
        options.env,
        options.fetch,
      )),
    );
  }
  return { adapter, checks };
}

export async function preflightLocalAdapters(
  options: LocalAdapterPreflightOptions,
): Promise<AdapterPreflightReport> {
  const profile = options.profile ?? 'delivery-v1';
  const registrations = selectedRegistrations(options);
  if (registrations.length === 0 && options.adapterId !== undefined) {
    return {
      schemaVersion: 1,
      ok: false,
      profile,
      adapters: [],
      checks: [
        failure(
          options.adapterId,
          'identity',
          'ADAPTER_NOT_REGISTERED',
          `Adapter ${options.adapterId} is not present in the manifest.`,
          'Use an adapter ID listed in adapter-manifest.json.',
        ),
      ],
    };
  }
  const results = [];
  for (const registration of registrations) {
    results.push(await checkAdapter(registration, options, profile));
  }
  const checks = results.flatMap(({ checks: adapterChecks }) => adapterChecks);
  return {
    schemaVersion: 1,
    ok: checks.every(({ status }) => status !== 'failed'),
    profile,
    adapters: results.map(({ adapter }) => adapter),
    checks,
  };
}
