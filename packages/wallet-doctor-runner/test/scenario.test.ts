import { readdir, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import WebSocket from 'ws';
import { NostrFaultRelay } from '@cashu-fault-lab/nostr-fault-relay';
import type { Event } from 'nostr-tools';
import {
  createFixtureServer,
  type DoctorWalletFixture,
  type FixtureMintWallet,
  type FixtureProof,
} from '@cashu-fault-lab/nip60-reference-wallet';
import { proofY } from '@cashu-fault-lab/wallet-doctor-contract';
import {
  executeDoctorScenario,
  replayDoctorScenario,
  runDoctorMatrix,
  validateWalletDoctorScenario,
  type DoctorRunEndpoints,
  type WalletDoctorScenario,
} from '../src/index.js';

const FIXTURE_TOKEN = 'lab-only-doctor-fixture-token';
const CONTROL_TOKEN = 'lab-only-doctor-relay-token';
const MINT = 'http://127.0.0.1:3338';

function fakeProof(amount: number, secret: string): FixtureProof {
  return { id: '00ad268c4d1f5826', amount, secret, C: '02' + 'ab'.repeat(32) };
}

/** Fake mint with honest NUT-07 semantics: swaps spend every input proof. */
function trackedMintWallet(states: Map<string, 'UNSPENT' | 'SPENT'>): FixtureMintWallet {
  let counter = 0;
  return {
    mintProofs: (amount: number) => {
      counter += 1;
      const proof = fakeProof(amount, `minted-${counter}`);
      states.set(proofY(proof.secret), 'UNSPENT');
      return Promise.resolve([proof]);
    },
    send: (amount: number, proofs: readonly FixtureProof[]) => {
      const total = proofs.reduce((sum, proof) => sum + proof.amount, 0);
      if (amount > total) return Promise.reject(new Error('amount exceeds balance'));
      for (const proof of proofs) states.set(proofY(proof.secret), 'SPENT');
      counter += 1;
      const change = total - amount;
      const keep = change > 0 ? [fakeProof(change, `change-${counter}`)] : [];
      for (const proof of keep) states.set(proofY(proof.secret), 'UNSPENT');
      return Promise.resolve({ send: [fakeProof(amount, `sent-${counter}`)], keep });
    },
  };
}

async function publish(relayUrl: string, event: Event): Promise<void> {
  const socket = new WebSocket(relayUrl);
  await once(socket, 'open');
  socket.send(JSON.stringify(['EVENT', event]));
  await new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as unknown[];
      if (message[0] === 'OK' && message[1] === event.id) {
        socket.close();
        if (message[2] === true) resolve();
        else reject(new Error(`rejected: ${String(message[3])}`));
      }
    });
  });
}

async function startRelayControl(relay: NostrFaultRelay): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== `Bearer ${CONTROL_TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'DELETE' && url.pathname === '/v1/faults') {
        relay.control.clear();
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"cleared":true}');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/faults/reset') {
        relay.control.clear();
        relay.clearEvents();
        response.writeHead(200, { 'content-type': 'application/json' }).end('{"reset":true}');
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/faults/partition') {
        let body = '';
        request.on('data', (chunk: Buffer) => (body += chunk.toString()));
        request.on('end', () => {
          relay.control.setPartition(JSON.parse(body));
          response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        });
        return;
      }
      response.writeHead(404).end();
    })().catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

interface Lab {
  readonly fixture: DoctorWalletFixture;
  readonly fixtureUrl: string;
  readonly relayA: NostrFaultRelay;
  readonly relayB: NostrFaultRelay;
  readonly relayC: NostrFaultRelay;
  readonly controlA: Server;
  readonly controlB: Server;
  readonly controlC: Server;
  readonly states: Map<string, 'UNSPENT' | 'SPENT'>;
  readonly endpoints: DoctorRunEndpoints;
}

async function startLab(): Promise<Lab> {
  const relayA = new NostrFaultRelay();
  const relayB = new NostrFaultRelay();
  const relayC = new NostrFaultRelay();
  const urlA = await relayA.listen(0);
  const urlB = await relayB.listen(0);
  const urlC = await relayC.listen(0);
  const controlA = await startRelayControl(relayA);
  const controlB = await startRelayControl(relayB);
  const controlC = await startRelayControl(relayC);
  const states = new Map<string, 'UNSPENT' | 'SPENT'>();
  const fixture = createFixtureServer({
    mint: MINT,
    relays: [urlA, urlB, urlC],
    token: FIXTURE_TOKEN,
    walletFactory: () => trackedMintWallet(states),
    publish,
  });
  await new Promise<void>((resolve) => fixture.server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${(fixture.server.address() as { port: number }).port}`;
  const controlUrlOf = (server: Server): string =>
    `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    fixture,
    fixtureUrl,
    relayA,
    relayB,
    relayC,
    controlA,
    controlB,
    controlC,
    states,
    endpoints: {
      fixtureUrl,
      fixtureToken: FIXTURE_TOKEN,
      relays: [
        { url: urlA, controlUrl: controlUrlOf(controlA), controlToken: CONTROL_TOKEN },
        { url: urlB, controlUrl: controlUrlOf(controlB), controlToken: CONTROL_TOKEN },
        { url: urlC, controlUrl: controlUrlOf(controlC), controlToken: CONTROL_TOKEN },
      ],
    },
  };
}

async function stopLab(lab: Lab): Promise<void> {
  await new Promise<void>((resolve) => lab.fixture.server.close(() => resolve()));
  await new Promise<void>((resolve) => lab.controlA.close(() => resolve()));
  await new Promise<void>((resolve) => lab.controlB.close(() => resolve()));
  await new Promise<void>((resolve) => lab.controlC.close(() => resolve()));
  await lab.relayA.close();
  await lab.relayB.close();
  await lab.relayC.close();
}

async function loadPackagedScenarios(): Promise<readonly WalletDoctorScenario[]> {
  const directory = new URL('../../../scenarios/wallet-doctor/', import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  const scenarios: WalletDoctorScenario[] = [];
  for (const file of files) {
    scenarios.push(
      validateWalletDoctorScenario(JSON.parse(await readFile(new URL(file, directory), 'utf8'))),
    );
  }
  return scenarios;
}

describe('packaged wallet-doctor scenario catalog', () => {
  it('contains nine valid scenarios', async () => {
    expect(await loadPackagedScenarios()).toHaveLength(9);
  });
});

describe('packaged wallet-doctor scenarios (golden in-process lane)', () => {
  it('every packaged scenario produces its expected diagnosis', async () => {
    const lab = await startLab();
    try {
      const scenarios = await loadPackagedScenarios();
      expect(scenarios).toHaveLength(9);
      const hooks = {
        checkStates: (mint: string, ys: readonly string[]) =>
          Promise.resolve(
            ys.map((y) => ({ mint, y, state: lab.states.get(y) ?? ('UNSPENT' as const) })),
          ),
      };
      const matrix = await runDoctorMatrix(
        'nip60-doctor-v1',
        scenarios,
        'golden-seed',
        lab.endpoints,
        hooks,
      );
      const failures = matrix.results.filter((result) => result.status !== 'passed');
      expect(
        failures,
        `failing scenarios: ${failures.map((result) => `${result.scenarioId}: ${result.failures.join('; ')}`).join(' | ')}`,
      ).toEqual([]);
      expect(matrix.ok).toBe(true);
    } finally {
      await stopLab(lab);
    }
  }, 60_000);

  it('replay reproduces the artifact diagnosis with the original seed', async () => {
    const lab = await startLab();
    try {
      const scenarios = await loadPackagedScenarios();
      const scenario = scenarios.find((entry) => entry.id === 'del-chain-break');
      expect(scenario).toBeDefined();
      const hooks = {
        checkStates: (mint: string, ys: readonly string[]) =>
          Promise.resolve(
            ys.map((y) => ({ mint, y, state: lab.states.get(y) ?? ('UNSPENT' as const) })),
          ),
      };
      const artifact = await executeDoctorScenario(
        scenario as WalletDoctorScenario,
        'replay-seed',
        lab.endpoints,
        hooks,
      );
      expect(artifact.passed).toBe(true);
      const replay = await replayDoctorScenario(
        artifact,
        scenario as WalletDoctorScenario,
        'replay-seed',
        lab.endpoints,
        hooks,
      );
      expect(replay.differences).toEqual([]);
      expect(replay.verified).toBe(true);
      await expect(
        replayDoctorScenario(
          artifact,
          scenario as WalletDoctorScenario,
          'wrong-seed',
          lab.endpoints,
          hooks,
        ),
      ).rejects.toThrow(/seed does not match/u);
    } finally {
      await stopLab(lab);
    }
  }, 60_000);
});

describe('validateWalletDoctorScenario', () => {
  it('keeps the normative schema aligned with relay-partition runtime requirements', async () => {
    const schema = JSON.parse(
      await readFile(
        new URL('../../../spec/schemas/wallet-doctor-scenario.schema.json', import.meta.url),
        'utf8',
      ),
    ) as object;
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const targetless = {
      schemaVersion: 1,
      id: 'partition',
      name: 'partition',
      description: 'partition',
      commands: [{ op: 'relay-partition', relay: 0 }],
      expect: { codes: [], ok: true },
    };
    expect(validate(targetless)).toBe(false);
    expect(() => validateWalletDoctorScenario(targetless)).toThrow(/withhold/u);

    const bounded = {
      ...targetless,
      commands: [{ op: 'relay-partition', relay: 0, kinds: [7375] }],
    };
    expect(validate(bounded)).toBe(true);
    expect(validateWalletDoctorScenario(bounded).commands[0]?.kinds).toEqual([7375]);

    const irrelevant = {
      ...targetless,
      commands: [{ op: 'mint', amount: 1, relay: 64 }],
    };
    expect(validate(irrelevant)).toBe(false);
    expect(() => validateWalletDoctorScenario(irrelevant)).toThrow(/unknown property relay/u);
  });

  it('rejects malformed specs', () => {
    expect(() => validateWalletDoctorScenario({ schemaVersion: 2 })).toThrow(/invalid/u);
    expect(() =>
      validateWalletDoctorScenario({
        schemaVersion: 1,
        id: 'BAD',
        name: 'x',
        description: 'x',
        commands: [{ op: 'mint', amount: 1 }],
        expect: { codes: [], ok: true },
      }),
    ).toThrow(/id/u);
    expect(() =>
      validateWalletDoctorScenario({
        schemaVersion: 1,
        id: 'ok',
        name: 'x',
        description: 'x',
        commands: [{ op: 'spend', amount: 1, mode: 'sideways' }],
        expect: { codes: [], ok: true },
      }),
    ).toThrow(/mode/u);
    expect(() =>
      validateWalletDoctorScenario({
        schemaVersion: 1,
        id: 'ok',
        name: 'x',
        description: 'x',
        commands: [{ op: 'relay-partition', relay: 0 }],
        expect: { codes: [], ok: true },
      }),
    ).toThrow(/withhold/u);
  });
});
