import type { Event } from 'nostr-tools';
import { receiveNutzap } from './receiver.js';
import type { MintPort } from './types.js';
export interface WorkerInput {
  database: string;
  keyHex: string;
  info: Event;
  event: Event;
  relays: string[];
  pauseAfterSwap: boolean;
}
let sequence = 0;
const pending = new Map<
  number,
  { resolve: (v: never) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
function rpc<T>(method: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error('Nutzap worker RPC timeout'));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    process.send?.({ type: 'rpc', id, method, args });
  });
}
process.on('message', (raw: unknown) => {
  const message = raw as {
    type: string;
    id: number;
    value: never;
    ok: boolean;
    input: WorkerInput;
  };
  if (message.type === 'reply') {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    message.ok ? call.resolve(message.value) : call.reject(Error('Mint or relay operation failed'));
    return;
  }
  if (message.type !== 'start') return;
  const input = message.input;
  const mint: MintPort = {
    prepare: (zap) => rpc('prepare', [zap]),
    swap: (zap, plan) => rpc('swap', [zap, plan]),
    restore: (zap, plan) => rpc('restore', [zap, plan]),
    states: (proofs) => rpc('states', [proofs]),
  };
  void receiveNutzap(input.event, {
    database: input.database,
    key: Uint8Array.from(Buffer.from(input.keyHex, 'hex')),
    info: input.info,
    relays: input.relays,
    mint,
    publish: (relay, event) => rpc('publish', [relay, event]),
    ...(input.pauseAfterSwap
      ? {
          afterSwap: async () => {
            process.send?.({ type: 'after-swap' });
            await new Promise<void>(() => {});
          },
        }
      : {}),
  })
    .then((result) => process.send?.({ type: 'result', result }, () => process.disconnect?.()))
    .catch(() => process.send?.({ type: 'error' }, () => process.disconnect?.()));
});
process.send?.({ type: 'ready' });
