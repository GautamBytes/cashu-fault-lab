import { execFile } from 'node:child_process';
import { Socket } from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly detail: string;
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
] as const;

const OPTIONAL_ENV_VARS = ['CFL_HTTP_FAULT_GATEWAY_URL', 'CFL_REAL_MINT_URL'] as const;

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
      };
    }
    return { name: 'node', status: 'ok', detail: trimmed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'command failed';
    return { name: 'node', status: 'fail', detail: truncate(reason) };
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
    return { name: 'docker daemon', status: 'fail', detail: truncate(reason) };
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

async function portChecks(
  probe: DoctorProbes,
  ports: readonly { readonly label: string; readonly port: number }[],
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const { label, port } of ports) {
    const free = await probe.isPortFree('127.0.0.1', port);
    checks.push({
      name: `port ${port} (${label})`,
      status: free ? 'ok' : 'warn',
      detail: free ? 'free' : 'in use (stop any running lab stack before funded lanes)',
    });
  }
  return checks;
}

export async function runDoctor(
  probes: DoctorProbes,
  options: { readonly ports?: readonly { readonly label: string; readonly port: number }[] } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  checks.push(...envCheck(probes.env));
  checks.push(senderDurabilityEnvCheck(probes.env));
  checks.push(await nodeVersionCheck(probes));
  checks.push(await versionCheck(probes, 'pnpm', ['--version'], /^\d+\.\d+\.\d+$/, 'pnpm'));
  checks.push(
    await versionCheck(probes, 'docker', ['--version'], /^Docker version \d+\.\d+/, 'docker'),
  );
  const dockerDaemon = await dockerDaemonCheck(probes);
  checks.push(dockerDaemon);
  checks.push(testcontainersCheck(dockerDaemon));
  checks.push(
    await versionCheck(probes, 'cargo', ['--version'], /^cargo \d+\.\d+/, 'cargo (CDK adapter)'),
  );
  checks.push(...(await portChecks(probes, options.ports ?? DEFAULT_PORTS)));
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
