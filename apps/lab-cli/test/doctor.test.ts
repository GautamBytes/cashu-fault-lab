import { describe, expect, it } from 'vitest';
import { runDoctor, type DoctorProbes } from '../src/doctor.js';

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    env: {},
    execFile: async () => ({ stdout: '', stderr: '' }),
    isPortFree: async () => true,
    ...overrides,
  };
}

const healthyEnv: Readonly<Record<string, string | undefined>> = {
  CFL_CASHU_TS_TOKEN: 'lab-only-cashu-ts-token',
  CFL_CDK_TOKEN: 'lab-only-cdk-token',
  CFL_REFERENCE_RECEIVER_TOKEN: 'lab-only-receiver-token',
  CFL_REFERENCE_RECEIVER_CLAIM_KEY: 'ERERERERERERERERERERERERERERERERERERERERERE',
  CFL_HTTP_FAULT_GATEWAY_TOKEN: 'lab-only-fault-token',
  CFL_HTTP_FAULT_GATEWAY_URL: 'http://127.0.0.1:4300',
  CFL_REAL_MINT_URL: 'http://127.0.0.1:3338',
};

const toolVersions: Readonly<Record<string, { readonly stdout: string; readonly stderr: string }>> =
  {
    node: { stdout: 'v24.0.0\n', stderr: '' },
    pnpm: { stdout: '11.15.0\n', stderr: '' },
    docker: { stdout: 'Docker version 27.0.0, build abc\n', stderr: '' },
    cargo: { stdout: 'cargo 1.97.0 (abc)\n', stderr: '' },
  };

function healthyExec(
  table: Readonly<
    Record<string, { readonly stdout: string; readonly stderr: string }>
  > = toolVersions,
): DoctorProbes['execFile'] {
  return async (command, args) => {
    const entry = table[`${command} ${args.join(' ')}`] ?? table[command];
    if (!entry) throw new Error(`${command}: command not found`);
    return entry;
  };
}

describe('runDoctor', () => {
  it('reports ok when env, tools, and ports are all healthy', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.name === 'node' && c.status === 'ok')).toBe(true);
    expect(report.checks.some((c) => c.name === 'docker' && c.status === 'ok')).toBe(true);
    expect(report.checks.some((c) => c.name === 'cargo (CDK adapter)' && c.status === 'ok')).toBe(
      true,
    );
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  });

  it('reports the exact runnable test commands when Docker is healthy', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    expect(report.checks).toContainEqual({
      name: 'test:unit',
      status: 'ok',
      detail: 'runnable: pnpm test:unit',
    });
    expect(report.checks).toContainEqual({
      name: 'test:integration',
      status: 'ok',
      detail: 'runnable: pnpm test:integration',
    });
    expect(report.checks).toContainEqual({
      name: 'test:funded',
      status: 'ok',
      detail: 'runnable: pnpm test:funded',
    });
  });

  it('blocks funded tests when the real mint URL is missing', async () => {
    const { CFL_REAL_MINT_URL: _missing, ...env } = healthyEnv;
    const report = await runDoctor({
      env,
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    expect(report.checks).toContainEqual({
      name: 'CFL_REAL_MINT_URL',
      status: 'fail',
      detail: 'missing',
    });
    expect(report.checks).toContainEqual({
      name: 'test:funded',
      status: 'fail',
      detail: 'blocked: CFL_REAL_MINT_URL missing',
    });
  });

  it('fails when required env vars are missing', async () => {
    const report = await runDoctor({
      env: {},
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    expect(report.ok).toBe(false);
    const missing = report.checks.filter((c) => c.status === 'fail' && c.detail === 'missing');
    expect(missing.length).toBeGreaterThanOrEqual(5);
  });

  it('warns when a required token looks like a placeholder', async () => {
    const report = await runDoctor({
      env: { ...healthyEnv, CFL_CASHU_TS_TOKEN: 'x' },
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    const tokenCheck = report.checks.find((c) => c.name === 'CFL_CASHU_TS_TOKEN');
    expect(tokenCheck?.status).toBe('warn');
    expect(tokenCheck?.detail).toMatch(/placeholder/);
  });

  it('fails tool checks when the binary is not on PATH', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: async (command) => {
        throw new Error(`${command}: not found`);
      },
      isPortFree: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: 'docker',
      status: 'fail',
      detail: 'docker: not found',
      diagnostic: expect.objectContaining({
        code: 'DOCKER_NOT_INSTALLED',
        nextCommand: 'docker --version',
      }),
    });
    expect(report.checks.some((c) => c.name === 'cargo (CDK adapter)' && c.status === 'fail')).toBe(
      true,
    );
  });

  it('warns (not fails) when a default port is already in use', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: healthyExec(),
      isPortFree: async (_host, port) => port !== 4300,
    });

    expect(report.ok).toBe(true);
    const gateway = report.checks.find((c) => c.name === 'port 4300 (http-fault-gateway)');
    expect(gateway?.status).toBe('warn');
    expect(gateway?.detail).toMatch(/in use/);
  });

  it('honors a custom port list', async () => {
    const report = await runDoctor(
      {
        env: healthyEnv,
        execFile: healthyExec(),
        isPortFree: async () => false,
      },
      { ports: [{ label: 'custom', port: 9999 }] },
    );

    expect(report.checks.some((c) => c.name === 'port 9999 (custom)')).toBe(true);
    expect(report.checks.some((c) => c.name === 'port 4300 (http-fault-gateway)')).toBe(false);
  });

  it('rejects tokens containing newlines', async () => {
    const report = await runDoctor({
      env: { ...healthyEnv, CFL_CDK_TOKEN: 'bad\nvalue' },
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    const cdk = report.checks.find((c) => c.name === 'CFL_CDK_TOKEN');
    expect(cdk?.status).toBe('fail');
    expect(cdk?.detail).toMatch(/newline/);
  });

  it('warns on unexpected tool version strings', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: healthyExec({
        ...toolVersions,
        node: { stdout: 'garbage\n', stderr: '' },
      }),
      isPortFree: async () => true,
    });

    const nodeCheck = report.checks.find((c) => c.name === 'node');
    expect(nodeCheck?.status).toBe('warn');
  });

  it('fails when Node is outside the supported 24.x engine range', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: healthyExec({
        ...toolVersions,
        node: { stdout: 'v22.18.0\n', stderr: '' },
      }),
      isPortFree: async () => true,
    });

    const nodeCheck = report.checks.find((c) => c.name === 'node');
    expect(report.ok).toBe(false);
    expect(nodeCheck?.status).toBe('fail');
    expect(nodeCheck?.detail).toMatch(/requires Node 24/);
    expect(report.checks).toContainEqual({
      name: 'test:unit',
      status: 'fail',
      detail: 'blocked: node requires Node 24.x; found v22.18.0',
    });
    expect(nodeCheck?.diagnostic).toMatchObject({
      code: 'NODE_VERSION_UNSUPPORTED',
      problem: expect.stringContaining('Node.js'),
      likelyCause: expect.any(String),
      remediation: expect.any(String),
      nextCommand: 'node --version',
    });
  });

  it('fails Docker-dependent readiness when the daemon is unreachable', async () => {
    const report = await runDoctor({
      env: healthyEnv,
      execFile: async (command, args) => {
        if (command === 'docker' && args[0] === 'info') throw new Error('daemon unavailable');
        return healthyExec()(command, args);
      },
      isPortFree: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: 'docker daemon',
      status: 'fail',
      detail: 'daemon unavailable',
      diagnostic: expect.objectContaining({
        code: 'DOCKER_DAEMON_UNAVAILABLE',
        nextCommand: 'docker info',
      }),
    });
    expect(report.checks).toContainEqual({
      name: 'testcontainers',
      status: 'fail',
      detail: 'Docker daemon unavailable for PostgreSQL/Testcontainers lanes',
    });
    expect(report.checks).toContainEqual({
      name: 'test:unit',
      status: 'ok',
      detail: 'runnable: pnpm test:unit',
    });
    expect(report.checks).toContainEqual({
      name: 'test:integration',
      status: 'warn',
      detail: 'skipped: Docker daemon unavailable; run pnpm test:unit',
    });
    expect(report.checks).toContainEqual({
      name: 'test:funded',
      status: 'fail',
      detail: 'blocked: Docker daemon unavailable',
    });
  });

  it('reports cashu-ts sender durability readiness from explicit PostgreSQL key config', async () => {
    const stateKey = Buffer.alloc(32, 4).toString('base64url');
    const report = await runDoctor({
      env: {
        ...healthyEnv,
        CFL_CASHU_TS_SENDER_DATABASE_URL: 'postgresql://cashu:cashu@127.0.0.1:5432/lab',
        CFL_CASHU_TS_SENDER_RUN_ID: 'run-1',
        CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION: '1',
        CFL_CASHU_TS_SENDER_STATE_KEYS: `1:${stateKey}`,
      },
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    expect(report.checks).toContainEqual({
      name: 'cashu-ts sender durability',
      status: 'ok',
      detail: 'PostgreSQL sender state configured for run run-1',
    });
  });

  it('fails cashu-ts sender durability when PostgreSQL mode is partially configured', async () => {
    const report = await runDoctor({
      env: {
        ...healthyEnv,
        CFL_CASHU_TS_SENDER_DATABASE_URL: 'postgresql://cashu:cashu@127.0.0.1:5432/lab',
      },
      execFile: healthyExec(),
      isPortFree: async () => true,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: 'cashu-ts sender durability',
      status: 'fail',
      detail: 'missing CFL_CASHU_TS_SENDER_RUN_ID',
    });
  });

  it('uses safe defaults when called without probes', async () => {
    const probesDefault = probes();
    expect(probesDefault.env).toEqual({});
  });
});
