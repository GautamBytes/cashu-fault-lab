import type { Nip60Capture } from '@cashu-fault-lab/wallet-doctor-contract';
import {
  buildRepairPlan,
  checkRepairPlan,
  diagnose,
  type Diagnosis,
} from '@cashu-fault-lab/wallet-doctor-oracle';

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
  readonly diagnosisArtifact: Nip60DiagnosisArtifact;
  /** Present when the diagnosis found anything repairable. */
  readonly planArtifact: Nip60RepairPlanArtifact | null;
  /** Stable machine-readable outcome for CI exit codes. */
  readonly summary: {
    readonly errorFindings: number;
    readonly warningFindings: number;
    readonly infoFindings: number;
    readonly codes: readonly string[];
    readonly mintVerified: number;
    readonly merged: number;
    readonly doubleCounted: number;
  };
}

const REPAIRABLE_CODES: ReadonlySet<string> = new Set([
  'RELAY_PARTITION',
  'GHOST_TOKEN',
  'ORPHANED_PROOFS',
  'DEL_CHAIN_BREAK',
  'WALLET_EVENT_FORK',
]);

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
  return {
    schemaVersion: 1,
    kind: 'nip60-diagnosis',
    generatedFrom: capture.digest,
    diagnosis: result,
  };
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
  return {
    schemaVersion: 1,
    kind: 'nip60-repair-plan',
    generatedFrom: capture.digest,
    plan,
    safety: { ok: safety.ok, violations: safety.violations },
  };
}

function hasRepairableFindings(diagnosis: Diagnosis): boolean {
  return diagnosis.findings.some((finding) => REPAIRABLE_CODES.has(finding.code));
}

/**
 * The CI-kit entry point: full collect-output evaluation. Exit-code semantics
 * are encoded in `ok`: false when any error-severity finding exists or the
 * repair plan fails its safety invariants.
 */
export function checkCapture(
  capture: Nip60Capture,
  options: { readonly now?: number } = {},
): WalletDoctorCheck {
  const diagnosisArtifact = diagnoseCapture(capture, options);
  const planArtifact = hasRepairableFindings(diagnosisArtifact.diagnosis)
    ? planForDiagnosis(capture, diagnosisArtifact)
    : null;
  const errorFindings = diagnosisArtifact.diagnosis.findings.filter(
    (finding) => finding.severity === 'error',
  ).length;
  const warningFindings = diagnosisArtifact.diagnosis.findings.filter(
    (finding) => finding.severity === 'warning',
  ).length;
  const infoFindings = diagnosisArtifact.diagnosis.findings.filter(
    (finding) => finding.severity === 'info',
  ).length;
  return {
    ok: errorFindings === 0 && (planArtifact === null || planArtifact.safety.ok),
    diagnosisArtifact,
    planArtifact,
    summary: {
      errorFindings,
      warningFindings,
      infoFindings,
      codes: [...new Set(diagnosisArtifact.diagnosis.findings.map((finding) => finding.code))],
      mintVerified: diagnosisArtifact.diagnosis.balance.mintVerified,
      merged: diagnosisArtifact.diagnosis.balance.merged,
      doubleCounted: diagnosisArtifact.diagnosis.balance.doubleCounted,
    },
  };
}
