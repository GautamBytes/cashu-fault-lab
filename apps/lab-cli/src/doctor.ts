import { execFile } from 'node:child_process';
import { Socket } from 'node:net';
import { promisify } from 'node:util';
import { createDiagnostic, type LabDiagnostic } from './diagnostics.js';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
  readonly diagnostic?: LabDiagnostic;
}

export interface DoctorProbes {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execFile: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly isPortFree: (host: string, port: number) => Promise<boolean>;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly ok: boolean;
}

const REQUIRED_ENV_VARS = [
  'CFL_CASHU_TS_TOKEN',
  'CFL_CDK_TOKEN',
  'CFL_REFERENCE_RECEIVER_TOKEN',
  'CFL_REFERENCE_RECEIVER_CLAIM_KEY',
  'CFL_HTTP_FAULT_GATEWAY_TOKEN',
  'CFL_REAL_MINT_URL',
] as const;

const OPTIONAL_ENV_VARS = ['CFL_HTTP_FAULT_GATEWAY_URL'] as const;

const SENDER_DURABILITY_ENV_VARS = [
  'CFL_CASHU_TS_SENDER_DATABASE_URL',
  'CFL_CASHU_TS_SENDER_RUN_ID',
  'CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION',
  'CFL_CASHU_TS_SENDER_STATE_KEYS',
] as const;

const DEFAULT_PORTS: readonly { readonly label: string; readonly port: number }[] = [
  { label: 'nutshell-mint', port: 3338 },
  { label: 'cashu-ts-adapter', port: 4101 },
  { label: 'cdk-adapter', port: 4102 },
  { label: 'reference-receiver', port: 4200 },
  { label: 'http-fault-gateway', port: 4300 },
];

const ENV_TOKEN_PATTERN = /^[A-Za-z0-9._-]{4,512}$/;

function envCheck(env: Readonly<Record<string, string | undefined>>): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      checks.push({ name, status: 'fail', detail: 'missing' });
    } else if (/\r|\n/.test(value)) {
      checks.push({ name, status: 'fail', detail: 'contains newline' });
    } else if (name === 'CFL_REAL_MINT_URL') {
      try {
        const url = new URL(value);
        checks.push(
          url.protocol === 'http:' || url.protocol === 'https:'
            ? { name, status: 'ok', detail: 'set' }
            : { name, status: 'fail', detail: 'must use http or https' },
        );
      } catch {
        checks.push({ name, status: 'fail', detail: 'invalid URL' });
      }
    } else if (!ENV_TOKEN_PATTERN.test(value)) {
      checks.push({ name, status: 'warn', detail: 'looks like a placeholder token' });
    } else {
      checks.push({ name, status: 'ok', detail: 'set' });
    }
  }
  for (const name of OPTIONAL_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      checks.push({ name, status: 'warn', detail: 'not set (only needed for funded lanes)' });
    } else {
      checks.push({ name, status: 'ok', detail: 'set' });
    }
  }
  return checks;
}

function senderDurabilityEnvCheck(env: Readonly<Record<string, string | undefined>>): DoctorCheck {
  const configured = SENDER_DURABILITY_ENV_VARS.some((name) => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0;
  });
  if (!configured) {
    return {
      name: 'cashu-ts sender durability',
      status: 'warn',
      detail: 'not configured (process-local sender state)',
    };
  }
  for (const name of SENDER_DURABILITY_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value.trim().length === 0) {
      return { name: 'cashu-ts sender durability', status: 'fail', detail: `missing ${name}` };
    }
  }
  try {
    const url = new URL(env.CFL_CASHU_TS_SENDER_DATABASE_URL!);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error('database URL must use postgres:// or postgresql://');
    }
    if (url.hash.length > 0) throw new Error('database URL cannot contain a fragment');
    const runId = env.CFL_CASHU_TS_SENDER_RUN_ID!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(runId)) {
      throw new Error('run ID is invalid');
    }
    const active = Number(env.CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION);
    if (!Number.isSafeInteger(active) || active < 1) {
      throw new Error('active key version must be a positive integer');
    }
    const versions = new Set<number>();
    for (const entry of env.CFL_CASHU_TS_SENDER_STATE_KEYS!.split(',')) {
      const [versionText, keyText, extra] = entry.trim().split(':');
      if (
        extra !== undefined ||
        versionText === undefined ||
        keyText === undefined ||
        !/^[1-9]\d*$/u.test(versionText) ||
        !/^[A-Za-z0-9_-]+={0,2}$/u.test(keyText)
      ) {
        throw new Error('state key map is malformed');
      }
      const version = Number(versionText);
      if (versions.has(version)) throw new Error('state key version is duplicate');
      versions.add(version);
      if (Buffer.from(keyText, 'base64url').byteLength !== 32) {
        throw new Error('state keys must decode to 32 bytes');
      }
    }
    if (!versions.has(active)) throw new Error('active key version is not readable');
    return {
      name: 'cashu-ts sender durability',
      status: 'ok',
      detail: `PostgreSQL sender state configured for run ${runId}`,
    };
  } catch (error) {
    return {
      name: 'cashu-ts sender durability',
      status: 'fail',
      detail: error instanceof Error ? truncate(error.message) : 'invalid configuration',
    };
  }
}

const EXEC_TIMEOUT_MS = 5_000;
const EXEC_MAX_BUFFER = 4_096;
const DETAIL_MAX_LENGTH = 256;

function truncate(value: string): string {
  return value.length <= DETAIL_MAX_LENGTH ? value : `${value.slice(0, DETAIL_MAX_LENGTH)}…`;
}

async function versionCheck(
  probe: DoctorProbes,
  command: string,
  args: readonly string[],
  expected: RegExp,
  label: string,
): Promise<DoctorCheck> {
  try {
    const { stdout } = await probe.execFile(command, args);
    const trimmed = stdout.trim();
    const match = trimmed.match(expected);
    if (!match) {
      return { name: label, status: 'warn', detail: `unexpected version: ${truncate(trimmed)}` };
    }
    return { name: label, status: 'ok', detail: match[0] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'command failed';
    return { name: label, status: 'fail', detail: truncate(reason) };
  }
}

async function nodeVersionCheck(probe: DoctorProbes): Promise<DoctorCheck> {
  try {
    const { stdout } = await probe.execFile('node', ['--version']);
    const trimmed = stdout.trim();
    const match = trimmed.match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      return { name: 'node', status: 'warn', detail: `unexpected version: ${truncate(trimmed)}` };
    }
    const major = Number(match[1]);
    if (major !== 24) {
      return {
        name: 'node',
        status: 'fail',
        detail: `requires Node 24.x; found ${trimmed}`,
        diagnostic: createDiagnostic('NODE_VERSION_UNSUPPORTED'),
      };
    }
    return { name: 'node', status: 'ok', detail: trimmed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'command failed';
    return {
      name: 'node',
      status: 'fail',
      detail: truncate(reason),
      diagnostic: createDiagnostic('NODE_VERSION_UNSUPPORTED'),
    };
  }
}

async function dockerDaemonCheck(probe: DoctorProbes): Promise<DoctorCheck> {
  try {
    const { stdout } = await probe.execFile('docker', ['info', '--format', '{{.ServerVersion}}']);
    const version = stdout.trim();
    return {
      name: 'docker daemon',
      status: 'ok',
      detail: version.length > 0 ? `server ${truncate(version)}` : 'reachable',
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'command failed';
    return {
      name: 'docker daemon',
      status: 'fail',
      detail: truncate(reason),
      diagnostic: createDiagnostic('DOCKER_DAEMON_UNAVAILABLE'),
    };
  }
}

function testcontainersCheck(dockerDaemon: DoctorCheck): DoctorCheck {
  if (dockerDaemon.status === 'ok') {
    return {
      name: 'testcontainers',
      status: 'ok',
      detail: 'Docker daemon reachable for PostgreSQL/Testcontainers lanes',
    };
  }
  return {
    name: 'testcontainers',
    status: 'fail',
    detail: 'Docker daemon unavailable for PostgreSQL/Testcontainers lanes',
  };
}

function testTierChecks(
  node: DoctorCheck,
  pnpm: DoctorCheck,
  cargo: DoctorCheck,
  dockerDaemon: DoctorCheck,
  environmentChecks: readonly DoctorCheck[],
): DoctorCheck[] {
  const unitBlocker = [node, pnpm].find((check) => check.status !== 'ok');
  const unit: DoctorCheck =
    unitBlocker === undefined
      ? {
          name: 'test:unit',
          status: 'ok',
          detail: 'runnable: pnpm test:unit',
        }
      : {
          name: 'test:unit',
          status: 'fail',
          detail: `blocked: ${unitBlocker.name} ${unitBlocker.detail}`,
        };
  if (unitBlocker !== undefined) {
    return [
      unit,
      {
        name: 'test:integration',
        status: 'fail',
        detail: `blocked: ${unitBlocker.name} ${unitBlocker.detail}`,
      },
      {
        name: 'test:funded',
        status: 'fail',
        detail: `blocked: ${unitBlocker.name} ${unitBlocker.detail}`,
      },
    ];
  }
  if (dockerDaemon.status !== 'ok') {
    return [
      unit,
      {
        name: 'test:integration',
        status: 'warn',
        detail: 'skipped: Docker daemon unavailable; run pnpm test:unit',
      },
      {
        name: 'test:funded',
        status: 'fail',
        detail: 'blocked: Docker daemon unavailable',
      },
    ];
  }
  const blockedEnvironment = environmentChecks.find(
    (check) =>
      (REQUIRED_ENV_VARS as readonly string[]).includes(check.name) && check.status !== 'ok',
  );
  const fundedBlocker = cargo.status === 'ok' ? blockedEnvironment : cargo;
  return [
    unit,
    {
      name: 'test:integration',
      status: 'ok',
      detail: 'runnable: pnpm test:integration',
    },
    fundedBlocker
      ? {
          name: 'test:funded',
          status: 'fail',
          detail: `blocked: ${fundedBlocker.name} ${fundedBlocker.detail}`,
        }
      : {
          name: 'test:funded',
          status: 'ok',
          detail: 'runnable: pnpm test:funded',
        },
  ];
}

async function portChecks(
  probe: DoctorProbes,
  ports: readonly { readonly label: string; readonly port: number }[],
  conflictStatus: 'warn' | 'fail',
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const { label, port } of ports) {
    const free = await probe.isPortFree('127.0.0.1', port);
    checks.push({
      name: `port ${port} (${label})`,
      status: free ? 'ok' : conflictStatus,
      detail: free ? 'free' : 'in use (stop any running lab stack before funded lanes)',
      ...(free ? {} : { diagnostic: createDiagnostic('PORT_IN_USE') }),
    });
  }
  return checks;
}

export async function runDoctor(
  probes: DoctorProbes,
  options: {
    readonly ports?: readonly { readonly label: string; readonly port: number }[];
    readonly environment?: boolean;
    readonly senderDurability?: boolean;
    readonly cargo?: boolean;
    readonly testTiers?: boolean;
    readonly portConflict?: 'warn' | 'fail';
  } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const environmentChecks = options.environment === false ? [] : envCheck(probes.env);
  checks.push(...environmentChecks);
  if (options.senderDurability !== false) {
    checks.push(senderDurabilityEnvCheck(probes.env));
  }
  const node = await nodeVersionCheck(probes);
  checks.push(node);
  const pnpm = await versionCheck(probes, 'pnpm', ['--version'], /^\d+\.\d+\.\d+$/, 'pnpm');
  checks.push(pnpm);
  const docker = await versionCheck(
    probes,
    'docker',
    ['--version'],
    /^Docker version \d+\.\d+/,
    'docker',
  );
  checks.push(
    docker.status === 'fail'
      ? { ...docker, diagnostic: createDiagnostic('DOCKER_NOT_INSTALLED') }
      : docker,
  );
  const dockerDaemon = await dockerDaemonCheck(probes);
  checks.push(dockerDaemon);
  checks.push(testcontainersCheck(dockerDaemon));
  const cargo =
    options.cargo === false
      ? { name: 'cargo (CDK adapter)', status: 'ok' as const, detail: 'skipped for startup' }
      : await versionCheck(
          probes,
          'cargo',
          ['--version'],
          /^cargo \d+\.\d+/,
          'cargo (CDK adapter)',
        );
  if (options.cargo !== false) checks.push(cargo);
  if (options.testTiers !== false) {
    checks.push(...testTierChecks(node, pnpm, cargo, dockerDaemon, environmentChecks));
  }
  checks.push(
    ...(await portChecks(probes, options.ports ?? DEFAULT_PORTS, options.portConflict ?? 'warn')),
  );
  return { checks, ok: checks.every((check) => check.status !== 'fail') };
}

const DEFAULT_PROBES: DoctorProbes = {
  env: process.env,
  execFile: (command, args) =>
    execFileAsync(command, [...args], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    }),
  isPortFree: (host, port) =>
    new Promise<boolean>((resolve) => {
      const socket = new Socket();
      socket.setTimeout(500);
      socket.once('connect', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(true);
      });
      socket.connect(port, host);
    }),
};

export function defaultDoctorProbes(): DoctorProbes {
  return {
    env: DEFAULT_PROBES.env,
    execFile: DEFAULT_PROBES.execFile,
    isPortFree: DEFAULT_PROBES.isPortFree,
  };
}
