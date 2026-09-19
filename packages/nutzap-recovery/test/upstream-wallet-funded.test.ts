import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { createNutzapSession } from '../src/session.js';
import { Journal } from '../src/journal.js';
import { runReceiverProcess } from '../src/process.js';
import { publishEvent, queryEvents } from '../src/relay.js';
import { digest, validateNutzap, type NutzapProof } from '../src/protocol.js';
import { observeNutzap } from '../src/observation.js';
import { verifyNutzapEvidence } from '../src/evidence.js';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';

// Commands and tokens travel on stdin, never through shell interpolation or test logs.
async function docker(
  args: string[],
  input = '',
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let size = 0;
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill('SIGKILL');
    }, 30000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1048576) {
        failed = true;
        child.kill('SIGKILL');
      } else output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1048576) {
        failed = true;
        child.kill('SIGKILL');
      }
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(Error('Upstream wallet command unavailable'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      failed ? reject(Error('Upstream wallet command exceeded limits')) : resolve({ code, output });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

it('upstream Nutshell CLI receives recovered value once and returns a P2PK payment through NIP-65 routing', async () => {
  const container = process.env.CFL_NUTZAP_WALLET_CONTAINER;
  const mintUrl = process.env.CFL_NUTZAP_MINT_URL;
  if (!container || !mintUrl) throw Error('Run pnpm test:nutzap:funded --mint nutshell');
  const walletDir = `/tmp/cfl-upstream-wallet-${randomUUID()}`;
  const command = (args: string[]) =>
    docker(
      [
        'exec',
        '-i',
        '-e',
        `CASHU_DIR=${walletDir}`,
        '-e',
        'LOCKTIME_DELTA_SECONDS=0',
        container,
        'poetry',
        'run',
        'python',
        '-c',
        'import json,os,sys; os.umask(0o077); from cashu.wallet.cli.cli import cli; cli(args=json.loads(sys.stdin.read()))',
      ],
      JSON.stringify([
        '--host',
        'http://127.0.0.1:3338',
        '--wallet',
        'wallet',
        '--unit',
        'sat',
        '--yes',
        ...args,
      ]),
    );
  const checked = async (args: string[]) => {
    const result = await command(args);
    expect(result.code, `Upstream wallet ${args[0]} exited successfully`).toBe(0);
    return result.output;
  };
  const balance = async () => {
    const output = await checked(['balance']);
    const match = output.match(/^Balance: (\d+)(?: sat)?$/mu);
    if (!match) throw Error('Upstream wallet balance missing');
    return Number(match[1]);
  };
  const proofs = async (): Promise<NutzapProof[]> => {
    const output = await checked(['proofs']);
    const start = output.indexOf('[\n');
    if (start < 0) throw Error('Upstream wallet proof output missing');
    try {
      return JSON.parse(output.slice(start));
    } catch {
      throw Error('Invalid upstream wallet proof output');
    }
  };
  const session = await createNutzapSession('upstream-nutshell-roundtrip', mintUrl);
  const readRelay = new NostrFaultRelay();
  try {
    const image = await docker(['inspect', '--format', '{{.Config.Image}}', container]);
    expect(image.code).toBe(0);
    expect(image.output.trim()).toBe(
      'cashubtc/nutshell:0.20.2@sha256:65e9cbe23aaa1aeb27ce7206fa854a80f39ce8db1c9121eaecfc053a22506574',
    );
    const version = await docker([
      'exec',
      container,
      'poetry',
      'run',
      'python',
      '-c',
      'from cashu.core.settings import settings; print(settings.version)',
    ]);
    expect(version.code).toBe(0);
    expect(version.output.trim()).toBe('0.20.2');
    expect(await balance()).toBe(0);
    const database = join(session.directory, 'wallet.sqlite');
    const input = {
      database,
      keyHex: Buffer.from(session.key).toString('hex'),
      info: session.info,
      event: session.event,
      relays: session.relays,
      pauseAfterSwap: false,
    };
    expect(
      await runReceiverProcess({ ...input, pauseAfterSwap: true }, session.backend, publishEvent),
    ).toBe('killed');
    expect(await runReceiverProcess(input, session.backend, publishEvent)).toBe('complete');
    const snapshot = (id = session.zap.id) => {
      const db = new Journal(database);
      try {
        return { record: db.get(id)!, summary: db.summary() };
      } finally {
        db.close();
      }
    };
    const initial = snapshot();
    const recovered = await observeNutzap(
      session,
      initial.record,
      initial.summary,
      true,
      true,
      true,
    );
    expect(verifyNutzapEvidence(recovered, 'crash-after-swap').ok).toBe(true);
    expect(
      await runReceiverProcess({ ...input, spendAmount: 8 }, session.backend, publishEvent),
    ).toBe('complete');
    const sent = snapshot().record;
    // Same mint, different network namespace: only the token envelope's URL changes.
    const token =
      'cashuA' +
      Buffer.from(
        JSON.stringify({
          token: [{ mint: 'http://127.0.0.1:3338', proofs: sent.spend!.sent }],
          unit: 'sat',
        }),
      ).toString('base64url');
    await checked(['receive', token]);
    const received = await balance(); // A new real CLI process reopens the upstream database.
    expect(received).toBe(7);
    const walletProofs = await proofs();
    expect(walletProofs.reduce((n, p) => n + p.amount, 0)).toBe(received);
    await session.backend.verify(walletProofs);
    expect((await session.backend.states(walletProofs)).every((s) => s === 'UNSPENT')).toBe(true);
    expect((await session.backend.states(sent.spend!.sent)).every((s) => s === 'SPENT')).toBe(true);
    const duplicate = await command(['receive', token]);
    expect(
      duplicate.code !== 0 || /already spent|already received|spent|Error/iu.test(duplicate.output),
    ).toBe(true);
    expect(await balance()).toBe(received);
    const output = await checked([
      'send',
      '4',
      '--lock',
      `P2PK:02${getPublicKey(session.lock)}`,
      '--dleq',
      '--legacy',
    ]);
    const encoded = output.match(/cashuA[A-Za-z0-9_-]+={0,2}/u)?.[0];
    if (!encoded) throw Error('Upstream wallet did not return a token');
    const returned = JSON.parse(Buffer.from(encoded.slice(6), 'base64url').toString()) as {
      token: { mint: string; proofs: NutzapProof[] }[];
      unit: string;
    };
    expect(returned.unit).toBe('sat');
    expect(returned.token.length).toBe(1);
    expect(returned.token[0]!.mint).toBe('http://127.0.0.1:3338');
    const returnProofs = returned.token[0]!.proofs;
    expect(returnProofs.reduce((n, p) => n + p.amount, 0)).toBe(4);
    await session.backend.verify(returnProofs);
    const walletRemaining = await balance();
    const remainingProofs = await proofs();
    expect(walletRemaining).toBe(2);
    expect(remainingProofs.reduce((n, p) => n + p.amount, 0)).toBe(walletRemaining);
    const sender = Uint8Array.from(Buffer.from(digest('upstream-nutshell-nostr-envelope'), 'hex'));
    const senderRelay = await readRelay.listen();
    const metadata = finalizeEvent(
      { kind: 10002, created_at: 1700000010, content: '', tags: [['r', senderRelay, 'read']] },
      sender,
    );
    await publishEvent(session.relays[0]!, metadata);
    const event = finalizeEvent(
      {
        kind: 9321,
        created_at: 1700000011,
        content: '',
        tags: [
          ['p', session.info.pubkey],
          ['u', mintUrl],
          ['unit', 'sat'],
          ...returnProofs.map((p) => ['proof', JSON.stringify(p)]),
        ],
      },
      sender,
    );
    const zap = validateNutzap(event, session.info);
    await Promise.all(session.relays.map((r) => publishEvent(r, event)));
    readRelay.control.setRule({ action: 'drop_ok', kind: 7376, count: 1 });
    const returnInput = { ...input, event, discoverSenderRelays: true };
    expect(await runReceiverProcess(returnInput, session.backend, publishEvent)).toBe(
      'publication-pending',
    );
    expect(await runReceiverProcess(returnInput, session.backend, publishEvent)).toBe('complete');
    const firstReturn = snapshot(zap.id);
    expect(await runReceiverProcess(returnInput, session.backend, publishEvent)).toBe('complete');
    const final = snapshot(zap.id);
    expect(final.summary.credits).toBe(2); // Two distinct payments, never duplicate credit.
    expect(final.summary).toEqual(firstReturn.summary);
    expect(final.record.events.map((e) => e.id)).toEqual(
      firstReturn.record.events.map((e) => e.id),
    );
    const history = await queryEvents(senderRelay, {
      kinds: [7375, 7376],
      authors: [session.info.pubkey],
    });
    expect(history.map((e) => e.kind)).toEqual([7376]);
    expect(history[0]!.id).toBe(final.record.events.find((e) => e.kind === 7376)!.id);
    expect(
      history[0]!.tags.some((t) => t[0] === 'e' && t[1] === event.id && t[3] === 'redeemed'),
    ).toBe(true);
    expect((await session.backend.states(returnProofs)).every((s) => s === 'SPENT')).toBe(true);
    expect(
      (
        await session.backend.states([
          ...sent.wallet!.proofs,
          ...final.record.wallet!.proofs,
          ...remainingProofs,
        ])
      ).every((s) => s === 'UNSPENT'),
    ).toBe(true);
    const fees = [
      initial.record.plan.fee,
      sent.spend!.plan.fee,
      8 - received,
      received - 4 - walletRemaining,
      final.record.plan.fee,
    ];
    expect(fees).toEqual([1, 1, 1, 1, 1]);
    expect(final.summary.balance + walletRemaining + fees.reduce((a, b) => a + b, 0)).toBe(
      session.zap.amount,
    );
    const permissions = await docker(
      [
        'exec',
        '-i',
        container,
        'poetry',
        'run',
        'python',
        '-c',
        'from pathlib import Path; import sys; root=Path(sys.stdin.read()); print(all(p.stat().st_mode & 0o077 == 0 for p in [root, *root.rglob("*")]))',
      ],
      walletDir,
    );
    expect(permissions.code).toBe(0);
    expect(permissions.output.trim()).toBe('True');
    const report = {
      schemaVersion: 1,
      suite: 'upstream-wallet-roundtrip-v1',
      status: 'passed',
      wallet: 'cashubtc/nutshell CLI 0.20.2',
      walletProfile: { name: 'wallet', locktimeDeltaSeconds: 0, unit: 'sat' },
      image:
        'cashubtc/nutshell:0.20.2@sha256:65e9cbe23aaa1aeb27ce7206fa854a80f39ce8db1c9121eaecfc053a22506574',
      mint: session.mintImplementation,
      inputAmount: session.zap.amount,
      labBalance: final.summary.balance,
      upstreamBalance: walletRemaining,
      fees,
      credits: final.summary.credits,
      crashRecovery: true,
      duplicateReceiptRejected: true,
      restartBalancePreserved: true,
      privateWalletFiles: true,
      p2pkReturnRedeemed: true,
      senderHistoryOnly: true,
      lostAcknowledgementRecovered: true,
      allRemainingProofsUnspent: true,
      nostrTransport: 'lab envelope; upstream CLI owns token operations',
    };
    const reportDir = process.env.CFL_NUTZAP_REPORT_DIR;
    if (reportDir)
      await writeFile(
        join(reportDir, 'upstream-wallet-roundtrip.json'),
        JSON.stringify(report, null, 2) + '\n',
        { mode: 0o600 },
      );
  } finally {
    await readRelay.close();
    await session.close();
    const cleanup = await docker(
      [
        'exec',
        '-i',
        container,
        'poetry',
        'run',
        'python',
        '-c',
        'import shutil,sys; shutil.rmtree(sys.stdin.read(), ignore_errors=True)',
      ],
      walletDir,
    );
    expect(cleanup.code, 'Disposable upstream wallet removed').toBe(0);
  }
}, 120_000);
