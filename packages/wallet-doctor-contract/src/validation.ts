import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { captureDigest } from './capture.js';
import type { Nip60Capture } from './types.js';

const HEX64 = '^[0-9a-f]{64}$';
const COMPRESSED_POINT = '^0[23][0-9a-f]{64}$';
const DIGEST = '^sha256:[0-9a-f]{64}$';
const SAFE_INTEGER = 9_007_199_254_740_991;
const MAXIMUM_INTEGRITY_ERRORS = 256;
const MAXIMUM_ARTIFACT_ERROR_LENGTH = 2048;

/**
 * Canonical wire contract for the capture bundle. Mirrored by
 * `spec/schemas/nip60-capture.schema.json`; a contract test fails on drift.
 */
export const NIP60_CAPTURE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://cashu-fault-lab.dev/schemas/nip60-capture.schema.json',
  title: 'NIP-60 Wallet Doctor Capture',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'capturedAt',
    'digest',
    'subject',
    'observation',
    'relayEvidence',
    'redaction',
  ],
  properties: {
    schemaVersion: { const: 2 },
    capturedAt: { type: 'string', maxLength: 64 },
    digest: { type: 'string', pattern: DIGEST },
    subject: { type: 'string', pattern: HEX64 },
    observation: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'relays', 'mint'],
      properties: {
        subject: { type: 'string', pattern: HEX64 },
        relays: {
          type: 'array',
          items: { $ref: '#/$defs/relayObservation' },
          maxItems: 64,
        },
        mint: {
          type: 'array',
          items: { $ref: '#/$defs/mintObservation' },
          maxItems: 10_000,
        },
      },
    },
    relayEvidence: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url', 'status', 'error', 'eventIds'],
        properties: {
          url: { type: 'string', maxLength: 2048 },
          status: { enum: ['ok', 'error'] },
          error: { type: ['string', 'null'], maxLength: 512 },
          eventIds: {
            type: 'array',
            maxItems: 10_000,
            uniqueItems: true,
            items: { type: 'string', pattern: HEX64 },
          },
        },
      },
    },
    redaction: {
      type: 'object',
      additionalProperties: false,
      required: ['proofSecretsDropped', 'encryptedContentsDropped', 'walletPrivateKeyDropped'],
      properties: {
        proofSecretsDropped: { const: true },
        encryptedContentsDropped: { const: true },
        walletPrivateKeyDropped: { const: true },
      },
    },
  },
  $defs: {
    seenOn: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', maxLength: 2048 },
      maxItems: 64,
    },
    proofView: {
      type: 'object',
      additionalProperties: false,
      required: ['keysetId', 'amount', 'y'],
      properties: {
        keysetId: { type: 'string', maxLength: 64 },
        amount: { type: 'integer', minimum: 1, maximum: SAFE_INTEGER },
        y: { type: 'string', pattern: COMPRESSED_POINT },
      },
    },
    tokenEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'mint', 'unit', 'proofs', 'del', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        mint: { type: 'string', maxLength: 2048 },
        unit: { type: 'string', maxLength: 16 },
        proofs: { type: 'array', items: { $ref: '#/$defs/proofView' }, maxItems: 10_000 },
        del: {
          type: 'array',
          items: { type: 'string', pattern: HEX64 },
          maxItems: 10_000,
        },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    walletEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'mints', 'hasP2pkKey', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        mints: {
          type: 'array',
          items: { type: 'string', maxLength: 2048 },
          minItems: 1,
          maxItems: 1024,
          uniqueItems: true,
        },
        hasP2pkKey: { type: 'boolean' },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    deletionView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'targets', 'kinds', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        targets: {
          type: 'array',
          items: { type: 'string', pattern: HEX64 },
          maxItems: 10_000,
        },
        kinds: {
          type: 'array',
          items: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
          maxItems: 1024,
        },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    historyEventView: {
      type: 'object',
      additionalProperties: false,
      required: [
        'eventId',
        'createdAt',
        'direction',
        'amount',
        'unit',
        'created',
        'destroyed',
        'redeemed',
        'seenOn',
      ],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        direction: { enum: ['in', 'out', null] },
        amount: { type: ['integer', 'null'], minimum: 0, maximum: SAFE_INTEGER },
        unit: { type: ['string', 'null'], maxLength: 16 },
        created: { type: 'array', items: { type: 'string', pattern: HEX64 }, maxItems: 10_000 },
        destroyed: { type: 'array', items: { type: 'string', pattern: HEX64 }, maxItems: 10_000 },
        redeemed: { type: 'array', items: { type: 'string', pattern: HEX64 }, maxItems: 10_000 },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    quoteEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'createdAt', 'expiration', 'mint', 'seenOn'],
      properties: {
        eventId: { type: 'string', pattern: HEX64 },
        createdAt: { type: 'integer', minimum: 0, maximum: SAFE_INTEGER },
        expiration: { type: ['integer', 'null'], minimum: 0, maximum: SAFE_INTEGER },
        mint: { type: ['string', 'null'], maxLength: 2048 },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    malformedEventView: {
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'kind', 'reason', 'seenOn'],
      properties: {
        eventId: { type: ['string', 'null'], pattern: HEX64 },
        kind: { type: ['integer', 'null'], minimum: 0, maximum: SAFE_INTEGER },
        reason: {
          enum: [
            'decryption_failed',
            'invalid_payload',
            'invalid_signature',
            'wallet_without_mints',
          ],
        },
        seenOn: { $ref: '#/$defs/seenOn' },
      },
    },
    mintObservation: {
      type: 'object',
      additionalProperties: false,
      required: ['mint', 'y', 'state'],
      properties: {
        mint: { type: 'string', maxLength: 2048 },
        y: { type: 'string', pattern: COMPRESSED_POINT },
        state: { enum: ['UNSPENT', 'SPENT', 'PENDING'] },
      },
    },
    relayObservation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'url',
        'status',
        'error',
        'wallet',
        'tokens',
        'deletions',
        'history',
        'quotes',
        'malformed',
      ],
      properties: {
        url: { type: 'string', maxLength: 2048 },
        status: { enum: ['ok', 'error'] },
        error: { type: ['string', 'null'], maxLength: 512 },
        wallet: { type: 'array', items: { $ref: '#/$defs/walletEventView' }, maxItems: 1024 },
        tokens: { type: 'array', items: { $ref: '#/$defs/tokenEventView' }, maxItems: 10_000 },
        deletions: { type: 'array', items: { $ref: '#/$defs/deletionView' }, maxItems: 10_000 },
        history: { type: 'array', items: { $ref: '#/$defs/historyEventView' }, maxItems: 10_000 },
        quotes: { type: 'array', items: { $ref: '#/$defs/quoteEventView' }, maxItems: 10_000 },
        malformed: {
          type: 'array',
          items: { $ref: '#/$defs/malformedEventView' },
          maxItems: 10_000,
        },
      },
    },
  },
} as const;

export interface CaptureValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

// Fail fast: capture input is untrusted and allErrors can amplify one compact
// hostile array into millions of retained Ajv error objects.
const ajv = new Ajv2020({ allErrors: false, strict: true });
const validateCapture = ajv.compile(NIP60_CAPTURE_SCHEMA);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cheap cardinality checks run before Ajv traversal and canonical hashing. */
function preflightCaptureBounds(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const observation = isRecord(value.observation) ? value.observation : null;
  const relays =
    observation !== null && Array.isArray(observation.relays) ? observation.relays : [];
  const evidence = Array.isArray(value.relayEvidence) ? value.relayEvidence : [];
  const mint = observation !== null && Array.isArray(observation.mint) ? observation.mint : [];
  const errors: string[] = [];
  if (relays.length > 64) errors.push('capture contains more than 64 relay observations');
  if (evidence.length > 64) errors.push('capture contains more than 64 relay evidence entries');
  if (mint.length > 10_000) errors.push('capture contains more than 10000 mint observations');

  let eventOccurrences = 0;
  let proofCandidates = 0;
  for (const relay of relays.slice(0, 65)) {
    if (!isRecord(relay)) continue;
    for (const field of ['wallet', 'tokens', 'deletions', 'history', 'quotes', 'malformed']) {
      const group = Array.isArray(relay[field]) ? relay[field] : [];
      eventOccurrences += group.length;
      if (field !== 'tokens') continue;
      for (const token of group.slice(0, 10_001)) {
        if (isRecord(token) && Array.isArray(token.proofs)) proofCandidates += token.proofs.length;
        if (proofCandidates > 10_000) break;
      }
    }
    if (eventOccurrences > 10_000 || proofCandidates > 10_000) break;
  }
  if (eventOccurrences > 10_000) errors.push('capture contains more than 10000 event occurrences');
  if (proofCandidates > 10_000) errors.push('capture contains more than 10000 proof candidates');

  let evidenceOccurrences = 0;
  for (const entry of evidence.slice(0, 65)) {
    if (isRecord(entry) && Array.isArray(entry.eventIds))
      evidenceOccurrences += entry.eventIds.length;
    if (evidenceOccurrences > 10_000) break;
  }
  if (evidenceOccurrences > 10_000) {
    errors.push('capture contains more than 10000 relay-evidence event occurrences');
  }
  return boundedIntegrityErrors(errors);
}

function formatErrors(errors: readonly ErrorObject[]): string[] {
  return errors
    .slice(0, 32)
    .map((error) =>
      `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.slice(
        0,
        MAXIMUM_ARTIFACT_ERROR_LENGTH,
      ),
    );
}

function boundedIntegrityErrors(errors: readonly string[]): string[] {
  return errors
    .slice(0, MAXIMUM_INTEGRITY_ERRORS)
    .map((error) => error.slice(0, MAXIMUM_ARTIFACT_ERROR_LENGTH));
}

/** Validate an unknown value against the capture bundle contract. */
export function validateNip60Capture(value: unknown): CaptureValidationResult {
  if (validateCapture(value)) return { ok: true, errors: [] };
  return { ok: false, errors: formatErrors(validateCapture.errors ?? []) };
}

export function assertNip60Capture(value: unknown): Nip60Capture {
  const result = verifyCaptureIntegrity(value);
  if (!result.ok) {
    throw new Error(`capture bundle is invalid: ${result.errors.join('; ')}`);
  }
  return value as Nip60Capture;
}

function eventIdsForRelay(relay: Nip60Capture['observation']['relays'][number]): Set<string> {
  return new Set([
    ...relay.wallet.map((entry) => entry.eventId),
    ...relay.tokens.map((entry) => entry.eventId),
    ...relay.deletions.map((entry) => entry.eventId),
    ...relay.history.map((entry) => entry.eventId),
    ...relay.quotes.map((entry) => entry.eventId),
    ...relay.malformed.flatMap((entry) => (entry.eventId === null ? [] : [entry.eventId])),
  ]);
}

/** Verify schema, canonical digest, and cross-field completeness invariants. */
export function verifyCaptureIntegrity(value: unknown): CaptureValidationResult {
  const preflightErrors = preflightCaptureBounds(value);
  if (preflightErrors.length > 0) return { ok: false, errors: preflightErrors };
  const structural = validateNip60Capture(value);
  if (!structural.ok) return structural;
  const capture = value as Nip60Capture;
  const errors: string[] = [];
  if (capture.subject !== capture.observation.subject) {
    errors.push('capture subject does not match observation subject');
  }

  const observationUrls = new Set(capture.observation.relays.map((entry) => entry.url));
  if (observationUrls.size !== capture.observation.relays.length) {
    errors.push('relay observations contain duplicate urls');
  }
  const evidenceByUrl = new Map(capture.relayEvidence.map((entry) => [entry.url, entry]));
  if (evidenceByUrl.size !== capture.relayEvidence.length) {
    errors.push('relay evidence contains duplicate urls');
  }
  for (const relay of capture.observation.relays) {
    const evidence = evidenceByUrl.get(relay.url);
    if (evidence === undefined) {
      errors.push(`missing relay evidence for ${relay.url}`);
      continue;
    }
    if (evidence.status !== relay.status || evidence.error !== relay.error) {
      errors.push(`relay evidence status differs for ${relay.url}`);
    }
    const evidenceIds = new Set(evidence.eventIds);
    for (const eventId of eventIdsForRelay(relay)) {
      if (!evidenceIds.has(eventId)) {
        errors.push(`relay evidence is missing event ${eventId} from ${relay.url}`);
      }
    }
    for (const group of [
      relay.wallet,
      relay.tokens,
      relay.deletions,
      relay.history,
      relay.quotes,
      relay.malformed,
    ]) {
      for (const entry of group) {
        if (entry.seenOn.length !== 1 || entry.seenOn[0] !== relay.url) {
          errors.push(`event observation on ${relay.url} has inconsistent seenOn evidence`);
        }
      }
    }
  }
  if (evidenceByUrl.size !== capture.observation.relays.length) {
    errors.push('relay evidence count does not match relay observation count');
  }
  for (const url of evidenceByUrl.keys()) {
    if (!observationUrls.has(url)) {
      errors.push(`relay evidence URL ${url} has no matching observation`);
    }
  }

  const expectedProofs = new Set<string>();
  const observedEventIds = new Set<string>();
  const observedMints = new Set<string>();
  let proofCandidates = 0;
  let eventOccurrences = 0;
  let aggregateProofAmount = 0;
  for (const relay of capture.observation.relays) {
    for (const eventId of eventIdsForRelay(relay)) observedEventIds.add(eventId);
    eventOccurrences +=
      relay.wallet.length +
      relay.tokens.length +
      relay.deletions.length +
      relay.history.length +
      relay.quotes.length +
      relay.malformed.length;
    for (const token of relay.tokens) {
      observedMints.add(token.mint);
      proofCandidates += token.proofs.length;
      const tokenProofs = new Set<string>();
      for (const proof of token.proofs) {
        if (aggregateProofAmount > SAFE_INTEGER - proof.amount) {
          errors.push('capture aggregate proof amount exceeds the safe integer limit');
        } else {
          aggregateProofAmount += proof.amount;
        }
        const key = `${token.mint}\0${proof.y}`;
        expectedProofs.add(key);
        if (tokenProofs.has(key))
          errors.push(`token ${token.eventId} contains duplicate proof ${proof.y}`);
        tokenProofs.add(key);
      }
    }
  }
  if (observedEventIds.size > 10_000) errors.push('capture contains more than 10000 events');
  if (eventOccurrences > 10_000) errors.push('capture contains more than 10000 event occurrences');
  if (proofCandidates > 10_000) errors.push('capture contains more than 10000 proof candidates');
  if (observedMints.size > 64) errors.push('capture contains more than 64 distinct mints');
  const observedProofs = new Set<string>();
  for (const state of capture.observation.mint) {
    const key = `${state.mint}\0${state.y}`;
    if (observedProofs.has(key)) errors.push(`duplicate mint state for ${state.mint} ${state.y}`);
    observedProofs.add(key);
    if (!expectedProofs.has(key)) errors.push(`unexpected mint state for ${state.mint} ${state.y}`);
  }
  for (const key of expectedProofs) {
    if (!observedProofs.has(key)) {
      const [mint, y] = key.split('\0');
      errors.push(`missing mint state for ${mint ?? ''} ${y ?? ''}`);
    }
  }
  const { digest: _digest, ...bundle } = capture;
  if (captureDigest(bundle) !== capture.digest) {
    errors.push('capture digest does not match its canonical contents');
  }
  const boundedErrors = boundedIntegrityErrors(errors);
  return { ok: boundedErrors.length === 0, errors: boundedErrors };
}
