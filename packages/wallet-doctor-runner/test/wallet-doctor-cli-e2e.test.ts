import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { finalizeEvent, generateSecretKey, getPublicKey, nip44, type Event } from 'nostr-tools';
import WebSocket from 'ws';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import { proofY } from '@cashu-fault-lab/wallet-doctor-contract';

/**
 * End-to-end gate for the NIP-60 wallet doctor CLI: two live in-process
 * relays with divergent histories, a stub NUT-07 mint, and the real built
 * lab-cli running collect -> diagnose -> plan -> check. Docker-free but
 * requires `pnpm --filter @cashu-fault-lab/lab-cli build` first (see the
 * root `verify:wallet-doctor` script); excluded from the default unit tier.
 */
const root = new URL('../../../', import.meta.url).pathname;
const cliPath = path.join(root, 'apps/lab-cli/dist/bin.js');

function publish(relayUrl: string, event: Event): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timeout = setTimeout(() => reject(new Error('publish timed out')), 5_000);
    socket.once('open', () => socket.send(JSON.stringify(['EVENT', event])));
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'OK' && message[1] === event.id) {
        clearTimeout(timeout);
        socket.close();
        if (message[2] === true) resolve();
        else reject(new Error(`relay rejected event: ${String(message[3])}`));
      }
    });
    socket.once('error', reject);
  });
}

function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [cliPath, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMintStub(states: ReadonlyMap<string, string>): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/checkstate') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const parsed = JSON.parse(body) as { Ys?: string[] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          states: (parsed.Ys ?? []).map((y) => ({ Y: y, state: states.get(y) ?? 'UNSPENT' })),
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('wallet-doctor CLI end-to-end', () => {
  it('collect -> diagnose -> plan -> check reports a del-chain break as intended', async () => {
    const relayA = new NostrFaultRelay();
    const relayB = new NostrFaultRelay();
    const urlA = await relayA.listen(0);
    const urlB = await relayB.listen(0);
    const workdir = await mkdtemp(path.join(tmpdir(), 'wallet-doctor-e2e-'));
    let mintStub: Server | undefined;
    try {
      const sk = generateSecretKey();
      const pk = getPublicKey(sk);
      const ck = nip44.v2.utils.getConversationKey(sk, pk);
      const secretHex = Buffer.from(sk).toString('hex');

      const states = new Map([
        [proofY('e2e-secret-spent'), 'SPENT'],
        [proofY('e2e-secret-live'), 'UNSPENT'],
      ]);
      mintStub = await startMintStub(states);
      const mintPort = (mintStub.address() as { port: number }).port;
      const mint = `http://127.0.0.1:${mintPort}`;

      const encrypt = (payload: unknown): string => nip44.v2.encrypt(JSON.stringify(payload), ck);
      const walletEvent = finalizeEvent(
        { kind: 17375, created_at: 1_700_000_000, tags: [], content: encrypt([['mint', mint]]) },
        sk,
      );
      const oldToken = finalizeEvent(
        {
          kind: 7375,
          created_at: 1_700_000_100,
          tags: [],
          content: encrypt({
            mint,
            proofs: [
              { id: '00ad268c4d1f5826', amount: 4, secret: 'e2e-secret-spent' },
              { id: '00ad268c4d1f5826', amount: 8, secret: 'e2e-secret-live' },
            ],
          }),
        },
        sk,
      );
      const rolledToken = finalizeEvent(
        {
          kind: 7375,
          created_at: 1_700_000_200,
          tags: [],
          content: encrypt({
            mint,
            proofs: [{ id: '00ad268c4d1f5826', amount: 8, secret: 'e2e-secret-live' }],
            del: [oldToken.id],
          }),
        },
        sk,
      );
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: 1_700_000_300,
          tags: [
            ['e', oldToken.id],
            ['k', '7375'],
          ],
          content: '',
        },
        sk,
      );

      for (const event of [walletEvent, rolledToken, deletion]) await publish(urlA, event);
      for (const event of [walletEvent, oldToken]) await publish(urlB, event);

      const env = { CFL_NIP60_SUBJECT_KEY: secretHex };
      const capturePath = path.join(workdir, 'capture.json');
      const diagnosisPath = path.join(workdir, 'diagnosis.json');
      const planPath = path.join(workdir, 'plan.json');

      const collect = await runCli(
        ['wallet-doctor', 'collect', '--relay', urlA, '--relay', urlB, '--output', capturePath],
        env,
      );
      expect(collect.code, collect.stderr).toBe(0);
      const capture = JSON.parse(await readFile(capturePath, 'utf8')) as {
        digest: string;
        observation: { relays: unknown[] };
      };
      expect(capture.observation.relays).toHaveLength(2);
      expect(JSON.stringify(capture)).not.toContain('e2e-secret-live');
      expect(collect.stdout).toContain('relays: 2 ok, 0 error');

      const diagnose = await runCli(
        ['wallet-doctor', 'diagnose', capturePath, '--output', diagnosisPath],
        env,
      );
      expect(diagnose.code).toBe(1);
      expect(diagnose.stdout).toContain('DEL_CHAIN_BREAK');
      expect(diagnose.stdout).toContain('double-counted=8');
      expect(diagnose.stdout).toContain('mint-verified=8');

      const plan = await runCli(['wallet-doctor', 'plan', capturePath, '--output', planPath], env);
      expect(plan.code, plan.stdout).toBe(0);
      const planArtifact = JSON.parse(await readFile(planPath, 'utf8')) as {
        plan: { steps: { action: string }[] };
        safety: { ok: boolean };
      };
      expect(planArtifact.plan.steps.map((step) => step.action)).toEqual([
        'publish_rollover',
        'delete_events',
      ]);
      expect(planArtifact.safety.ok).toBe(true);
      expect(plan.stdout).toContain('dry-run; nothing is published');

      const check = await runCli(['wallet-doctor', 'check', capturePath], env);
      expect(check.code).toBe(1);
      expect(check.stdout).toContain('check: FAIL');
      expect(check.stdout).toContain('DEL_CHAIN_BREAK');
    } finally {
      await relayA.close();
      await relayB.close();
      mintStub?.close();
      await rm(workdir, { recursive: true, force: true });
    }
  }, 60_000);
});
