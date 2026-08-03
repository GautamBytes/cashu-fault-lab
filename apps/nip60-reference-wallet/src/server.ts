import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { generateSecretKey } from 'nostr-tools';
import {
  deriveFixtureKey,
  DoctorWallet,
  SPEND_MODES,
  type FixtureMintWallet,
  type PublishFn,
  type SpendMode,
} from './wallet.js';

const PREFIX = '/v1/doctor-wallet';
const MAXIMUM_BODY_BYTES = 65_536;

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAXIMUM_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new Error('Request body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

export interface FixtureServerOptions {
  readonly mint: string;
  /** Mint URL published into NIP-60 payloads when it differs from `mint`. */
  readonly publicMint?: string;
  readonly relays: readonly string[];
  readonly token: string;
  readonly walletFactory: (mint: string) => FixtureMintWallet;
  readonly publish: PublishFn;
}

export interface DoctorWalletFixture {
  server: Server;
  wallet: DoctorWallet;
}

/**
 * Lab-only reference NIP-60 wallet. Loopback, bearer-token control plane;
 * the `/subject` route exposes the generated test key so the harness can run
 * captures. This is a test fixture, never a real wallet.
 */
export function createFixtureServer(options: FixtureServerOptions): DoctorWalletFixture {
  if (options.token.length < 4) throw new Error('Fixture control token is too short');
  const publicMint = options.publicMint ?? options.mint;
  const fixture: DoctorWalletFixture = {
    server: undefined as unknown as Server,
    wallet: new DoctorWallet({
      mint: options.mint,
      publicMint,
      relays: options.relays,
      secretKey: generateSecretKey(),
      wallet: options.walletFactory(options.mint),
      publish: options.publish,
    }),
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (!url.pathname.startsWith(PREFIX)) {
        json(response, 404, { code: 'NOT_FOUND', message: 'Route not found' });
        return;
      }
      if (!secureEqual(request.headers.authorization ?? '', `Bearer ${options.token}`)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        json(response, 401, { code: 'UNAUTHORIZED', message: 'Valid control token required' });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${PREFIX}/capabilities`) {
        json(response, 200, {
          schemaVersion: 1,
          kind: 'nip60-reference-wallet',
          mint: options.mint,
          publicMint,
          relays: options.relays.length,
          operations: ['capabilities', 'reset', 'subject', 'mint', 'spend', 'state'],
          spendModes: SPEND_MODES,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${PREFIX}/subject`) {
        json(response, 200, {
          pubkey: fixture.wallet.pubkey,
          secretKeyHex: fixture.wallet.secretKeyHex,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === `${PREFIX}/state`) {
        json(response, 200, {
          balance: fixture.wallet.balance,
          proofCount: fixture.wallet.proofCount,
          currentTokenEventId: fixture.wallet.currentTokenEventId,
          publishedEvents: fixture.wallet.publishedEvents,
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${PREFIX}/reset`) {
        const body = await readBody(request);
        const seed = body.seed;
        if (seed !== undefined && typeof seed !== 'string') {
          throw new Error('seed must be a string');
        }
        const secretKey =
          seed === undefined ? generateSecretKey() : deriveFixtureKey(`fixture-reset\0${seed}`);
        fixture.wallet = new DoctorWallet({
          mint: options.mint,
          publicMint,
          relays: options.relays,
          secretKey,
          wallet: options.walletFactory(options.mint),
          publish: options.publish,
        });
        const walletEventId = await fixture.wallet.publishWalletEvent();
        json(response, 200, { pubkey: fixture.wallet.pubkey, walletEventId });
        return;
      }

      if (request.method === 'POST' && url.pathname === `${PREFIX}/mint`) {
        const body = await readBody(request);
        if (!Number.isSafeInteger(body.amount) || (body.amount as number) < 1) {
          throw new Error('amount must be a positive integer');
        }
        const result = await fixture.wallet.mintTokens(body.amount as number);
        json(response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === `${PREFIX}/spend`) {
        const body = await readBody(request);
        if (!Number.isSafeInteger(body.amount) || (body.amount as number) < 1) {
          throw new Error('amount must be a positive integer');
        }
        if (typeof body.mode !== 'string' || !SPEND_MODES.includes(body.mode as SpendMode)) {
          throw new Error(`mode must be one of ${SPEND_MODES.join(', ')}`);
        }
        const result = await fixture.wallet.spend(body.amount as number, body.mode as SpendMode);
        json(response, 200, result);
        return;
      }

      json(response, 404, { code: 'NOT_FOUND', message: 'Route not found' });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Request failed';
      if (!response.headersSent) json(response, 400, { code: 'BAD_REQUEST', message });
    });
  });

  fixture.server = server;
  return fixture;
}
