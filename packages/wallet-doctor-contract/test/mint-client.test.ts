import { describe, expect, it, vi } from 'vitest';
import { checkProofStates } from '../src/index.js';

const Y = (n: number): string => `02${n.toString(16).padStart(64, '0')}`;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('checkProofStates', () => {
  it('enforces exact NUT-07 response length, identity, and ordering', async () => {
    const ys = [Y(1), Y(2)];
    for (const states of [
      [{ Y: ys[0], state: 'UNSPENT' }],
      [
        { Y: ys[1], state: 'UNSPENT' },
        { Y: ys[0], state: 'UNSPENT' },
      ],
      [
        { Y: ys[0], state: 'UNSPENT' },
        { Y: Y(3), state: 'UNSPENT' },
      ],
    ]) {
      await expect(
        checkProofStates('https://mint.example', ys, {
          fetchFn: vi.fn().mockResolvedValue(jsonResponse({ states })),
        }),
      ).rejects.toThrow(/does not correspond exactly to the requested Ys/u);
    }
  });

  it('rejects duplicate or malformed requested Ys', async () => {
    const fetchFn = vi.fn();
    await expect(
      checkProofStates('https://mint.example', [Y(1), Y(1)], { fetchFn }),
    ).rejects.toThrow(/duplicate Y/u);
    await expect(
      checkProofStates('https://mint.example', ['not-a-point'], { fetchFn }),
    ).rejects.toThrow(/invalid Y/u);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('allows HTTP only for explicitly enabled loopback lab mints and refuses redirects', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ states: [{ Y: Y(1), state: 'UNSPENT' }] }));
    await expect(checkProofStates('http://mint.internal', [Y(1)], { fetchFn })).rejects.toThrow(
      /HTTPS/u,
    );
    await expect(checkProofStates('http://127.0.0.1:3338', [Y(1)], { fetchFn })).rejects.toThrow(
      /explicit lab mode/u,
    );
    await checkProofStates('http://127.0.0.1:3338', [Y(1)], {
      fetchFn,
      allowInsecureLoopback: true,
    });
    expect(fetchFn).toHaveBeenCalledWith(
      'http://127.0.0.1:3338/v1/checkstate',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('batches requests and preserves the aggregate order', async () => {
    const ys = Array.from({ length: 257 }, (_, index) => Y(index + 1));
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { Ys: string[] };
      return jsonResponse({
        states: body.Ys.map((YValue) => ({ Y: YValue, state: 'UNSPENT' })),
      });
    });
    const result = await checkProofStates('https://mint.example', ys, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(result.map((entry) => entry.y)).toEqual(ys);
  });

  it('rejects responses larger than the configured body limit', async () => {
    const oversized = JSON.stringify({ padding: 'x'.repeat(1_048_577) });
    await expect(
      checkProofStates('https://mint.example', [Y(1)], {
        fetchFn: vi.fn().mockResolvedValue(
          new Response(oversized, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      }),
    ).rejects.toThrow(/response exceeds/u);
  });
});
