import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const REFERENCE_RUNTIME_ENV_PATH = join(
  '.cashu-fault-lab',
  'runtime',
  'reference',
  'secrets.env',
);

export interface ReferenceRuntimeEnv {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
}

const REQUIRED_KEYS = [
  'CFL_REAL_MINT_URL',
  'CFL_CASHU_TS_TOKEN',
  'CFL_CDK_TOKEN',
  'CFL_REFERENCE_RECEIVER_TOKEN',
  'CFL_REFERENCE_RECEIVER_CLAIM_KEY',
  'CFL_HTTP_FAULT_GATEWAY_TOKEN',
  'CFL_HTTP_FAULT_GATEWAY_URL',
  'CFL_POSTGRES_PASSWORD',
  'CFL_CASHU_TS_CLAIM_KEY',
  'CFL_CASHU_TS_NOSTR_RECEIVER_KEY',
  'CFL_CASHU_TS_NOSTR_SENDER_KEY',
  'CFL_CASHU_TS_RECEIVER_STATE_KEY',
  'CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION',
  'CFL_CASHU_TS_SENDER_RUN_ID',
  'CFL_CASHU_TS_SENDER_STATE_KEYS',
  'CFL_WALLET_FUNDING_AMOUNT',
] as const;

function token(): string {
  return `cfl_${randomBytes(24).toString('base64url')}`;
}

function key(): string {
  return randomBytes(32).toString('base64url');
}

function parseEnv(contents: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of contents.split(/\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    env[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return env;
}

function formatEnv(env: Readonly<Record<string, string>>): string {
  return `${REQUIRED_KEYS.map((keyName) => `${keyName}=${env[keyName] ?? ''}`).join('\n')}\n`;
}

function generatedDefaults(): Record<string, string> {
  const senderStateKey = key();
  return {
    CFL_REAL_MINT_URL: 'http://127.0.0.1:3338',
    CFL_CASHU_TS_TOKEN: token(),
    CFL_CDK_TOKEN: token(),
    CFL_REFERENCE_RECEIVER_TOKEN: token(),
    CFL_REFERENCE_RECEIVER_CLAIM_KEY: key(),
    CFL_HTTP_FAULT_GATEWAY_TOKEN: token(),
    CFL_HTTP_FAULT_GATEWAY_URL: 'http://127.0.0.1:4300',
    CFL_POSTGRES_PASSWORD: token(),
    CFL_CASHU_TS_CLAIM_KEY: key(),
    CFL_CASHU_TS_NOSTR_RECEIVER_KEY: key(),
    CFL_CASHU_TS_NOSTR_SENDER_KEY: key(),
    CFL_CASHU_TS_RECEIVER_STATE_KEY: key(),
    CFL_CASHU_TS_SENDER_ACTIVE_KEY_VERSION: '1',
    CFL_CASHU_TS_SENDER_RUN_ID: `cashu-ts-local-${randomBytes(6).toString('hex')}`,
    CFL_CASHU_TS_SENDER_STATE_KEYS: `1:${senderStateKey}`,
    CFL_WALLET_FUNDING_AMOUNT: '64',
  };
}

export async function ensureReferenceRuntimeEnv(root: string): Promise<ReferenceRuntimeEnv> {
  const path = join(root, REFERENCE_RUNTIME_ENV_PATH);
  let existing: Record<string, string> = {};
  try {
    existing = parseEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  const env = { ...generatedDefaults(), ...existing };
  const missing = REQUIRED_KEYS.filter(
    (keyName) => env[keyName] === undefined || env[keyName] === '',
  );
  if (missing.length > 0) {
    throw new Error(`Generated runtime environment is missing ${missing.join(', ')}`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, formatEnv(env), { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
  const mode = (await stat(path)).mode & 0o777;
  if (mode !== 0o600) throw new Error('Generated runtime environment permissions are not private');
  return { path, env };
}
