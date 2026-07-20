import { HttpAdapterClient } from '@cashu-fault-lab/adapter-contract';
import { buildFundedCashuTsAdapterServer } from '@cashu-fault-lab/adapter-cashu-ts';
import { buildFundedReceiverAdapterServer } from '@cashu-fault-lab/reference-receiver';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ExternalAdapterScenarioDriver,
  ScenarioRunner,
  runExternalDeliveryPair,
  type ExternalFaultController,
  type ExternalFaultEvidence,
  type FaultRule,
  type ScenarioSpec,
} from '../src/index.js';

const mintUrl = process.env.CFL_REAL_MINT_URL;
const token = 'cross-language-control-token';
const responseLost: ScenarioSpec = {
  name: 'http-response-lost',
  commands: [
    {
      type: 'configure_fault',
      target: 'http',
      rule: { kind: 'drop_response', occurrence: 1 },
    },
    { type: 'send', sender: 'reference', requestId: 'AAECAwQFBgcICQoLDA0ODw' },
    { type: 'assert_quiescent' },
  ],
};
const duplicateDelivery: ScenarioSpec = {
  name: 'http-duplicate-delivery',
  commands: [
    {
      type: 'configure_fault',
      target: 'http',
      rule: { kind: 'duplicate', occurrence: 1, duplicateCount: 9 },
    },
    { type: 'send', sender: 'reference', requestId: 'AAECAwQFBgcICQoLDA0ODw' },
    { type: 'assert_quiescent' },
  ],
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to allocate port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

interface ForwardedResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

class PaymentFaultProxy implements ExternalFaultController {
  readonly #target: string;
  readonly #server: Server;
  #rule: FaultRule | undefined;
  #inbound = 0;
  #forwarded = 0;

  constructor(target: string) {
    this.#target = target;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async listen(port: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, '127.0.0.1', resolve);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async reset(): Promise<void> {
    this.#rule = undefined;
    this.#inbound = 0;
    this.#forwarded = 0;
  }

  async configure(target: string, rule: FaultRule): Promise<void> {
    if (target !== 'http') throw new Error('Test proxy only controls HTTP');
    this.#rule = { ...rule };
  }

  async clear(): Promise<void> {
    this.#rule = undefined;
  }

  async evidence(): Promise<ExternalFaultEvidence> {
    return { inbound: this.#inbound, forwarded: this.#forwarded };
  }

  async #forward(body: Uint8Array): Promise<ForwardedResponse> {
    this.#forwarded += 1;
    const response = await fetch(this.#target, {
      method: 'POST',
      redirect: 'manual',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body,
    });
    const responseBody = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      headers: response.headers,
      body: responseBody,
    };
  }

  async #handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ): Promise<void> {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Uint8Array.from(Buffer.concat(chunks));
      this.#inbound += 1;
      const occurrence = this.#rule?.occurrence ?? 1;
      if (this.#rule?.kind === 'drop_request' && this.#inbound === occurrence) {
        response.destroy();
        return;
      }
      const first = await this.#forward(body);
      if (this.#rule?.kind === 'duplicate' && this.#inbound === occurrence) {
        for (let index = 0; index < (this.#rule.duplicateCount ?? 1); index += 1) {
          const duplicate = await this.#forward(body);
          if (duplicate.status !== first.status) throw new Error('Duplicate response changed');
        }
      }
      if (this.#rule?.kind === 'drop_response' && this.#inbound === occurrence) {
        response.destroy();
        return;
      }
      response.statusCode = first.status;
      const retryAfter = first.headers.get('retry-after');
      if (retryAfter !== null) response.setHeader('retry-after', retryAfter);
      response.setHeader('content-type', 'application/json');
      response.end(first.body);
    } catch {
      response.destroy();
    }
  }
}

async function waitForAdapter(baseUrl: string, process: ChildProcess): Promise<void> {
  let lastError = '';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (process?.exitCode !== null) throw new Error(`CDK adapter exited: ${lastError}`);
    try {
      const response = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Adapter did not start: ${lastError}`);
}

function observations(result: Awaited<ReturnType<ScenarioRunner['run']>>, type: string): number {
  return result.artifact.history.filter(
    (event) => event.phase === 'observation' && event.event === type,
  ).length;
}

const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of cleanup.reverse()) await close();
}, 30_000);

describe.skipIf(!mintUrl)('real funded cross-language delivery', () => {
  it('settles once for cashu-ts and CDK across direct, lost-response, and duplicate delivery', async () => {
    const receiverPort = await freePort();
    const proxyPort = await freePort();
    const senderPort = await freePort();
    const cdkPort = await freePort();
    const receiver = await buildFundedReceiverAdapterServer({
      mintUrl: mintUrl!,
      paymentTarget: `http://127.0.0.1:${proxyPort}/pay`,
      proofClaimKey: Buffer.alloc(32, 17),
      controlToken: token,
    });
    await receiver.listen({ host: '127.0.0.1', port: receiverPort });
    cleanup.push(() => receiver.close());
    const proxy = new PaymentFaultProxy(`http://127.0.0.1:${receiverPort}/pay`);
    await proxy.listen(proxyPort);
    cleanup.push(() => proxy.close());
    const cashu = await buildFundedCashuTsAdapterServer({
      mintUrl: mintUrl!,
      fundingAmount: 64,
      controlToken: token,
    });
    await cashu.listen({ host: '127.0.0.1', port: senderPort });
    cleanup.push(() => cashu.close());

    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const cdkManifest = fileURLToPath(new URL('../../../adapters/cdk/Cargo.toml', import.meta.url));
    const cdk = spawn('cargo', ['run', '--quiet', '--manifest-path', cdkManifest], {
      cwd: root,
      env: {
        ...process.env,
        CASHU_FAULT_LAB_CONTROL_TOKEN: token,
        CASHU_FAULT_LAB_CDK_LISTEN: `127.0.0.1:${cdkPort}`,
        CASHU_FAULT_LAB_CDK_MINT_URL: mintUrl!,
        CASHU_FAULT_LAB_CDK_FUNDING_AMOUNT: '64',
        CASHU_FAULT_LAB_CDK_FUNDING_TIMEOUT_SECONDS: '30',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let cdkErrors = '';
    cdk.stderr?.on('data', (chunk) => {
      cdkErrors += String(chunk);
    });
    cdk.once('error', (error) => {
      cdkErrors += String(error);
    });
    cleanup.push(async () => {
      if (cdk.pid === undefined || cdk.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => cdk.once('exit', () => resolve()));
      if (cdk.exitCode === null) cdk.kill('SIGTERM');
      await exited;
    });
    await waitForAdapter(`http://127.0.0.1:${cdkPort}`, cdk).catch((error) => {
      throw new Error(`${String(error)}\n${cdkErrors}`);
    });

    const receiverClient = new HttpAdapterClient({
      baseUrl: `http://127.0.0.1:${receiverPort}`,
      token,
      timeoutMs: 30_000,
    });
    const senders = [
      new HttpAdapterClient({
        baseUrl: `http://127.0.0.1:${senderPort}`,
        token,
        timeoutMs: 30_000,
      }),
      new HttpAdapterClient({
        baseUrl: `http://127.0.0.1:${cdkPort}`,
        token,
        timeoutMs: 30_000,
      }),
    ];

    for (const [index, sender] of senders.entries()) {
      await proxy.reset();
      const direct = await runExternalDeliveryPair({
        profile: 'delivery-v1',
        seed: `cross-language-direct-${index}`,
        sender,
        receiver: receiverClient,
        amount: 8,
        unit: 'sat',
      });
      expect(direct, `sender=${index} ${JSON.stringify(direct)} ${cdkErrors}`).toMatchObject({
        ok: true,
        evidence: { tier: 'T1', credits: 1 },
      });

      for (const scenario of [responseLost, duplicateDelivery]) {
        const driver = new ExternalAdapterScenarioDriver({
          sender,
          receiver: receiverClient,
          faults: proxy,
          amount: 8,
          unit: 'sat',
          senderAlias: 'reference',
          requestAlias: 'AAECAwQFBgcICQoLDA0ODw',
        });
        const result = await new ScenarioRunner(driver).run(
          scenario,
          `cross-language-${scenario.name}-${index}`,
        );
        expect(result.status, result.status === 'failed' ? result.error.message : '').toBe(
          'passed',
        );
        expect(observations(result, 'redemption_started')).toBe(1);
        expect(observations(result, 'merchant_credited')).toBe(1);
      }
    }
  }, 180_000);
});
