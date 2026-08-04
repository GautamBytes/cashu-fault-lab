import {
  canonicalJson,
  captureWallet,
  verifyCaptureIntegrity,
  type CaptureOptions,
  type Nip60Capture,
} from '@cashu-fault-lab/wallet-doctor-contract';
import {
  buildRepairPlan,
  checkRepairPlan,
  diagnose,
  type Diagnosis,
} from '@cashu-fault-lab/wallet-doctor-oracle';
import {
  validateNip60DiagnosisArtifact,
  validateNip60RepairPlanArtifact,
} from './artifact-schemas.js';

export interface Nip60DiagnosisArtifact {
  readonly schemaVersion: 1;
  readonly kind: 'nip60-diagnosis';
  readonly generatedFrom: string;
  readonly diagnosis: Diagnosis;
}

export interface Nip60RepairPlanArtifact {
  readonly schemaVersion: 1;
  readonly kind: 'nip60-repair-plan';
  readonly generatedFrom: string;
  readonly plan: ReturnType<typeof buildRepairPlan>;
  readonly safety: { readonly ok: boolean; readonly violations: readonly string[] };
}

export interface WalletDoctorCheck {
  readonly ok: boolean;
  readonly diagnosisArtifact: Nip60DiagnosisArtifact | null;
  /** Present when the diagnosis found anything repairable. */
  readonly planArtifact: Nip60RepairPlanArtifact | null;
  /** Stable machine-readable outcome for CI exit codes. */
  readonly summary: {
    readonly errorFindings: number;
    readonly warningFindings: number;
    readonly infoFindings: number;
    /** Relays whose capture failed; any failure blocks `ok`. */
    readonly failedRelays: number;
    readonly codes: readonly string[];
    readonly mintVerified: number;
    readonly merged: number;
    readonly doubleCounted: number;
    /** Schema/digest/completeness errors; any entry blocks `ok`. */
    readonly integrityErrors: readonly string[];
  };
}

const REPAIRABLE_CODES: ReadonlySet<string> = new Set([
  'RELAY_PARTITION',
  'GHOST_TOKEN',
  'ORPHANED_PROOFS',
  'DEL_CHAIN_BREAK',
  'WALLET_EVENT_FORK',
]);
const MAX_ARTIFACT_ERROR_LENGTH = 2048;

function failedCheck(integrityErrors: readonly string[]): WalletDoctorCheck {
  return {
    ok: false,
    diagnosisArtifact: null,
    planArtifact: null,
    summary: {
      errorFindings: 0,
      warningFindings: 0,
      infoFindings: 0,
      failedRelays: 0,
      codes: [],
      mintVerified: 0,
      merged: 0,
      doubleCounted: 0,
      integrityErrors: integrityErrors
        .slice(0, 256)
        .map((error) => error.slice(0, MAX_ARTIFACT_ERROR_LENGTH)),
    },
  };
}

export interface CaptureComparison {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** Compare only independently reproducible evidence; timestamps and digests are excluded. */
export function compareCaptureEvidence(
  supplied: Nip60Capture,
  live: Nip60Capture,
): CaptureComparison {
  const errors: string[] = [];
  if (supplied.subject !== live.subject)
    errors.push('live subject differs from the supplied capture');
  if (canonicalJson(supplied.relayEvidence) !== canonicalJson(live.relayEvidence)) {
    errors.push('live relay evidence differs from the supplied capture');
  }
  if (canonicalJson(supplied.observation) !== canonicalJson(live.observation)) {
    errors.push('live normalized observation differs from the supplied capture');
  }
  return { ok: errors.length === 0, errors };
}

/** Re-fetch relays and mints with the subject key, then compare independent evidence. */
export async function verifyCaptureAgainstLive(
  supplied: Nip60Capture,
  subjectSecretKey: Uint8Array,
  options: {
    readonly timeoutMs?: number;
    readonly overallTimeoutMs?: number;
    readonly allowInsecureLoopback?: boolean;
    readonly fetchEvents?: CaptureOptions['fetchEvents'];
    readonly checkStates?: CaptureOptions['checkStates'];
  } = {},
): Promise<CaptureComparison> {
  const live = await captureWallet({
    relays: supplied.relayEvidence.map((relay) => relay.url),
    subjectSecretKey,
    capturedAt: supplied.capturedAt,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.overallTimeoutMs === undefined
      ? {}
      : { overallTimeoutMs: options.overallTimeoutMs }),
    ...(options.allowInsecureLoopback === undefined
      ? {}
      : { allowInsecureLoopback: options.allowInsecureLoopback }),
    ...(options.fetchEvents === undefined ? {} : { fetchEvents: options.fetchEvents }),
    ...(options.checkStates === undefined ? {} : { checkStates: options.checkStates }),
  });
  return compareCaptureEvidence(supplied, live);
}

/** Run the diagnosis pipeline over a validated capture bundle. */
export function diagnoseCapture(
  capture: Nip60Capture,
  options: { readonly now?: number } = {},
): Nip60DiagnosisArtifact {
  const capturedNow = Math.floor(new Date(capture.capturedAt).getTime() / 1000);
  const fallbackNow = Math.max(
    0,
    ...capture.observation.relays.flatMap((relay) => relay.wallet.map((event) => event.createdAt)),
  );
  const referenceNow = options.now ?? (capturedNow > 0 ? capturedNow : fallbackNow);
  const result = diagnose(capture.observation, { now: referenceNow });
  const artifact: Nip60DiagnosisArtifact = {
    schemaVersion: 1,
    kind: 'nip60-diagnosis',
    generatedFrom: capture.digest,
    diagnosis: result,
  };
  const validation = validateNip60DiagnosisArtifact(artifact);
  if (!validation.ok) {
    throw new Error(`generated diagnosis artifact is invalid: ${validation.errors.join('; ')}`);
  }
  return artifact;
}

/** Build the dry-run repair plan for a diagnosis and verify its safety. */
export function planForDiagnosis(
  capture: Nip60Capture,
  diagnosisArtifact: Nip60DiagnosisArtifact,
): Nip60RepairPlanArtifact {
  const plan = buildRepairPlan({
    observation: capture.observation,
    diagnosis: diagnosisArtifact.diagnosis,
    captureDigest: capture.digest,
  });
  const safety = checkRepairPlan({ observation: capture.observation, plan });
  const artifact: Nip60RepairPlanArtifact = {
    schemaVersion: 1,
    kind: 'nip60-repair-plan',
    generatedFrom: capture.digest,
    plan,
    safety: { ok: safety.ok, violations: safety.violations },
  };
  const validation = validateNip60RepairPlanArtifact(artifact);
  if (!validation.ok) {
    throw new Error(`generated repair-plan artifact is invalid: ${validation.errors.join('; ')}`);
  }
  return artifact;
}

function hasRepairableFindings(diagnosis: Diagnosis): boolean {
  return diagnosis.findings.some((finding) => REPAIRABLE_CODES.has(finding.code));
}

/**
 * The CI-kit entry point: full collect-output evaluation. Exit-code semantics
 * are encoded in `ok`: false when any error-severity finding exists, when any
 * relay failed (an unreachable relay means incomplete evidence, which a gate
 * must not pass over), or when the repair plan fails its safety invariants.
 */
export function checkCapture(
  value: unknown,
  options: { readonly now?: number } = {},
): WalletDoctorCheck {
  const integrity = verifyCaptureIntegrity(value);
  if (!integrity.ok) {
    return failedCheck(integrity.errors);
  }
  const capture = value as Nip60Capture;
  let diagnosisArtifact: Nip60DiagnosisArtifact;
  let planArtifact: Nip60RepairPlanArtifact | null;
  try {
    diagnosisArtifact = diagnoseCapture(capture, options);
    planArtifact = hasRepairableFindings(diagnosisArtifact.diagnosis)
      ? planForDiagnosis(capture, diagnosisArtifact)
      : null;
  } catch (error) {
    return failedCheck([
      `capture evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  const errorFindings = diagnosisArtifact.diagnosis.findings.filter(
    (finding) => finding.severity === 'error',
  ).length;
  const warningFindings = diagnosisArtifact.diagnosis.findings.filter(
    (finding) => finding.severity === 'warning',
  ).length;
  const infoFindings = diagnosisArtifact.diagnosis.findings.filter(
    (finding) => finding.severity === 'info',
  ).length;
  const failedRelays = capture.observation.relays.filter(
    (relay) => relay.status === 'error',
  ).length;
  return {
    ok:
      errorFindings === 0 &&
      failedRelays === 0 &&
      integrity.ok &&
      (planArtifact === null || planArtifact.safety.ok),
    diagnosisArtifact,
    planArtifact,
    summary: {
      errorFindings,
      warningFindings,
      infoFindings,
      failedRelays,
      codes: [
        ...new Set(diagnosisArtifact.diagnosis.findings.map((finding) => finding.code)),
      ].sort(),
      mintVerified: diagnosisArtifact.diagnosis.balance.mintVerified,
      merged: diagnosisArtifact.diagnosis.balance.merged,
      doubleCounted: diagnosisArtifact.diagnosis.balance.doubleCounted,
      integrityErrors: integrity.errors,
    },
  };
}
