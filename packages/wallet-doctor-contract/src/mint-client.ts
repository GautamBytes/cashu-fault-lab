import type { MintObservation, ProofState } from '@cashu-fault-lab/wallet-doctor-core';

const DEFAULT_TIMEOUT_MS = 10_000;
const VALID_STATES: ReadonlySet<string> = new Set(['UNSPENT', 'SPENT', 'PENDING']);

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * NUT-07 checkstate for a batch of proof `y` values against one mint.
 * Read-only: the request is exactly what any wallet sends to check proofs.
 */
export async function checkProofStates(
  mint: string,
  ys: readonly string[],
  options: { timeoutMs?: number; fetchFn?: FetchLike } = {},
): Promise<readonly MintObservation[]> {
  if (ys.length === 0) return [];
  const fetchImpl = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${mint}/v1/checkstate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Ys: [...ys] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`mint ${mint} checkstate returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as { states?: unknown }).states)
    ) {
      throw new Error(`mint ${mint} checkstate response is invalid`);
    }
    const states: MintObservation[] = [];
    for (const entry of (body as { states: unknown[] }).states) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { Y?: unknown }).Y !== 'string' ||
        typeof (entry as { state?: unknown }).state !== 'string' ||
        !VALID_STATES.has((entry as { state: string }).state)
      ) {
        throw new Error(`mint ${mint} checkstate entry is invalid`);
      }
      states.push({
        mint,
        y: (entry as { Y: string }).Y,
        state: (entry as { state: string }).state as ProofState,
      });
    }
    return states;
  } finally {
    clearTimeout(timeout);
  }
}
