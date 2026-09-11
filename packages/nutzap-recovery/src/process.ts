import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Event } from 'nostr-tools';
import type { Nutzap, NutzapProof } from './protocol.js';
import type { MintPort, PreparedRedemption, ReceiveResult } from './types.js';
import type { WorkerInput } from './nutzap-worker.js';

export async function runReceiverProcess(
  input: WorkerInput,
  mint: MintPort,
  publish: (relay: string, event: Event) => Promise<void>,
): Promise<ReceiveResult | 'killed'> {
  const adjacent = new URL('./nutzap-worker.js', import.meta.url);
  const worker = existsSync(adjacent)
    ? adjacent
    : new URL('../dist/nutzap-worker.js', import.meta.url);
  return new Promise((resolve, reject) => {
    const child = fork(worker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    let result: ReceiveResult | 'killed' | undefined;
    let failure = false;
    let calls = 0;
    const timer = setTimeout(() => {
      failure = true;
      child.kill('SIGKILL');
    }, 30000);
    child.on('error', () => {
      failure = true;
    });
    child.on('message', (raw: unknown) => {
      const m = raw as {
        type: string;
        id: number;
        method: string;
        args: unknown[];
        result: ReceiveResult;
      };
      if (m.type === 'ready') {
        child.send({ type: 'start', input });
        return;
      }
      if (m.type === 'after-swap' && input.pauseAfterSwap) {
        result = 'killed';
        child.kill('SIGKILL');
        return;
      }
      if (m.type === 'result') {
        result = m.result;
        return;
      }
      if (m.type === 'error') {
        failure = true;
        return;
      }
      if (m.type !== 'rpc') return;
      if (++calls > 128) {
        failure = true;
        child.kill('SIGKILL');
        return;
      }
      const dispatch = async (): Promise<unknown> => {
        const [a, b] = m.args;
        switch (m.method) {
          case 'prepare':
            return mint.prepare(a as Nutzap);
          case 'swap':
            return mint.swap(a as Nutzap, b as PreparedRedemption);
          case 'restore':
            return mint.restore(a as Nutzap, b as PreparedRedemption);
          case 'states':
            return mint.states(a as NutzapProof[]);
          case 'verify':
            return mint.verify(a as NutzapProof[]);
          case 'publish':
            return publish(a as string, b as Event);
          default:
            throw Error('Unknown receiver method');
        }
      };
      void dispatch()
        .then((value) => {
          if (child.connected) child.send({ type: 'reply', id: m.id, ok: true, value }, () => {});
        })
        .catch(() => {
          if (child.connected) child.send({ type: 'reply', id: m.id, ok: false }, () => {});
        });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!failure && result === 'killed' && signal === 'SIGKILL') resolve('killed');
      else if (!failure && code === 0 && result && result !== 'killed') resolve(result);
      else reject(Error('Nutzap receiver process failed or timed out'));
    });
  });
}
