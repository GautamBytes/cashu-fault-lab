import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HttpCashuTsLifecycleLightningProbe } from '../src/lifecycle/lightning-probe.js';

afterEach(() => vi.restoreAllMocks());

describe('HTTP lifecycle Lightning settlement probe', () => {
  test('requires an authenticated response bound to the invoice and quote', async () => {
    const invoice = 'lnbcrt1-lifecycle-fixture';
    const quoteHash = 'a'.repeat(64);
    const expectedInvoiceHash = createHash('sha256')
      .update('cashu-fault-lab/lightning-invoice/v1\0')
      .update(invoice)
      .digest('hex');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ settled: true, invoiceHash: expectedInvoiceHash, quoteHash }),
      );
    const probe = new HttpCashuTsLifecycleLightningProbe({
      url: 'http://127.0.0.1:9080/v1/settlement',
      token: 'lightning-probe-control-token',
    });

    await expect(probe.settled(invoice, quoteHash)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:9080/v1/settlement'),
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: expect.objectContaining({
          authorization: 'Bearer lightning-probe-control-token',
        }),
      }),
    );
  });

  test('fails closed for mismatched evidence, redirects, and external HTTP probes', async () => {
    const probe = new HttpCashuTsLifecycleLightningProbe({
      url: 'http://127.0.0.1:9080/v1/settlement',
      token: 'lightning-probe-control-token',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        { settled: true, invoiceHash: 'b'.repeat(64), quoteHash: 'c'.repeat(64) },
        { status: 302 },
      ),
    );
    await expect(probe.settled('invoice', 'c'.repeat(64))).resolves.toBe(false);

    expect(
      () =>
        new HttpCashuTsLifecycleLightningProbe({
          url: 'http://probe.example/v1/settlement',
          token: 'lightning-probe-control-token',
          allowUnsafeExternal: true,
        }),
    ).toThrow('explicit HTTPS opt-in');
  });
});
