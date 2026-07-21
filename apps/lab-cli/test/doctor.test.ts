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
  return async (command) => {
    const entry = table[command];
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
    expect(report.checks.some((c) => c.name === 'docker' && c.status === 'fail')).toBe(true);
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

  it('uses safe defaults when called without probes', async () => {
    const probesDefault = probes();
    expect(probesDefault.env).toEqual({});
  });
});
