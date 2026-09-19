import { spawn } from 'node:child_process';
import type { WorkerInput } from './nutzap-worker.js';
import type { ReceiveResult } from './types.js';

export type CdkPhase =
  | 'receiving-key-selected'
  | 'missing-receiving-key'
  | 'before-swap'
  | 'after-swap'
  | 'before-publish'
  | 'spend-prepared'
  | 'after-publication'
  | 'after-wallet-sync';
export async function runCdkReceiver(
  binary: string,
  input: WorkerInput & { syncWallet?: boolean },
  lockHex: string,
  checkpoint: (phase: CdkPhase) => Promise<'continue' | 'kill'>,
): Promise<ReceiveResult | 'killed'> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '',
      diagnostic = '',
      bytes = 0;
    let result: ReceiveResult | undefined;
    let killed = false,
      failed = false,
      processing = false;
    const fail = () => {
      failed = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(fail, 60_000);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.on('data', (chunk: Buffer) => {
      // Only a bounded static error code from the bundled receiver is surfaced.
      diagnostic = (diagnostic + chunk.toString()).slice(0, 256);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8192) return fail();
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      if (processing || end !== buffer.length - 1) return fail();
      let message: { type?: string; phase?: CdkPhase; result?: ReceiveResult };
      try {
        message = JSON.parse(buffer);
      } catch {
        return fail();
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return fail();
      buffer = '';
      if (
        message.type === 'result' &&
        [
          'complete',
          'pending',
          'recovery-blocked',
          'publication-pending',
          'awaiting-peer',
        ].includes(message.result ?? '')
      ) {
        if (result) return fail();
        result = message.result;
        return;
      }
      if (
        result ||
        message.type !== 'checkpoint' ||
        ![
          'receiving-key-selected',
          'missing-receiving-key',
          'before-swap',
          'after-swap',
          'before-publish',
          'spend-prepared',
          'after-publication',
          'after-wallet-sync',
        ].includes(message.phase ?? '')
      )
        return fail();
      processing = true;
      void checkpoint(message.phase!)
        .then((action) => {
          processing = false;
          if (action === 'kill') {
            killed = true;
            child.kill('SIGKILL');
          } else if (!failed && !child.killed) child.stdin.write('{"continue":true}\n');
        })
        .catch(fail);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (!failed && killed && signal === 'SIGKILL') resolve('killed');
      else if (!failed && code === 0 && result) resolve(result);
      else {
        const safeCode = /^CDK nutzap receiver: ([a-z_]+)\s*$/.exec(diagnostic)?.[1];
        reject(Error(`CDK receiver failed${safeCode ? `: ${safeCode}` : ''}`));
      }
    });
    child.stdin.write(
      `${JSON.stringify({ database: input.database, keyHex: input.keyHex, lockHex, info: input.info, event: input.event, relays: input.relays, spendAmount: input.spendAmount, syncWallet: input.syncWallet, receivingKeys: input.receivingKeys?.database })}\n`,
    );
  });
}
