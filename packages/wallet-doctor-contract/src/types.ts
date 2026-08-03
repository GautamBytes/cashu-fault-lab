import type { Event } from 'nostr-tools';
import type { DoctorObservation } from '@cashu-fault-lab/wallet-doctor-core';

/** Signed relay events preserved as evidence. Content stays NIP-44-encrypted. */
export interface RawRelayCapture {
  readonly url: string;
  readonly status: 'ok' | 'error';
  readonly error: string | null;
  readonly events: readonly Event[];
}

/**
 * Versioned capture bundle: the interop contract between the doctor and
 * external wallet CI. `observation` is normalized and secret-free (proofs
 * carry only their public NUT-00 `y`); `rawRelays` preserves signed evidence
 * whose content remains encrypted for anyone without the subject key.
 */
export interface Nip60Capture {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  /** Domain-separated sha256 over the canonical bundle (sans this field). */
  readonly digest: string;
  readonly subject: string;
  readonly observation: DoctorObservation;
  readonly rawRelays: readonly RawRelayCapture[];
  readonly redaction: { readonly proofSecretsDropped: true };
}
