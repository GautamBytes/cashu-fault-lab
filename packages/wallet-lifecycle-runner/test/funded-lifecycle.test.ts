import { MintQuoteState, Wallet, getEncodedToken } from '@cashu/cashu-ts';
import {
  HttpLifecycleAdapterClient,
  type LifecycleOperationInput,
  type LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const enabled = process.env.CFL_WALLET_LIFECYCLE_E2E === '1';
const composeFile = new URL('../../../infra/compose/wallet-lifecycle.compose.yml', import.meta.url)
  .pathname;
const lifecycleMintUrl = 'http://127.0.0.1:4300';

interface Lane {
  readonly id: string;
  readonly service: string;
  readonly adapterUrl: string;
  readonly token: string;
  readonly gatewayUrl: string;
  readonly publicMintUrl: string;
}

const lanes: readonly Lane[] = [
  {
    id: 'cashu-ts-nutshell',
    service: 'cashu-ts-nutshell',
    adapterUrl: 'http://127.0.0.1:4111',
    token: 'lifecycle-cashu-ts-token',
    gatewayUrl: 'http://127.0.0.1:4311',
    publicMintUrl: 'http://127.0.0.1:3338',
  },
  {
    id: 'cashu-ts-mintd',
    service: 'cashu-ts-mintd',
    adapterUrl: 'http://127.0.0.1:4112',
    token: 'lifecycle-cashu-ts-token',
    gatewayUrl: 'http://127.0.0.1:4312',
    publicMintUrl: 'http://127.0.0.1:8085',
  },
  {
    id: 'cdk-nutshell',
    service: 'cdk-nutshell',
    adapterUrl: 'http://127.0.0.1:4121',
    token: 'lifecycle-cdk-token',
    gatewayUrl: 'http://127.0.0.1:4311',
    publicMintUrl: 'http://127.0.0.1:3338',
  },
  {
    id: 'cdk-mintd',
    service: 'cdk-mintd',
    adapterUrl: 'http://127.0.0.1:4122',
    token: 'lifecycle-cdk-token',
    gatewayUrl: 'http://127.0.0.1:4312',
    publicMintUrl: 'http://127.0.0.1:8085',
  },
];

function operationId(lane: Lane, operation: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/funded-lifecycle-operation/v1\0')
    .update(lane.id)
    .update('\0')
    .update(operation)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

function adapter(lane: Lane): HttpLifecycleAdapterClient {
  return new HttpLifecycleAdapterClient({
    baseUrl: lane.adapterUrl,
    token: lane.token,
    timeoutMs: 15_000,
  });
}

async function converge(
  client: HttpLifecycleAdapterClient,
  initial: LifecycleOperationView,
): Promise<LifecycleOperationView> {
  let view = initial;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (['succeeded', 'failed_definitive', 'recovery_blocked'].includes(view.phase)) return view;
    await new Promise((resolve) => setTimeout(resolve, 100));
    view = await client.resume(view.operationId);
  }
  throw new Error('Lifecycle operation did not converge');
}

async function run(
  client: HttpLifecycleAdapterClient,
  input: LifecycleOperationInput,
): Promise<LifecycleOperationView> {
  let initial: LifecycleOperationView;
  try {
    initial = await client.start(input);
  } catch {
    // A committed mint response can be lost or rejected by the adapter after durable dispatch.
    // Recover only when the operation journal proves that the same identity was persisted.
    initial = await client.operation(input.operationId);
  }
  const view = await converge(client, initial);
  expect(view).toMatchObject({
    operationId: input.operationId,
    kind: input.kind,
    phase: 'succeeded',
  });
  return view;
}

async function restart(lane: Lane): Promise<void> {
  const docker =
    process.env.CFL_DOCKER_BIN ??
    (process.platform === 'darwin' ? '/usr/local/bin/docker' : 'docker');
  await execFileAsync(docker, ['compose', '-f', composeFile, 'restart', lane.service], {
    env: {
      ...process.env,
      CFL_HTTP_FAULT_GATEWAY_TOKEN: 'lifecycle-fault-token',
      CFL_LIFECYCLE_CASHU_TS_TOKEN: 'lifecycle-cashu-ts-token',
      CFL_LIFECYCLE_CDK_TOKEN: 'lifecycle-cdk-token',
    },
    timeout: 30_000,
  });
  const client = adapter(lane);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.capabilities();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Lifecycle adapter ${lane.id} did not restart`);
}

async function fixtureToken(lane: Lane, amount: number): Promise<string> {
  const seed = createHash('sha512')
    .update('cashu-fault-lab/funded-lifecycle-fixture/v1\0')
    .update(lane.id)
    .digest();
  const wallet = new Wallet(lane.publicMintUrl, { unit: 'sat', bip39seed: seed });
  await wallet.loadMint();
  let quote = await wallet.createMintQuoteBolt11(amount, 'cashu-fault-lab receive fixture');
  for (let attempt = 0; quote.state !== MintQuoteState.PAID && attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    quote = await wallet.checkMintQuoteBolt11(quote);
  }
  if (quote.state !== MintQuoteState.PAID) throw new Error('Receive fixture quote was not paid');
  const proofs = await wallet.mintProofsBolt11(amount, quote, undefined, { type: 'random' });
  return getEncodedToken({ mint: lifecycleMintUrl, unit: 'sat', proofs });
}

async function clearFaults(lane: Lane): Promise<void> {
  const response = await fetch(`${lane.gatewayUrl}/__faults/v1/rules`, {
    method: 'DELETE',
    redirect: 'manual',
    headers: { authorization: 'Bearer lifecycle-fault-token' },
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Lifecycle gateway rejected fault reset');
}

afterEach(async () => {
  if (!enabled) return;
  await Promise.all(lanes.map(clearFaults));
});

describe.skipIf(!enabled)('funded wallet lifecycle matrix', () => {
  for (const lane of lanes) {
    it(`${lane.id} converges mint, swap, send, receive, restore, reconcile, and restart`, async () => {
      const client = adapter(lane);
      await clearFaults(lane);
      await client.reset('wallet-lifecycle-funded');
      const capabilities = await client.capabilities();
      expect(capabilities.operations).toEqual(
        expect.arrayContaining(['mint', 'swap', 'send', 'receive', 'restore', 'reconcile']),
      );

      await run(client, {
        operationId: operationId(lane, 'mint'),
        kind: 'mint',
        mint: lifecycleMintUrl,
        unit: 'sat',
        amount: 64,
        method: 'bolt11',
      });
      await run(client, {
        operationId: operationId(lane, 'swap'),
        kind: 'swap',
        mint: lifecycleMintUrl,
        unit: 'sat',
        amount: 16,
      });
      await run(client, {
        operationId: operationId(lane, 'send'),
        kind: 'send',
        mint: lifecycleMintUrl,
        unit: 'sat',
        amount: 8,
        recipient: `fixture-${lane.id}`,
      });

      const beforeRestart = await client.wallet();
      await restart(lane);
      const restarted = adapter(lane);
      expect(await restarted.wallet()).toEqual(beforeRestart);

      const token = await fixtureToken(lane, 8);
      await run(restarted, {
        operationId: operationId(lane, 'receive'),
        kind: 'receive',
        mint: lifecycleMintUrl,
        unit: 'sat',
        token,
      });
      await run(restarted, {
        operationId: operationId(lane, 'restore'),
        kind: 'restore',
        mint: lifecycleMintUrl,
        unit: 'sat',
      });
      await run(restarted, {
        operationId: operationId(lane, 'reconcile'),
        kind: 'reconcile',
        mint: lifecycleMintUrl,
        unit: 'sat',
        targetOperationId: operationId(lane, 'send'),
      });

      const wallet = await restarted.wallet();
      expect(wallet.balances.available).toBeGreaterThan(0);
      expect(wallet.balances.reserved).toBe(0);
      const evidence = await restarted.evidence();
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toMatch(/cashu[AB][A-Za-z0-9_-]+/u);
      expect(serialized).not.toContain(token);
    }, 120_000);
  }
});
