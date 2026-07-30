export type LabDiagnosticCode =
  | 'NODE_VERSION_UNSUPPORTED'
  | 'DOCKER_NOT_INSTALLED'
  | 'DOCKER_DAEMON_UNAVAILABLE'
  | 'PORT_IN_USE'
  | 'ADAPTER_ROLE_MISSING'
  | 'EVIDENCE_TIER_INSUFFICIENT'
  | 'ADAPTER_MANIFEST_INVALID'
  | 'ADAPTER_CONTRACT_INCOMPATIBLE'
  | 'FAULT_GATEWAY_REQUIRED'
  | 'FAULT_GATEWAY_NOT_LOOPBACK'
  | 'PROFILE_UNSUPPORTED'
  | 'ENCODING_UNSUPPORTED'
  | 'IMPLEMENTATIONS_NOT_INDEPENDENT';

export interface LabDiagnostic {
  readonly code: LabDiagnosticCode;
  readonly problem: string;
  readonly likelyCause: string;
  readonly remediation: string;
  readonly nextCommand: string;
}

export class LabDiagnosticError extends Error {
  constructor(readonly diagnostic: LabDiagnostic) {
    super(diagnostic.problem);
    this.name = 'LabDiagnosticError';
  }
}

const CATALOGUE: Readonly<Record<LabDiagnosticCode, LabDiagnostic>> = {
  NODE_VERSION_UNSUPPORTED: {
    code: 'NODE_VERSION_UNSUPPORTED',
    problem: 'Node.js is outside the supported Cashu Fault Lab engine range.',
    likelyCause: 'The active shell is not using the repository-pinned Node 24 runtime.',
    remediation: 'Switch to Node 24.x before running lab commands or tests.',
    nextCommand: 'node --version',
  },
  DOCKER_NOT_INSTALLED: {
    code: 'DOCKER_NOT_INSTALLED',
    problem: 'Docker is not installed or is not available on PATH.',
    likelyCause: 'Docker Desktop or the Docker CLI is missing from this machine.',
    remediation: 'Install Docker Desktop and restart the shell so docker is on PATH.',
    nextCommand: 'docker --version',
  },
  DOCKER_DAEMON_UNAVAILABLE: {
    code: 'DOCKER_DAEMON_UNAVAILABLE',
    problem: 'The Docker daemon is not reachable.',
    likelyCause: 'Docker Desktop is stopped or the current user cannot access the daemon.',
    remediation: 'Start Docker Desktop and wait until the daemon is ready.',
    nextCommand: 'docker info',
  },
  PORT_IN_USE: {
    code: 'PORT_IN_USE',
    problem: 'A port required by the local lab stack is already in use.',
    likelyCause: 'A previous lab stack or another local service is still running.',
    remediation: 'Stop the process using the port before starting funded lab lanes.',
    nextCommand: 'cashu-fault-lab down --profile lab',
  },
  ADAPTER_ROLE_MISSING: {
    code: 'ADAPTER_ROLE_MISSING',
    problem: 'The selected adapter does not declare the required role for this scenario.',
    likelyCause: 'The adapter capabilities omit sender or receiver support for the profile.',
    remediation: 'Choose an adapter that declares the required role or update its capabilities.',
    nextCommand: 'cashu-fault-lab matrix --profile delivery-v1',
  },
  EVIDENCE_TIER_INSUFFICIENT: {
    code: 'EVIDENCE_TIER_INSUFFICIENT',
    problem: 'The adapter evidence tier is too low for the requested operation.',
    likelyCause: 'The selected profile or release policy requires stronger observed evidence.',
    remediation: 'Run a stronger adapter lane or lower only non-release developer gates.',
    nextCommand:
      'cashu-fault-lab matrix --profile delivery-v1 --release-policy spec/release-policy.json',
  },
  ADAPTER_MANIFEST_INVALID: {
    code: 'ADAPTER_MANIFEST_INVALID',
    problem: 'Adapter manifest is invalid.',
    likelyCause: 'The manifest is malformed, has unsupported fields, or references invalid URLs.',
    remediation: 'Fix the manifest schemaVersion, adapter IDs, loopback URLs, and token env vars.',
    nextCommand: 'cashu-fault-lab doctor --json',
  },
  ADAPTER_CONTRACT_INCOMPATIBLE: {
    code: 'ADAPTER_CONTRACT_INCOMPATIBLE',
    problem: 'Adapter contract metadata is incompatible with this lab checkout.',
    likelyCause: 'The adapter was generated from a different API version or OpenAPI digest.',
    remediation: 'Regenerate the adapter/client from the current canonical specification.',
    nextCommand: 'pnpm codegen',
  },
  FAULT_GATEWAY_REQUIRED: {
    code: 'FAULT_GATEWAY_REQUIRED',
    problem: 'The maintainer preview requires the authenticated HTTP fault gateway.',
    likelyCause: 'The gateway URL or control token is not configured in this shell.',
    remediation:
      'Start the local fault gateway and set CFL_HTTP_FAULT_GATEWAY_URL plus CFL_HTTP_FAULT_GATEWAY_TOKEN.',
    nextCommand:
      'cashu-fault-lab adapter preview --adapters adapter-manifest.json --sender <id> --receiver <id>',
  },
  FAULT_GATEWAY_NOT_LOOPBACK: {
    code: 'FAULT_GATEWAY_NOT_LOOPBACK',
    problem: 'The maintainer preview fault gateway is not a loopback HTTP origin.',
    likelyCause: 'CFL_HTTP_FAULT_GATEWAY_URL points to a hosted, TLS, or path-qualified endpoint.',
    remediation: 'Use an origin-only http://127.0.0.1:<port> or http://[::1]:<port> gateway URL.',
    nextCommand:
      'cashu-fault-lab adapter preview --adapters adapter-manifest.json --sender <id> --receiver <id>',
  },
  PROFILE_UNSUPPORTED: {
    code: 'PROFILE_UNSUPPORTED',
    problem: 'The requested profile is not supported by the selected adapter pair.',
    likelyCause: 'The adapter capabilities do not include this delivery profile.',
    remediation: 'Use a supported profile or update the adapter implementation.',
    nextCommand: 'cashu-fault-lab matrix --profile delivery-v1',
  },
  ENCODING_UNSUPPORTED: {
    code: 'ENCODING_UNSUPPORTED',
    problem: 'The selected adapter does not support the requested payment request encoding.',
    likelyCause: 'The adapter capabilities omit the encoding required by this profile.',
    remediation: 'Select an adapter that supports the encoding or regenerate its client.',
    nextCommand: 'cashu-fault-lab matrix --profile delivery-v1',
  },
  IMPLEMENTATIONS_NOT_INDEPENDENT: {
    code: 'IMPLEMENTATIONS_NOT_INDEPENDENT',
    problem: 'The selected implementations do not satisfy independence requirements.',
    likelyCause:
      'The sender and receiver share implementation identity, language, or build digest.',
    remediation: 'Run the matrix with independently implemented adapters.',
    nextCommand:
      'cashu-fault-lab matrix --profile delivery-v1 --release-policy spec/release-policy.json',
  },
};

export function createDiagnostic(
  code: LabDiagnosticCode,
  overrides: Partial<Omit<LabDiagnostic, 'code'>> = {},
): LabDiagnostic {
  return { ...CATALOGUE[code], ...overrides, code };
}

export function renderDiagnosticText(diagnostic: LabDiagnostic): string {
  return [
    `${diagnostic.code}: ${diagnostic.problem}`,
    `Likely cause: ${diagnostic.likelyCause}`,
    `Remediation: ${diagnostic.remediation}`,
    `Next command: ${diagnostic.nextCommand}`,
    '',
  ].join('\n');
}

export function renderDiagnosticJson(diagnostic: LabDiagnostic): string {
  return `${JSON.stringify(diagnostic, null, 2)}\n`;
}
