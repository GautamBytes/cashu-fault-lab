import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const systemResolver: HostResolver = async (hostname) => {
  const entries = await dnsLookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
};

function ipv4Octets(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : null;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets === null) return false;
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function ipv6Value(address: string): bigint | null {
  let input = address.toLowerCase();
  const zone = input.indexOf('%');
  if (zone >= 0) input = input.slice(0, zone);
  const ipv4Tail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  if (ipv4Tail !== undefined) {
    const octets = ipv4Octets(ipv4Tail);
    if (octets === null) return null;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    input = input.slice(0, -ipv4Tail.length) + `${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : (halves[0]?.split(':') ?? []);
  const right = halves.length === 1 || halves[1] === '' ? [] : (halves[1]?.split(':') ?? []);
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return null;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function inIpv6Prefix(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === prefix >> shift;
}

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  if (value === null) return false;
  // Only globally routable unicast is accepted. Documentation space is excluded.
  const global = ipv6Value('2000::');
  const documentation = ipv6Value('2001:db8::');
  if (global === null || documentation === null || !inIpv6Prefix(value, global, 3)) return false;
  return !inIpv6Prefix(value, documentation, 32);
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const octets = ipv4Octets(normalized);
  if (octets !== null) return octets[0] === 127;
  const value = ipv6Value(normalized);
  return value === 1n;
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.replace(/^\[|\]$/gu, '');
  const family = isIP(normalized);
  return family === 4 ? isPublicIpv4(normalized) : family === 6 ? isPublicIpv6(normalized) : false;
}

export function assertResolvedAddressesSafe(
  hostname: string,
  addresses: readonly ResolvedAddress[],
  allowInsecureLoopback: boolean,
): readonly ResolvedAddress[] {
  if (addresses.length === 0) throw new Error(`network target ${hostname} did not resolve`);
  for (const entry of addresses) {
    if (isPublicAddress(entry.address)) continue;
    if (allowInsecureLoopback && isLoopbackAddress(entry.address)) continue;
    throw new Error(`network target ${hostname} resolves to a private or reserved address`);
  }
  return addresses;
}

/** DNS resolution used by the actual socket, preventing validate-then-resolve rebinding. */
export function createPinnedLookup(
  allowInsecureLoopback: boolean,
  resolver: HostResolver = systemResolver,
): LookupFunction {
  const lookup = (
    hostname: string,
    _options: unknown,
    callback: (error: Error | null, address?: string, family?: number) => void,
  ): void => {
    void resolver(hostname)
      .then((addresses) => assertResolvedAddressesSafe(hostname, addresses, allowInsecureLoopback))
      .then((addresses) => {
        const selected = addresses[0];
        if (selected === undefined) throw new Error(`network target ${hostname} did not resolve`);
        callback(null, selected.address, selected.family);
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error))),
      );
  };
  return lookup as LookupFunction;
}

export function assertSafeHttpUrl(value: string, allowInsecureLoopback: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`mint URL is invalid: ${value}`);
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(`mint URL must not include credentials, a query, or a fragment: ${value}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const loopback = isLoopbackAddress(host);
  if (parsed.protocol === 'http:' && !(allowInsecureLoopback && loopback)) {
    throw new Error(`mint URL must use HTTPS; loopback HTTP requires explicit lab mode: ${value}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`mint URL must use HTTPS: ${value}`);
  }
  if (isIP(host) !== 0 && !isPublicAddress(host) && !(allowInsecureLoopback && loopback)) {
    throw new Error(`mint URL targets a private or reserved address: ${value}`);
  }
  return parsed;
}

export function assertSafeRelayUrl(value: string, allowInsecureLoopback: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`relay URL is invalid: ${value}`);
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error(`relay URL is invalid: ${value}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const loopback = isLoopbackAddress(host);
  if (parsed.protocol === 'ws:' && !(allowInsecureLoopback && loopback)) {
    throw new Error(`relay URL must use WSS; loopback WS requires explicit lab mode: ${value}`);
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error(`relay URL must use WSS: ${value}`);
  }
  if (isIP(host) !== 0 && !isPublicAddress(host) && !(allowInsecureLoopback && loopback)) {
    throw new Error(`relay URL targets a private or reserved address: ${value}`);
  }
  return parsed;
}
