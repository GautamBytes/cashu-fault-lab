import { describe, expect, it } from 'vitest';
import {
  assessCodecObservation,
  observeCashuTs,
  runPaymentRequestMatrix,
} from '../src/payment-request-codecs.js';
import { paymentRequestVectors } from '../src/payment-request-vectors.js';

describe('NUT-26 codec evidence', () => {
  it('decodes the pinned upstream example and preserves its fields', () => {
    const vector = paymentRequestVectors[0]!;
    expect(observeCashuTs(vector.encoded)).toMatchObject({
      accepted: true,
      request: vector.expected,
    });
  });

  it('never substitutes TypeScript for a missing native CDK executable', async () => {
    await expect(runPaymentRequestMatrix('/missing/cdk-payment-request')).rejects.toThrow();
  });

  it.each(paymentRequestVectors)('$id: exercises the actual cashu-ts decoder', (vector) => {
    const observation = observeCashuTs(vector.encoded);
    expect(assessCodecObservation(vector, 'cashu-ts', observation).status).not.toBe('failed');
  });

  it('preserves u64 values without JavaScript number conversion', () => {
    const vector = paymentRequestVectors.find((v) => v.id === 'u64-max')!;
    expect(observeCashuTs(vector.encoded)).toMatchObject({
      accepted: true,
      request: { a: '18446744073709551615' },
    });
  });

  it('detects lost or reordered transport data, even in a known-gap case', () => {
    const vector = paymentRequestVectors.find((v) => v.id === 'transport-priority-and-tags')!;
    const observation = observeCashuTs(vector.encoded);
    if (!observation.accepted) throw Error('Fixture must decode');
    for (const mutate of [
      (r: typeof observation.request) => {
        r.t.reverse();
      },
      (r: typeof observation.request) => {
        r.t[0]!.relays.reverse();
      },
      (r: typeof observation.request) => {
        r.t[0]!.g = [];
      },
      (r: typeof observation.request) => {
        r.t[0]!.a = '00'.repeat(32);
      },
      (r: typeof observation.request) => {
        r.t[1]!.a = 'https://wrong.example.com';
      },
    ]) {
      const changed = structuredClone(observation);
      mutate(changed.request);
      expect(assessCodecObservation(vector, 'cashu-ts', changed, 1).status).toBe('failed');
    }
    const doubled = structuredClone(observation);
    doubled.request.t[0]!.relays.push(...doubled.request.t[0]!.relays);
    expect(assessCodecObservation(vector, 'cashu-ts', doubled, 0).status).toBe('failed');
    expect(assessCodecObservation(vector, 'cashu-ts', doubled, 1).status).toBe('known_gap');
    expect(assessCodecObservation(vector, 'cdk', doubled, 1).status).toBe('failed');
    expect(assessCodecObservation(vector, 'cdk', doubled, 2).status).toBe('known_gap');
  });

  it('does not let a known gap hide unrelated corruption or new invalid acceptance', () => {
    const vector = paymentRequestVectors.find((v) => v.id === 'mint-preferred')!;
    const observation = observeCashuTs(vector.encoded);
    if (!observation.accepted) throw Error('Fixture must decode');
    observation.request.i = 'changed';
    expect(assessCodecObservation(vector, 'cashu-ts', observation).status).toBe('failed');
    const negative = paymentRequestVectors.find((v) => v.id === 'checksum-corruption')!;
    expect(
      assessCodecObservation(
        negative,
        'cashu-ts',
        observeCashuTs(paymentRequestVectors[0]!.encoded),
      ).status,
    ).toBe('failed');
    observation.encoded = null;
    expect(assessCodecObservation(vector, 'cashu-ts', observation).code).toBe('ENCODING_FAILED');
  });
});
