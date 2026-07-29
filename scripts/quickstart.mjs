import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const quickstartDemoArguments = [
  'pnpm',
  'lab',
  'demo',
  '--seed',
  'cashu-fault-lab-v0.1.0-quickstart',
  '--artifact',
  'artifacts/quickstart.json',
  '--report',
  'artifacts/quickstart.html',
];

class QuickstartCommandError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'QuickstartCommandError';
    this.exitCode = exitCode;
  }
}

export function parseQuickstartArgs(argv) {
  const options = {
    checkOnly: false,
    skipInstall: false,
  };

  for (const argument of argv) {
    if (argument === '--check') {
      options.checkOnly = true;
    } else if (argument === '--skip-install') {
      options.skipInstall = true;
    } else {
      throw new Error(`Unknown quickstart option: ${argument}`);
    }
  }

  return options;
}

export function assertSupportedNodeVersion(version) {
  const major = /^v?(\d+)\./u.exec(version)?.[1];
  if (major !== '24') {
    throw new Error(`Node.js 24 is required; found ${version}`);
  }
}

export function exitCodeForQuickstartError(error) {
  return error instanceof QuickstartCommandError ? error.exitCode : 1;
}

export function executeCommand(file, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      stdio: options.quiet ? 'ignore' : 'inherit',
    });

    child.once('error', (error) => {
      const errorCode =
        error !== null && typeof error === 'object' && 'code' in error ? ` (${error.code})` : '';
      rejectCommand(new QuickstartCommandError(`Unable to run ${file}${errorCode}`));
    });
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }
      const outcome = code === null ? `signal ${signal ?? 'unknown'}` : `exit ${code}`;
      rejectCommand(
        new QuickstartCommandError(
          `Command failed (${outcome}): ${file} ${args.join(' ')}`,
          code ?? 1,
        ),
      );
    });
  });
}

export async function runQuickstart({
  checkOnly,
  skipInstall,
  nodeVersion,
  repositoryRoot,
  runCommand = executeCommand,
  stdout = (message) => process.stdout.write(message),
}) {
  assertSupportedNodeVersion(nodeVersion);
  stdout(`✓ Node.js ${nodeVersion.replace(/^v/u, '')}\n`);

  try {
    await runCommand('docker', ['--version'], { cwd: repositoryRoot, quiet: true });
  } catch {
    throw new Error('Docker CLI is required; install Docker Desktop or Docker Engine, then retry.');
  }

  try {
    await runCommand('docker', ['info', '--format', '{{.ServerVersion}}'], {
      cwd: repositoryRoot,
      quiet: true,
    });
  } catch {
    throw new Error('Docker daemon is unavailable; start Docker, then retry.');
  }
  stdout('✓ Docker is ready\n');

  if (checkOnly) {
    stdout('✓ Cashu Fault Lab prerequisites are ready\n');
    return;
  }

  if (!skipInstall) {
    stdout('→ Installing the frozen workspace\n');
    await runCommand('corepack', ['pnpm', 'install', '--frozen-lockfile'], {
      cwd: repositoryRoot,
      quiet: false,
    });
  }

  stdout('→ Building Cashu Fault Lab\n');
  await runCommand('corepack', ['pnpm', 'build'], {
    cwd: repositoryRoot,
    quiet: false,
  });

  stdout('→ Running the deterministic response-loss demo\n');
  await runCommand('corepack', quickstartDemoArguments, {
    cwd: repositoryRoot,
    quiet: false,
  });
  stdout('✓ Demo passed\n');
  stdout('  JSON: artifacts/quickstart.json\n');
  stdout('  HTML: artifacts/quickstart.html\n');
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  try {
    const options = parseQuickstartArgs(process.argv.slice(2));
    await runQuickstart({
      ...options,
      nodeVersion: process.version,
      repositoryRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown quickstart failure';
    process.stderr.write(`quickstart: ${message}\n`);
    process.exitCode = exitCodeForQuickstartError(error);
  }
}
