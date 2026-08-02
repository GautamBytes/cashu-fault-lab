import { Wallet, getEncodedToken, MintQuoteState } from '@cashu/cashu-ts';
import {
  HttpLifecycleAdapterClient,
  type LifecycleOperationView,
} from '@cashu-fault-lab/wallet-lifecycle-contract';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const enabled = process.env.CFL_WALLET_LIFECYCLE_REGTEST === '1';
const composeFile = new URL('../../../infra/compose/lightning-regtest.compose.yml', import.meta.url)
  .pathname;
const docker =
  process.env.CFL_DOCKER_BIN ??
  (process.platform === 'darwin' ? '/usr/local/bin/docker' : 'docker');
const composeEnvironment = {
  ...process.env,
  CFL_LIGHTNING_PROBE_TOKEN: 'lifecycle-regtest-probe-token',
  CFL_HTTP_FAULT_GATEWAY_TOKEN: 'lifecycle-regtest-fault-token',
  CFL_LIFECYCLE_CASHU_TS_TOKEN: 'lifecycle-regtest-cashu-ts-token',
};
const publicMintUrl = 'http://127.0.0.1:3358';
const lifecycleMintUrl = 'http://127.0.0.1:4300';
const gatewayUrl = 'http://127.0.0.1:4341';

function parseJson(value: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Regtest command returned invalid JSON');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

async function composeExec(service: string, command: readonly string[]): Promise<string> {
  const result = await execFileAsync(
    docker,
    ['compose', '-f', composeFile, 'exec', '-T', service, ...command],
    { env: composeEnvironment, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return result.stdout.trim();
}

async function bitcoinCli(arguments_: readonly string[]): Promise<string> {
  return composeExec('bitcoind', [
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=regtest',
    '-rpcpassword=regtest-local-only',
    ...arguments_,
  ]);
}

async function lncli(service: 'lnd-mint' | 'lnd-sink', arguments_: readonly string[]) {
  return parseJson(await composeExec(service, ['lncli', '--network=regtest', ...arguments_]));
}

async function mine(blocks: number): Promise<void> {
  const address = await bitcoinCli(['-rpcwallet=regtest', 'getnewaddress']);
  await bitcoinCli(['-rpcwallet=regtest', 'generatetoaddress', String(blocks), address]);
}

async function waitForActiveChannel(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const channelSets = await Promise.all([
      lncli('lnd-sink', ['listchannels']),
      lncli('lnd-mint', ['listchannels']),
    ]);
    if (
      channelSets.every((result) => {
        const channels = Reflect.get(result, 'channels');
        return (
          Array.isArray(channels) &&
          channels.some(
            (channel) =>
              typeof channel === 'object' &&
              channel !== null &&
              Reflect.get(channel, 'active') === true,
          )
        );
      })
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Regtest Lightning channel did not activate');
}

async function waitForPeer(publicKey: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const peers = Reflect.get(await lncli('lnd-sink', ['listpeers']), 'peers');
      if (
        Array.isArray(peers) &&
        peers.some((peer) => Reflect.get(peer, 'pub_key') === publicKey)
      ) {
        return;
      }
      await lncli('lnd-sink', ['connect', `${publicKey}@lnd-mint:9735`]);
    } catch {
      // Peer gossip can lag container health; the next poll validates the connection.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Regtest LND sink did not connect to mint peer');
}

async function bootstrapRegtest(): Promise<void> {
  const chain = parseJson(await bitcoinCli(['getblockchaininfo']));
  if (chain.chain !== 'regtest') throw new Error('Refusing non-regtest Bitcoin chain');
  try {
    await bitcoinCli(['-rpcwallet=regtest', 'getwalletinfo']);
  } catch {
    try {
      await bitcoinCli(['createwallet', 'regtest']);
    } catch {
      await bitcoinCli(['loadwallet', 'regtest']);
    }
  }

  const existing = Reflect.get(await lncli('lnd-sink', ['listchannels']), 'channels');
  if (
    Array.isArray(existing) &&
    existing.some((channel) => Reflect.get(channel, 'active') === true)
  ) {
    return;
  }
  const pending = Reflect.get(
    await lncli('lnd-sink', ['pendingchannels']),
    'pending_open_channels',
  );
  if (Array.isArray(pending) && pending.length > 0) {
    await mine(6);
    await waitForActiveChannel();
    return;
  }

  await mine(101);
  const balance = Reflect.get(await lncli('lnd-sink', ['walletbalance']), 'confirmed_balance');
  if (typeof balance !== 'string' || Number(balance) < 2_000_000) {
    const sinkAddress = Reflect.get(await lncli('lnd-sink', ['newaddress', 'p2wkh']), 'address');
    if (typeof sinkAddress !== 'string') throw new Error('LND sink returned no funding address');
    await bitcoinCli(['-rpcwallet=regtest', 'sendtoaddress', sinkAddress, '1']);
    await mine(6);
  }

  const mintPublicKey = Reflect.get(await lncli('lnd-mint', ['getinfo']), 'identity_pubkey');
  if (typeof mintPublicKey !== 'string') throw new Error('LND mint returned no identity');
  await waitForPeer(mintPublicKey);
  await lncli('lnd-sink', ['openchannel', '--sat_per_vbyte=2', mintPublicKey, '1000000', '400000']);
  await mine(6);
  await waitForActiveChannel();
}

function operationId(name: string): string {
  return createHash('sha256')
    .update('cashu-fault-lab/regtest-melt/v1\0')
    .update(name)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
}

function adapter(): HttpLifecycleAdapterClient {
  return new HttpLifecycleAdapterClient({
    baseUrl: 'http://127.0.0.1:4141',
    token: 'lifecycle-regtest-cashu-ts-token',
    timeoutMs: 15_000,
  });
}

async function clearFaults(): Promise<void> {
  const response = await fetch(`${gatewayUrl}/__faults/v1/rules`, {
    method: 'DELETE',
    redirect: 'manual',
    headers: { authorization: 'Bearer lifecycle-regtest-fault-token' },
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error('Regtest gateway rejected fault reset');
}

async function installMeltDrop(operation: string): Promise<void> {
  const response = await fetch(`${gatewayUrl}/__faults/v1/rules`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      authorization: 'Bearer lifecycle-regtest-fault-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      phase: 'after_downstream_response',
      action: 'drop',
      match: { endpointFamily: 'melt', operationId: operation },
      occurrence: 1,
    }),
  });
  await response.body?.cancel();
  if (response.status !== 201) throw new Error('Regtest gateway rejected melt fault');
}

async function restartAdapter(): Promise<void> {
  await execFileAsync(docker, ['compose', '-f', composeFile, 'restart', 'cashu-ts-regtest'], {
    env: composeEnvironment,
    timeout: 30_000,
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await adapter().capabilities();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('Regtest lifecycle adapter did not restart');
}

async function converge(client: HttpLifecycleAdapterClient, view: LifecycleOperationView) {
  let current = view;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (['succeeded', 'failed_definitive', 'recovery_blocked'].includes(current.phase)) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    current = await client.resume(current.operationId);
  }
  throw new Error('Regtest melt did not converge');
}

async function fundedToken(amount: number): Promise<string> {
  const seed = createHash('sha512').update('cashu-fault-lab/regtest-fixture/v1').digest();
  const wallet = new Wallet(publicMintUrl, { unit: 'sat', bip39seed: seed });
  await wallet.loadMint();
  let quote = await wallet.createMintQuoteBolt11(amount, 'cashu-fault-lab regtest fixture');
  const decoded = await lncli('lnd-sink', ['decodepayreq', quote.request]);
  const paymentHash = Reflect.get(decoded, 'payment_hash');
  if (typeof paymentHash !== 'string') throw new Error('LND could not bind the funding invoice');
  let paid = false;
  for (let attempt = 0; attempt < 40 && !paid; attempt += 1) {
    try {
      await composeExec('lnd-sink', [
        'lncli',
        '--network=regtest',
        'payinvoice',
        '--force',
        quote.request,
      ]);
      paid = true;
    } catch {
      const payments = Reflect.get(await lncli('lnd-sink', ['listpayments']), 'payments');
      paid =
        Array.isArray(payments) &&
        payments.some(
          (payment) =>
            Reflect.get(payment, 'payment_hash') === paymentHash &&
            Reflect.get(payment, 'status') === 'SUCCEEDED',
        );
      if (!paid) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!paid) throw new Error('LND could not pay the regtest funding invoice');
  for (let attempt = 0; quote.state !== MintQuoteState.PAID && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    quote = await wallet.checkMintQuoteBolt11(quote);
  }
  if (quote.state !== MintQuoteState.PAID)
    throw new Error('Regtest fixture mint quote was not paid');
  const proofs = await wallet.mintProofsBolt11(amount, quote, undefined, { type: 'random' });
  return getEncodedToken({ mint: lifecycleMintUrl, unit: 'sat', proofs });
}

afterEach(async () => {
  if (enabled) await clearFaults();
});

describe.skipIf(!enabled)('wallet lifecycle Lightning regtest', () => {
  it('settles once after response loss, duplicate resume, and adapter restart while conserving NUT-08 change', async () => {
    await bootstrapRegtest();
    const client = adapter();
    await clearFaults();
    await client.reset('wallet-lifecycle-regtest');
    expect((await client.capabilities()).operations).toContain('melt');

    const token = await fundedToken(256);
    const receive = await converge(
      client,
      await client.start({
        operationId: operationId('receive'),
        kind: 'receive',
        mint: lifecycleMintUrl,
        unit: 'sat',
        token,
      }),
    );
    expect(receive.phase).toBe('succeeded');
    const before = await client.wallet();

    const invoice = await lncli('lnd-sink', [
      'addinvoice',
      '--amt=64',
      '--memo=cashu-fault-lab-regtest-melt',
    ]);
    const paymentRequest = Reflect.get(invoice, 'payment_request');
    const paymentHash = Reflect.get(invoice, 'r_hash');
    if (typeof paymentRequest !== 'string' || typeof paymentHash !== 'string') {
      throw new Error('LND sink returned an invalid invoice');
    }
    const meltOperationId = operationId('melt');
    await installMeltDrop(meltOperationId);
    await expect(
      client.start({
        operationId: meltOperationId,
        kind: 'melt',
        mint: lifecycleMintUrl,
        unit: 'sat',
        invoice: paymentRequest,
      }),
    ).rejects.toThrow();

    await restartAdapter();
    await clearFaults();
    const restarted = adapter();
    const duplicateResumes = await Promise.all([
      restarted.resume(meltOperationId),
      restarted.resume(meltOperationId),
    ]);
    const settled = await converge(restarted, duplicateResumes[0]!);
    expect(duplicateResumes[1]!.operationId).toBe(meltOperationId);
    expect(settled).toMatchObject({
      operationId: meltOperationId,
      phase: 'succeeded',
      amount: 64,
    });
    expect(settled.change).toBeGreaterThan(0);

    const after = await restarted.wallet();
    expect(before.balances.available - after.balances.available).toBe(
      64 + (settled.actualFee ?? 0) + (settled.inputFee ?? 0),
    );
    expect(after.balances.reserved).toBe(0);

    const sinkInvoice = await lncli('lnd-sink', ['lookupinvoice', paymentHash]);
    expect(sinkInvoice.state).toBe('SETTLED');
    const settledHtlcs = Reflect.get(sinkInvoice, 'htlcs');
    expect(
      Array.isArray(settledHtlcs)
        ? settledHtlcs.filter((htlc) => Reflect.get(htlc, 'state') === 'SETTLED')
        : [],
    ).toHaveLength(1);
    const payments = Reflect.get(await lncli('lnd-mint', ['listpayments']), 'payments');
    expect(
      Array.isArray(payments)
        ? payments.filter(
            (payment) =>
              Reflect.get(payment, 'payment_hash') === paymentHash &&
              Reflect.get(payment, 'status') === 'SUCCEEDED',
          )
        : [],
    ).toHaveLength(1);

    const evidenceText = JSON.stringify(await restarted.evidence());
    expect(evidenceText).toContain('settlement_verified');
    expect(evidenceText).not.toContain(paymentRequest);
    expect(evidenceText).not.toContain(token);
  }, 240_000);
});
