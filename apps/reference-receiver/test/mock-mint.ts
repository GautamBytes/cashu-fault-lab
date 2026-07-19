import { pointFromHex } from '@cashu/cashu-ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

const generator = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const privateKey = 2n;
const publicKey = pointFromHex(generator).multiply(privateKey).toHex(true);
export const mockKeysetId = '009a1f293253e41e';

interface WireOutput {
  readonly amount: number;
  readonly id: string;
  readonly B_: string;
}

interface WireSignature {
  readonly amount: number;
  readonly id: string;
  readonly C_: string;
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function signatures(outputs: readonly WireOutput[]): WireSignature[] {
  return outputs.map((output) => ({
    amount: output.amount,
    id: output.id,
    C_: pointFromHex(output.B_).multiply(privateKey).toHex(true),
  }));
}

export class MockMintServer {
  readonly #server: Server;
  readonly #signed = new Map<string, WireSignature>();
  url = '';
  swapBodies: string[] = [];
  swapCalls = 0;
  restoreCalls = 0;
  dropNextSwapResponse = false;
  failNextKeys = false;

  constructor(
    readonly options: {
      readonly nut09: boolean;
      readonly nut19Ttl: number | null;
      readonly inputFeePpk?: number;
      readonly keysUnit?: string;
    },
  ) {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Mock mint did not bind TCP');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://mint.invalid').pathname;
    if (request.method === 'GET' && path === '/v1/info') {
      const nuts: Record<string, unknown> = {
        '4': {
          methods: [{ method: 'bolt11', unit: 'sat', min_amount: 0, max_amount: 1_000_000 }],
          disabled: false,
        },
        '5': {
          methods: [{ method: 'bolt11', unit: 'sat', min_amount: 0, max_amount: 1_000_000 }],
          disabled: false,
        },
        '7': { supported: true },
        '9': { supported: this.options.nut09 },
        '12': { supported: true },
      };
      if (this.options.nut19Ttl !== null) {
        nuts['19'] = {
          ttl: this.options.nut19Ttl,
          cached_endpoints: [{ method: 'POST', path: '/v1/swap' }],
        };
      }
      json(response, {
        name: 'Mock mint',
        pubkey: publicKey,
        version: 'cashu-fault-lab/1',
        contact: [],
        nuts,
      });
      return;
    }
    if (request.method === 'GET' && path === '/v1/keysets') {
      json(response, {
        keysets: [
          {
            id: mockKeysetId,
            unit: 'sat',
            active: true,
            input_fee_ppk: this.options.inputFeePpk ?? 0,
          },
        ],
      });
      return;
    }
    if (request.method === 'GET' && path === `/v1/keys/${mockKeysetId}`) {
      if (this.failNextKeys) {
        this.failNextKeys = false;
        response.writeHead(503).end();
        return;
      }
      json(response, {
        keysets: [
          { id: mockKeysetId, unit: this.options.keysUnit ?? 'sat', keys: { '8': publicKey } },
        ],
      });
      return;
    }
    if (request.method === 'POST' && path === '/v1/swap') {
      const raw = await body(request);
      this.swapBodies.push(raw);
      this.swapCalls += 1;
      const parsed = JSON.parse(raw) as { readonly outputs: readonly WireOutput[] };
      const signed = signatures(parsed.outputs);
      parsed.outputs.forEach((output, index) => this.#signed.set(output.B_, signed[index]!));
      if (this.dropNextSwapResponse) {
        this.dropNextSwapResponse = false;
        response.destroy(new Error('mock response loss'));
        return;
      }
      json(response, { signatures: signed });
      return;
    }
    if (request.method === 'POST' && path === '/v1/restore') {
      this.restoreCalls += 1;
      const parsed = JSON.parse(await body(request)) as { readonly outputs: readonly WireOutput[] };
      const restored = parsed.outputs.filter((output) => this.#signed.has(output.B_));
      json(response, {
        outputs: restored,
        signatures: restored.map((output) => this.#signed.get(output.B_)!),
      });
      return;
    }
    if (request.method === 'POST' && path === '/v1/checkstate') {
      const parsed = JSON.parse(await body(request)) as { readonly Ys: readonly string[] };
      json(response, {
        states: parsed.Ys.map((Y) => ({ Y, state: 'SPENT', witness: null })),
      });
      return;
    }
    response.writeHead(404).end();
  }
}
