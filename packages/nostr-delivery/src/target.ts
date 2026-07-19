import { nip19 } from 'nostr-tools';

const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/;
const MAXIMUM_RELAYS = 16;

export interface Nip17Target {
  readonly receiverPublicKey: string;
  readonly relayUrls: readonly string[];
}

export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Nostr relay URL is invalid');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Nostr relay URL must use WSS or loopback WS');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('Nostr relay URL cannot contain credentials or a fragment');
  }
  return url.href;
}

export function decodeNip17Target(
  target: string,
  tags: readonly (readonly string[])[] | undefined,
): Nip17Target {
  if (!tags?.some((tag) => tag.length === 2 && tag[0] === 'n' && tag[1] === '17')) {
    throw new Error('Nostr transport does not declare NIP-17');
  }
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(target);
  } catch {
    throw new Error('NIP-17 transport target must be an nprofile');
  }
  if (decoded.type !== 'nprofile') {
    throw new Error('NIP-17 transport target must be an nprofile');
  }
  const receiverPublicKey = decoded.data.pubkey;
  if (!HEX_PUBLIC_KEY.test(receiverPublicKey))
    throw new Error('Nostr receiver public key is invalid');
  const relayValues = decoded.data.relays ?? [];
  if (relayValues.length < 1 || relayValues.length > MAXIMUM_RELAYS) {
    throw new Error('NIP-17 nprofile must identify from 1 to 16 relays');
  }
  const relayUrls = [...new Set(relayValues.map(normalizeRelayUrl))];
  if (relayUrls.length !== relayValues.length) throw new Error('NIP-17 relay URLs must be unique');
  return { receiverPublicKey, relayUrls };
}
