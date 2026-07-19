import { parseDeliveryPayloadJson } from '@cashu-fault-lab/delivery-core';
import {
  buildReceiverHttpServer,
  MemoryReceiverStore,
  type MintGateway,
  type ProofVerifier,
} from '@cashu-fault-lab/reference-receiver';
import { HttpPaymentTransport } from '@cashu-fault-lab/reference-sender';
import {
  ScenarioRunner,
  type DriverSendResult,
  type FaultRule,
  type ScenarioDriver,
  type ScenarioRunResult,
  type ScenarioSpec,
} from './runner.js';

type SecurityMode = 'redirect-leak.json' | 'ssrf.json' | 'cors.json' | 'malformed-input.json';

const requestId = 'AAECAwQFBgcICQoLDA0ODw';
const payload = new TextEncoder().encode('{"profile":"security-probe"}');

async function redirectProbe(): Promise<Readonly<Record<string, unknown>>> {
  const destinations: string[] = [];
  let redirectMode: RequestInit['redirect'];
  const transport = new HttpPaymentTransport({
    timeoutMs: 1_000,
    resolveHost: async () => ['8.8.8.8'],
    fetch: async (input, init) => {
      destinations.push(String(input));
      redirectMode = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://attacker.example/collect' },
      });
    },
  });
  const result = await transport.send(
    payload,
    { type: 'post', target: 'https://merchant.example/pay' },
    new AbortController().signal,
  );
  if (
    result.kind !== 'permanent_failure' ||
    result.status !== 302 ||
    redirectMode !== 'manual' ||
    destinations.length !== 1 ||
    destinations[0] !== 'https://merchant.example/pay'
  ) {
    throw new Error('Redirect security probe failed');
  }
  return { followedRedirect: false, proofLeak: false };
}

async function ssrfProbe(): Promise<Readonly<Record<string, unknown>>> {
  let fetchCalls = 0;
  const transport = new HttpPaymentTransport({
    timeoutMs: 1_000,
    resolveHost: async () => ['127.0.0.1'],
    fetch: async () => {
      fetchCalls += 1;
      return new Response(null, { status: 500 });
    },
  });
  let blocked = false;
  try {
    await transport.send(
      payload,
      { type: 'post', target: 'https://merchant.example/pay' },
      new AbortController().signal,
    );
  } catch (error) {
    blocked = error instanceof Error && /private network/i.test(error.message);
  }
  if (!blocked || fetchCalls !== 0) throw new Error('SSRF security probe failed');
  return { dnsRebindingBlocked: true, proofLeak: false };
}

async function corsProbe(): Promise<Readonly<Record<string, unknown>>> {
  const app = await buildReceiverHttpServer({
    accept: {
      store: new MemoryReceiverStore(),
      mint: {} as MintGateway,
      verifier: {} as ProofVerifier,
      now: () => 1_784_399_400,
    },
    corsOrigins: ['https://shop.example'],
  });
  try {
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/pay',
      headers: {
        origin: 'https://shop.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/pay',
      headers: {
        origin: 'https://attacker.example',
        'access-control-request-method': 'POST',
      },
    });
    if (
      allowed.headers['access-control-allow-origin'] !== 'https://shop.example' ||
      allowed.headers['access-control-allow-credentials'] !== undefined ||
      denied.headers['access-control-allow-origin'] !== undefined
    ) {
      throw new Error('CORS security probe failed');
    }
    return { trustedOriginAllowed: true, untrustedOriginAllowed: false, credentialsAllowed: false };
  } finally {
    await app.close();
  }
}

function stableFailure(input: Uint8Array): string {
  try {
    parseDeliveryPayloadJson(input, 1_784_399_400);
    return 'accepted';
  } catch (error) {
    if (!(error instanceof Error)) return 'Error:unknown';
    const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
    return `${code}:${error.message}`;
  }
}

function malformedProbe(): Readonly<Record<string, unknown>> {
  const corpus = [
    Uint8Array.of(0xff),
    new TextEncoder().encode('{'),
    new TextEncoder().encode('null'),
    new TextEncoder().encode('{"proofs":[]}'),
    new TextEncoder().encode('x'.repeat(65_537)),
  ];
  const first = corpus.map(stableFailure);
  const second = corpus.map(stableFailure);
  if (first.includes('accepted') || first.some((value, index) => value !== second[index])) {
    throw new Error('Malformed-input security probe failed');
  }
  return { corpusCases: corpus.length, stableFailures: true };
}

class SecurityDriver implements ScenarioDriver {
  #configured = false;

  constructor(private readonly mode: SecurityMode) {}

  async reset(): Promise<void> {
    this.#configured = false;
  }

  async capabilities(): Promise<Readonly<Record<string, unknown>>> {
    return {
      sender: 'reference-ts',
      receiver: 'reference-ts',
      securityProbe: this.mode,
    };
  }

  async configureFault(_target: string, _rule: FaultRule): Promise<void> {
    this.#configured = true;
  }

  async send(sender: string, selectedRequestId: string): Promise<DriverSendResult> {
    if (!this.#configured || sender !== 'reference' || selectedRequestId !== requestId) {
      throw new Error('Security scenario is not configured');
    }
    const value =
      this.mode === 'redirect-leak.json'
        ? await redirectProbe()
        : this.mode === 'ssrf.json'
          ? await ssrfProbe()
          : this.mode === 'cors.json'
            ? await corsProbe()
            : malformedProbe();
    return { value, observations: [] };
  }

  async restart(): Promise<void> {
    throw new Error('Restart is unsupported by security lane');
  }

  async clearFaults(): Promise<void> {}
}

function securityMode(name: string): SecurityMode | undefined {
  if (name === 'security-redirect-leak') return 'redirect-leak.json';
  if (name === 'security-ssrf') return 'ssrf.json';
  if (name === 'security-cors') return 'cors.json';
  if (name === 'security-malformed-input') return 'malformed-input.json';
  return undefined;
}

export async function runReferenceSecurityScenario(
  spec: ScenarioSpec,
  seed: string,
): Promise<ScenarioRunResult> {
  const mode = securityMode(spec.name);
  if (!mode) throw new Error(`Unknown security scenario: ${spec.name}`);
  return new ScenarioRunner(new SecurityDriver(mode)).run(spec, seed);
}
