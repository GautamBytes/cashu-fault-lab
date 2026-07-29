import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = new URL('../', import.meta.url);
const packageRoot = new URL('../apps/npm-cli/', import.meta.url);
const npm = join(dirname(process.execPath), 'npm');

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

test('the packed CLI installs and works outside the monorepo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cashu-fault-lab-npm-'));
  const installRoot = join(directory, 'consumer');
  const fakeBin = join(directory, 'bin');
  const npmEnv = { ...process.env, npm_config_cache: join(directory, 'npm-cache') };
  const runPublishedDemo = process.env.CFL_NPM_E2E_DEMO === '1';
  let demoCleanup;

  try {
    const packed = await run(
      npm,
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        directory,
        fileURLToPath(packageRoot),
      ],
      { cwd: repositoryRoot, env: npmEnv },
    );
    assert.equal(packed.exitCode, 0, packed.stderr);
    const packResult = JSON.parse(packed.stdout)[0];
    const paths = packResult.files.map(({ path }) => path);
    assert.ok(paths.includes('LICENSE'));
    assert.ok(paths.includes('dist/bin.js'));
    assert.ok(paths.includes('runtime/scenarios/retry/response-lost.json'));
    assert.ok(paths.includes('runtime/compose/wallet-adapters.compose.yml'));
    assert.ok(paths.every((path) => !path.endsWith('.map')));
    assert.ok(paths.every((path) => !path.startsWith('src/')));
    assert.ok(paths.every((path) => !path.startsWith('node_modules/')));

    const tarball = join(directory, packResult.filename);
    await mkdir(installRoot, { recursive: true });
    const installed = await run(
      npm,
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball],
      { cwd: installRoot, env: npmEnv },
    );
    assert.equal(installed.exitCode, 0, installed.stderr);

    const executable = join(installRoot, 'node_modules', '.bin', 'cashu-fault-lab');
    assert.equal((await lstat(executable)).isSymbolicLink(), true);
    const cli = join(installRoot, 'node_modules', 'cashu-fault-lab', 'dist', 'bin.js');

    const version = await run(process.execPath, [cli, '--version'], { cwd: installRoot });
    assert.equal(version.exitCode, 0, version.stderr);
    assert.equal(version.stdout.trim(), '0.1.0');

    const scenarios = await run(process.execPath, [cli, 'ls', '--json'], { cwd: installRoot });
    assert.equal(scenarios.exitCode, 0, scenarios.stderr);
    assert.ok(JSON.parse(scenarios.stdout).some(({ path }) => path === 'retry/response-lost.json'));

    const inspected = await run(process.execPath, [cli, 'validate', 'retry/response-lost'], {
      cwd: installRoot,
    });
    assert.equal(inspected.exitCode, 0, inspected.stderr);
    assert.match(inspected.stdout, /^ok http-response-lost/u);

    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      join(fakeBin, 'docker'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Docker version 27.0.0, build test"; elif [ "$1" = "compose" ]; then echo "2.40.0"; else echo "27.0.0"; fi\n',
    );
    await chmod(join(fakeBin, 'docker'), 0o755);
    const doctor = await run(process.execPath, [cli, 'doctor', '--json'], {
      cwd: installRoot,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
    });
    assert.equal(doctor.exitCode, 0, doctor.stderr);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(doctorReport.ok, true);
    assert.ok(doctorReport.checks.every(({ name }) => name !== 'pnpm'));
    assert.ok(doctorReport.checks.every(({ name }) => name !== 'cargo (CDK adapter)'));
    assert.ok(
      doctorReport.checks.some(({ name, status }) => name === 'docker compose' && status === 'ok'),
    );

    const adapterRoot = join(directory, 'wallet-adapter');
    const initialized = await run(
      process.execPath,
      [
        cli,
        'adapter',
        'init',
        '--language',
        'typescript',
        '--name',
        'wallet-adapter',
        '--output',
        adapterRoot,
      ],
      { cwd: installRoot },
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    assert.match(
      await readFile(join(adapterRoot, 'adapter-manifest.json'), 'utf8'),
      /wallet-adapter/u,
    );

    if (runPublishedDemo) {
      const artifactPath = join(installRoot, 'demo.json');
      const reportPath = join(installRoot, 'demo.html');
      const composePath = join(
        installRoot,
        'node_modules',
        'cashu-fault-lab',
        'runtime',
        'compose',
        'wallet-adapters.compose.yml',
      );
      const envFile = join(installRoot, '.cashu-fault-lab', 'runtime', 'reference', 'secrets.env');
      demoCleanup = { composePath, envFile };
      const demo = await run(
        process.execPath,
        [
          cli,
          'demo',
          '--seed',
          'npm-publish-e2e',
          '--artifact',
          artifactPath,
          '--report',
          reportPath,
        ],
        { cwd: installRoot },
      );
      assert.equal(demo.exitCode, 0, `${demo.stdout}\n${demo.stderr}`);
      assert.match(demo.stdout, /demo passed seed=npm-publish-e2e/u);

      const artifact = await readFile(artifactPath, 'utf8');
      const report = await readFile(reportPath, 'utf8');
      assert.equal(JSON.parse(artifact).status, 'passed');
      assert.match(report, /npm-publish-e2e/u);
      const secretValues = (await readFile(envFile, 'utf8'))
        .split(/\n/u)
        .map((line) => line.slice(line.indexOf('=') + 1))
        .filter((value) => value.length >= 8 && !value.startsWith('http'));
      for (const secret of secretValues) {
        assert.equal(artifact.includes(secret), false, 'artifact contains a generated secret');
        assert.equal(report.includes(secret), false, 'report contains a generated secret');
      }

      for (const [resource, args] of [
        [
          'containers',
          [
            'ps',
            '-a',
            '--filter',
            'label=com.docker.compose.project=cashu-fault-lab-npm',
            '--format',
            '{{.ID}}',
          ],
        ],
        [
          'volumes',
          [
            'volume',
            'ls',
            '--filter',
            'label=com.docker.compose.project=cashu-fault-lab-npm',
            '--format',
            '{{.Name}}',
          ],
        ],
      ]) {
        const remaining = await run('docker', args, { cwd: installRoot });
        assert.equal(remaining.exitCode, 0, remaining.stderr);
        assert.equal(remaining.stdout.trim(), '', `demo left ${resource} behind`);
      }
    }
  } finally {
    if (demoCleanup !== undefined) {
      await run(
        'docker',
        [
          'compose',
          '--env-file',
          demoCleanup.envFile,
          '-f',
          demoCleanup.composePath,
          'down',
          '-v',
          '--remove-orphans',
        ],
        { cwd: installRoot },
      );
    }
    await rm(directory, { recursive: true, force: true });
  }
});
