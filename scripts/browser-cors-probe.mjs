import { createServer } from 'node:http';
import { chromium } from 'playwright';
import {
  buildReceiverHttpServer,
  MemoryReceiverStore,
} from '../apps/reference-receiver/dist/index.js';

async function startOrigin() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Cashu CORS probe</title>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Origin server did not bind TCP');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const trusted = await startOrigin();
const attacker = await startOrigin();
const receiver = await buildReceiverHttpServer({
  accept: {
    store: new MemoryReceiverStore(),
    mint: {},
    verifier: {},
    now: () => 1_784_399_400,
  },
  corsOrigins: [trusted.origin],
});
let browser;

try {
  await receiver.listen({ port: 0, host: '127.0.0.1' });
  const address = receiver.server.address();
  if (!address || typeof address === 'string') throw new Error('Receiver did not bind TCP');
  const paymentUrl = `http://127.0.0.1:${address.port}/pay`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const probe = async (origin, credentials) => {
    await page.goto(origin);
    return page.evaluate(
      async ({ url, credentials }) => {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            credentials,
          });
          await response.text();
          return `readable:${response.status}`;
        } catch {
          return 'blocked';
        }
      },
      { url: paymentUrl, credentials },
    );
  };
  const trustedResult = await probe(trusted.origin, 'omit');
  const trustedCredentialsResult = await probe(trusted.origin, 'include');
  const attackerResult = await probe(attacker.origin, 'omit');
  if (
    trustedResult !== 'readable:422' ||
    trustedCredentialsResult !== 'blocked' ||
    attackerResult !== 'blocked'
  ) {
    throw new Error(
      `Browser CORS invariant failed: trusted=${trustedResult} credentials=${trustedCredentialsResult} attacker=${attackerResult}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ trusted: trustedResult, attacker: attackerResult, credentials: trustedCredentialsResult })}\n`,
  );
} finally {
  await browser?.close();
  await receiver.close();
  await Promise.all([trusted.close(), attacker.close()]);
}
