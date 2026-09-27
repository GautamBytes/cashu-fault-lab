import { PaymentRequest } from '@cashu/cashu-ts';
import { bech32m } from '@scure/base';
import { nip19 } from 'nostr-tools';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  PAYMENT_REQUEST_PROFILE,
  PAYMENT_REQUEST_SPEC,
  paymentRequestVectors,
  type CodecId,
  type PaymentRequestVector,
  type RequestFields,
} from './payment-request-vectors.js';

interface RawRequest {
  i?: string;
  a?: bigint | string | number;
  u?: string;
  s?: boolean;
  m?: string[];
  d?: string;
  t?: { t: string; a: string; g?: string[][] }[];
  nut10?: { k: string; d: string; t?: string[][] | null };
  mp?: boolean;
  sm?: { mn: string; mf?: string }[];
}
export type CodecObservation =
  | { accepted: false }
  | {
      accepted: true;
      request: RequestFields;
      encoded: string | null;
    };

function normalize(raw: RawRequest): RequestFields {
  if (raw.a != null && typeof raw.a !== 'bigint' && typeof raw.a !== 'string')
    throw Error('Codec amounts must be lossless decimal strings');
  return {
    i: raw.i ?? null,
    a: raw.a?.toString() ?? null,
    u: raw.u ?? null,
    s: raw.s ?? false,
    m: raw.m ?? [],
    d: raw.d ?? null,
    t: (raw.t ?? []).map((transport) => {
      let target = transport.a;
      let relays: string[] = [];
      if (transport.t === 'nostr') {
        const decoded = nip19.decode(target);
        if (decoded.type === 'npub') target = decoded.data;
        else if (decoded.type === 'nprofile') {
          target = decoded.data.pubkey;
          relays = decoded.data.relays ?? [];
        } else throw Error('Codec returned an invalid Nostr target');
      }
      return {
        t: transport.t,
        a: target,
        relays,
        g: (transport.g ?? []).filter((tag) => transport.t !== 'nostr' || tag[0] !== 'r'),
      };
    }),
    nut10: raw.nut10 ? { k: raw.nut10.k, d: raw.nut10.d, t: raw.nut10.t ?? [] } : null,
    mp: raw.mp ?? false,
    sm: (raw.sm ?? []).map((method) => ({ mn: method.mn, mf: method.mf ?? '0' })),
  };
}

export function observeCashuTs(encoded: string): CodecObservation {
  let request: PaymentRequest;
  try {
    request = PaymentRequest.fromEncodedRequest(encoded);
  } catch {
    return { accepted: false };
  }
  let output: string | null = null;
  try {
    output = request.toEncodedCreqB();
  } catch {
    /* Encoding failure remains visible. */
  }
  return { accepted: true, request: normalize(request.toRawRequest()), encoded: output };
}

async function observeCdk(binary: string, encoded: string): Promise<CodecObservation> {
  const input = JSON.stringify({ encoded });
  if (Buffer.byteLength(input) > 65536) throw Error('Codec input exceeds 64 KiB');
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      binary,
      [],
      {
        timeout: 5000,
        maxBuffer: 65536,
        encoding: 'utf8',
        killSignal: 'SIGKILL',
      },
      (error, stdout) => {
        if (error)
          reject(Error('Native CDK codec failed; build and provide --cdk-codec', { cause: error }));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => {}); // Early process exit is reported by execFile.
    child.stdin?.end(input);
  });
  const value = JSON.parse(stdout);
  if (value?.accepted === false && Object.keys(value).length === 1) return { accepted: false };
  if (
    value?.accepted !== true ||
    !value.raw ||
    typeof value.raw !== 'object' ||
    (typeof value.encoded !== 'string' && value.encoded !== null)
  )
    throw Error('Invalid native CDK codec response');
  return { accepted: true, request: normalize(value.raw), encoded: value.encoded };
}

export function assessCodecObservation(
  vector: PaymentRequestVector,
  codec: CodecId,
  observation: CodecObservation,
  stage = 0,
): { status: 'passed' | 'known_gap' | 'failed'; code: string } {
  if (!observation.accepted)
    return vector.reject
      ? { status: 'passed', code: 'REJECTED_INVALID_INPUT' }
      : { status: 'failed', code: 'REJECTED_VALID_INPUT' };
  if (!observation.encoded) return { status: 'failed', code: 'ENCODING_FAILED' };
  try {
    if (
      bech32m.decode(observation.encoded, false).prefix !== 'creqb' ||
      observation.encoded !== observation.encoded.toUpperCase()
    )
      return { status: 'failed', code: 'INVALID_REENCODING' };
  } catch {
    return { status: 'failed', code: 'INVALID_REENCODING' };
  }
  if (!vector.reject && isDeepStrictEqual(observation.request, vector.expected))
    return { status: 'passed', code: 'FIELDS_PRESERVED' };
  const gap = vector.gaps?.[codec];
  if (
    gap &&
    (!gap.stages || gap.stages.includes(stage)) &&
    isDeepStrictEqual(observation.request, gap.observed)
  )
    return { status: 'known_gap', code: gap.code };
  return { status: 'failed', code: vector.reject ? 'ACCEPTED_INVALID_INPUT' : 'FIELDS_CHANGED' };
}

export async function runPaymentRequestMatrix(binary: string) {
  const codecs = {
    'cashu-ts': async (encoded: string) => observeCashuTs(encoded),
    cdk: (encoded: string) => observeCdk(binary, encoded),
  };
  const results = [];
  for (const vector of paymentRequestVectors) {
    for (const origin of ['cashu-ts', 'cdk'] as const) {
      const peer = origin === 'cashu-ts' ? 'cdk' : 'cashu-ts';
      const stages: CodecId[] = vector.reject ? [origin] : [origin, peer, origin];
      let encoded = vector.encoded;
      for (const [stage, codec] of stages.entries()) {
        const observation = await codecs[codec]!(encoded);
        const assessment = assessCodecObservation(vector, codec, observation, stage);
        results.push({
          vector: vector.id,
          origin,
          codec,
          stage,
          inputSha256: createHash('sha256').update(encoded).digest('hex'),
          ...assessment,
          observation,
        });
        if (!observation.accepted || !observation.encoded || assessment.status === 'failed') break;
        encoded = observation.encoded;
      }
    }
  }
  const failed = results.some((result) => result.status === 'failed');
  const gaps = results.some((result) => result.status === 'known_gap');
  return {
    schemaVersion: 1,
    profile: PAYMENT_REQUEST_PROFILE,
    spec: PAYMENT_REQUEST_SPEC,
    implementations: { 'cashu-ts': '4.7.2', cdk: '0.17.3' },
    evidence: 'offline-codec-only',
    regressionGate: failed ? 'failed' : 'passed',
    conformance: failed || gaps ? 'incomplete' : 'passed',
    vectors: paymentRequestVectors.length,
    results,
  };
}
