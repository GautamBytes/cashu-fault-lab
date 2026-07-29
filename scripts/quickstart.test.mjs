import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSupportedNodeVersion,
  executeCommand,
  exitCodeForQuickstartError,
  parseQuickstartArgs,
  runQuickstart,
} from './quickstart.mjs';

describe('developer quickstart', () => {
  it('parses check and skip-install modes', () => {
    assert.deepEqual(parseQuickstartArgs(['--check', '--skip-install']), {
      checkOnly: true,
      skipInstall: true,
    });
    assert.throws(() => parseQuickstartArgs(['--unknown']), /Unknown quickstart option/);
  });

  it('requires Node.js 24', () => {
    assert.doesNotThrow(() => assertSupportedNodeVersion('v24.14.1'));
    assert.throws(() => assertSupportedNodeVersion('v22.18.0'), /Node.js 24 is required/);
  });

  it('runs preflight, frozen install, build, and the deterministic demo in order', async () => {
    const commands = [];

    await runQuickstart({
      checkOnly: false,
      skipInstall: false,
      nodeVersion: 'v24.14.1',
      repositoryRoot: '/repo',
      stdout: () => {},
      runCommand: async (file, args, options) => {
        commands.push([file, args, options]);
      },
    });

    assert.deepEqual(
      commands.map(([file, args]) => [file, args]),
      [
        ['docker', ['--version']],
        ['docker', ['info', '--format', '{{.ServerVersion}}']],
        ['corepack', ['pnpm', 'install', '--frozen-lockfile']],
        ['corepack', ['pnpm', 'build']],
        [
          'corepack',
          [
            'pnpm',
            'lab',
            'demo',
            '--seed',
            'cashu-fault-lab-v0.1.0-quickstart',
            '--artifact',
            'artifacts/quickstart.json',
            '--report',
            'artifacts/quickstart.html',
          ],
        ],
      ],
    );
    assert.equal(
      commands.every(([, , options]) => options.cwd === '/repo'),
      true,
    );
  });

  it('supports non-mutating prerequisite checks', async () => {
    const commands = [];
    const output = [];

    await runQuickstart({
      checkOnly: true,
      skipInstall: false,
      nodeVersion: 'v24.14.1',
      repositoryRoot: '/repo',
      stdout: (message) => output.push(message),
      runCommand: async (file, args) => {
        commands.push([file, args]);
      },
    });

    assert.deepEqual(commands, [
      ['docker', ['--version']],
      ['docker', ['info', '--format', '{{.ServerVersion}}']],
    ]);
    assert.match(output.join(''), /prerequisites are ready/i);
  });

  it('can reuse an existing frozen install', async () => {
    const commands = [];

    await runQuickstart({
      checkOnly: false,
      skipInstall: true,
      nodeVersion: 'v24.14.1',
      repositoryRoot: '/repo',
      stdout: () => {},
      runCommand: async (file, args) => {
        commands.push([file, args]);
      },
    });

    assert.equal(
      commands.some(([file, args]) => file === 'corepack' && args.includes('install')),
      false,
    );
    assert.deepEqual(commands.at(-1)?.slice(0, 2), [
      'corepack',
      [
        'pnpm',
        'lab',
        'demo',
        '--seed',
        'cashu-fault-lab-v0.1.0-quickstart',
        '--artifact',
        'artifacts/quickstart.json',
        '--report',
        'artifacts/quickstart.html',
      ],
    ]);
  });

  it('reports an unavailable Docker daemon before mutating the workspace', async () => {
    const commands = [];

    await assert.rejects(
      runQuickstart({
        checkOnly: false,
        skipInstall: false,
        nodeVersion: 'v24.14.1',
        repositoryRoot: '/repo',
        stdout: () => {},
        runCommand: async (file, args) => {
          commands.push([file, args]);
          if (file === 'docker' && args[0] === 'info') {
            throw new Error('command failed');
          }
        },
      }),
      /Docker daemon is unavailable.*start Docker/iu,
    );

    assert.deepEqual(commands, [
      ['docker', ['--version']],
      ['docker', ['info', '--format', '{{.ServerVersion}}']],
    ]);
  });

  it('preserves a failed child command exit status', async () => {
    await assert.rejects(
      executeCommand(process.execPath, ['-e', 'process.exit(42)'], {
        cwd: process.cwd(),
        quiet: true,
      }),
      (error) => {
        assert.match(error.message, /Command failed \(exit 42\)/u);
        assert.equal(exitCodeForQuickstartError(error), 42);
        return true;
      },
    );

    assert.equal(exitCodeForQuickstartError(new Error('unclassified failure')), 1);
  });
});
