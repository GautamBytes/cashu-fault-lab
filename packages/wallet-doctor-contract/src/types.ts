import type { DoctorObservation } from '@cashu-fault-lab/wallet-doctor-core';

/** Secret-free relay evidence. Event bodies and signatures are never exported. */
export interface RelayCaptureEvidence {
  readonly url: string;
  readonly status: 'ok' | 'error';
  readonly error: string | null;
  readonly eventIds: readonly string[];
}

/**
 * Versioned capture bundle: the interop contract between the doctor and
 * external wallet CI. `observation` is normalized and secret-free (proofs
 * carry only their public NUT-00 `y`). Relay evidence contains identifiers,
 * never NIP-44 ciphertext, signatures, proof secrets, or wallet key material.
 */
export interface Nip60Capture {
  readonly schemaVersion: 2;
  readonly capturedAt: string;
  /** Domain-separated sha256 over the canonical bundle (sans this field). */
  readonly digest: string;
  readonly subject: string;
  readonly observation: DoctorObservation;
  readonly relayEvidence: readonly RelayCaptureEvidence[];
  readonly redaction: {
    readonly proofSecretsDropped: true;
    readonly encryptedContentsDropped: true;
    readonly walletPrivateKeyDropped: true;
  };
}
