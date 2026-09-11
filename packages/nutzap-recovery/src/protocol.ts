import { createHash } from 'node:crypto';
import { hashToCurve } from '@cashu/cashu-ts';
import { verifyEvent, type Event } from 'nostr-tools';

export interface NutzapProof {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: { e: string; s: string; r: string };
}
export interface Nutzap {
  id: string;
  event: Event;
  mint: string;
  recipient: string;
  lockingKey: string;
  proofs: NutzapProof[];
  amount: number;
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const proofY = (proof: NutzapProof): string =>
  hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true);
const hex = /^[0-9a-f]{64}$/u;
const point = /^0[23][0-9a-f]{64}$/u;
function single(event: Event, name: string, fallback?: string): string {
  const tags = event.tags.filter((t) => t[0] === name);
  if (tags.length === 0 && fallback !== undefined) return fallback;
  if (tags.length !== 1 || tags[0]?.length !== 2) throw new Error('Ambiguous NIP-61 tag');
  return tags[0][1]!;
}
export function loopbackMint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Nutzap lab requires a disposable HTTP mint on 127.0.0.1');
  return value;
}
/** Basic sat/P2PK profile; cryptographic DLEQ verification belongs to the mint backend. */
export function validateNutzap(event: Event, info: Event): Nutzap {
  // Clone to discard nostr-tools' symbol-based signature-verification cache.
  if (
    Buffer.byteLength(JSON.stringify([event, info]), 'utf8') > 256 * 1024 ||
    !verifyEvent(JSON.parse(JSON.stringify(event))) ||
    !verifyEvent(JSON.parse(JSON.stringify(info))) ||
    event.kind !== 9321 ||
    info.kind !== 10019
  )
    throw new Error('Invalid signed NIP-61 event');
  const recipient = single(event, 'p');
  const mint = single(event, 'u');
  const lockingKey = single(info, 'pubkey');
  if (
    recipient !== info.pubkey ||
    !hex.test(lockingKey) ||
    lockingKey === recipient ||
    single(event, 'unit', 'sat') !== 'sat'
  )
    throw new Error('Unsupported NIP-61 recipient, unit or locking key');
  if (
    !info.tags.some(
      (t) => t[0] === 'mint' && t[1] === mint && (t.length === 2 || t.slice(2).includes('sat')),
    )
  )
    throw new Error('Unadvertised nutzap mint');
  loopbackMint(mint);
  const tags = event.tags.filter((t) => t[0] === 'proof');
  if (tags.length < 1 || tags.length > 64) throw new Error('Nutzap proof count exceeds profile');
  const proofs = tags.map((tag) => {
    if (tag.length !== 2 || tag[1]!.length > 8192) throw new Error('Invalid nutzap proof');
    const p: NutzapProof = JSON.parse(tag[1]!);
    if (
      !p ||
      typeof p.id !== 'string' ||
      !/^[0-9a-f]{16,66}$/u.test(p.id) ||
      !Number.isSafeInteger(p.amount) ||
      p.amount < 1 ||
      typeof p.secret !== 'string' ||
      typeof p.C !== 'string' ||
      !point.test(p.C) ||
      !p.dleq ||
      ![p.dleq.e, p.dleq.s, p.dleq.r].every((v) => typeof v === 'string' && hex.test(v))
    )
      throw new Error('Invalid nutzap proof fields');
    const secret: unknown = JSON.parse(p.secret);
    if (
      !Array.isArray(secret) ||
      secret.length !== 2 ||
      secret[0] !== 'P2PK' ||
      !secret[1] ||
      secret[1].data !== `02${lockingKey}` ||
      typeof secret[1].nonce !== 'string' ||
      Object.keys(secret[1]).some((k) => !['data', 'nonce', 'tags'].includes(k))
    )
      throw new Error('Wrong nutzap P2PK lock');
    const conditions = secret[1].tags;
    if (
      conditions !== undefined &&
      JSON.stringify(conditions) !== '[]' &&
      JSON.stringify(conditions) !== '[["sigflag","SIG_INPUTS"]]'
    )
      throw new Error('Unsupported nutzap spending conditions');
    return { id: p.id, amount: p.amount, secret: p.secret, C: p.C, dleq: p.dleq };
  });
  const ys = proofs.map(proofY).sort();
  const amount = proofs.reduce((sum, p) => sum + p.amount, 0);
  if (new Set(ys).size !== ys.length || !Number.isSafeInteger(amount) || amount > 1_000_000)
    throw new Error('Duplicate proofs or excessive nutzap amount');
  return {
    id: digest(`cashu-fault-lab/nip61-economic-v1\0${mint}\0${ys.join('\0')}`),
    event,
    mint,
    recipient,
    lockingKey,
    proofs,
    amount,
  };
}
