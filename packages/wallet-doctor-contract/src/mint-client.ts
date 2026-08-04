import type { MintObservation, ProofState } from '@cashu-fault-lab/wallet-doctor-core';
import { Agent, fetch as undiciFetch } from 'undici';
import { assertSafeHttpUrl, createPinnedLookup, type HostResolver } from './network-policy.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAXIMUM_PROOFS = 10_000;
const REQUEST_BATCH_SIZE = 256;
const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const VALID_STATES: ReadonlySet<string> = new Set(['UNSPENT', 'SPENT', 'PENDING']);
const COMPRESSED_POINT = /^0[23][0-9a-f]{64}$/u;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function checkStateUrl(mint: string, allowInsecureLoopback: boolean): string {
  const parsed = assertSafeHttpUrl(mint, allowInsecureLoopback);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, '')}/v1/checkstate`;
  return parsed.toString();
}

async function readBoundedJson(response: Response, mint: string): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAXIMUM_RESPONSE_BYTES) {
    throw new Error(`mint ${mint} checkstate response exceeds ${MAXIMUM_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) throw new Error(`mint ${mint} checkstate response is invalid`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`mint ${mint} checkstate response exceeds ${MAXIMUM_RESPONSE_BYTES} bytes`);
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`mint ${mint} checkstate response is invalid JSON`);
  }
}

async function checkBatch(
  mint: string,
  endpoint: string,
  ys: readonly string[],
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<MintObservation[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Ys: [...ys] }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`mint ${mint} checkstate returned HTTP ${response.status}`);
    }
    const body = await readBoundedJson(response, mint);
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as { states?: unknown }).states)
    ) {
      throw new Error(`mint ${mint} checkstate response is invalid`);
    }
    const entries = (body as { states: unknown[] }).states;
    if (entries.length !== ys.length) {
      throw new Error(`mint ${mint} checkstate does not correspond exactly to the requested Ys`);
    }
    return entries.map((entry, index) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { Y?: unknown }).Y !== 'string' ||
        typeof (entry as { state?: unknown }).state !== 'string' ||
        !VALID_STATES.has((entry as { state: string }).state) ||
        (entry as { Y: string }).Y !== ys[index]
      ) {
        throw new Error(`mint ${mint} checkstate does not correspond exactly to the requested Ys`);
      }
      return {
        mint,
        y: (entry as { Y: string }).Y,
        state: (entry as { state: string }).state as ProofState,
      };
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Strict, bounded NUT-07 state verification for one mint. */
export async function checkProofStates(
  mint: string,
  ys: readonly string[],
  options: {
    timeoutMs?: number;
    fetchFn?: FetchLike;
    allowInsecureLoopback?: boolean;
    resolver?: HostResolver;
  } = {},
): Promise<readonly MintObservation[]> {
  if (ys.length === 0) return [];
  if (ys.length > MAXIMUM_PROOFS) {
    throw new Error(`mint ${mint} proof count exceeds ${MAXIMUM_PROOFS}`);
  }
  const seen = new Set<string>();
  for (const y of ys) {
    if (!COMPRESSED_POINT.test(y)) throw new Error(`mint ${mint} received an invalid Y`);
    if (seen.has(y)) throw new Error(`mint ${mint} received a duplicate Y`);
    seen.add(y);
  }
  const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
  const endpoint = checkStateUrl(mint, allowInsecureLoopback);
  const agent =
    options.fetchFn === undefined
      ? new Agent({
          connect: {
            lookup: createPinnedLookup(allowInsecureLoopback, options.resolver),
          },
        })
      : null;
  const fetchImpl: FetchLike =
    options.fetchFn ??
    ((url, init) =>
      undiciFetch(url, {
        method: 'POST',
        headers: init.headers as Record<string, string>,
        body: init.body as string,
        signal: init.signal as AbortSignal,
        redirect: 'error',
        dispatcher: agent as Agent,
      }) as unknown as Promise<Response>);
  const states: MintObservation[] = [];
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    for (let offset = 0; offset < ys.length; offset += REQUEST_BATCH_SIZE) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`mint ${mint} checkstate exceeded its overall timeout`);
      const batch = ys.slice(offset, offset + REQUEST_BATCH_SIZE);
      states.push(...(await checkBatch(mint, endpoint, batch, remaining, fetchImpl)));
    }
  } finally {
    await agent?.close();
  }
  return states;
}
