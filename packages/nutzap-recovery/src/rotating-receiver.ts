import { getPublicKey, type Event } from 'nostr-tools';
import { ReceivingKeys } from './receiving-keys.js';
import { validateNutzap } from './protocol.js';
import { receiveNutzap } from './receiver.js';
import { FundedMint } from './funded-mint.js';
import type { ReceiverOptions, ReceiveResult } from './types.js';

export async function receiveWithReceivingKeys(
  event: Event,
  options: Omit<ReceiverOptions, 'info'>,
  keyDatabase: string,
  funded = false,
): Promise<ReceiveResult> {
  const keys = new ReceivingKeys(keyDatabase, getPublicKey(options.key));
  try {
    for (const entry of keys.entries()) {
      let zap;
      try {
        zap = validateNutzap(event, entry.info);
      } catch {
        continue;
      }
      if (!entry.secret) return 'recovery-blocked';
      if (
        !/^[0-9a-f]{64}$/u.test(entry.secret) ||
        getPublicKey(Uint8Array.from(Buffer.from(entry.secret, 'hex'))) !== zap.lockingKey
      )
        throw Error('Stored receiving key mismatch');
      const mint = funded ? new FundedMint(zap.mint, entry.secret) : options.mint;
      if (mint instanceof FundedMint) await mint.initialize();
      return await receiveNutzap(event, { ...options, info: entry.info, mint });
    }
    throw Error('Nutzap does not match retained receiving advertisements');
  } finally {
    keys.close();
  }
}
