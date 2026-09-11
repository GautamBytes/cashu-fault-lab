import { evidenceFingerprint, verifyNutzapEvidence, type NutzapReport } from './evidence.js';
import { digest } from './protocol.js';
import { runNutzapScenario, validateRun, type NutzapRunOptions } from './runner.js';
export async function replayNutzapReport(
  value: unknown,
  seed: string,
  options: NutzapRunOptions = {},
): Promise<NutzapReport> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('Invalid nutzap replay report');
  const report = value as NutzapReport;
  validateRun(report.scenarioId, seed);
  if (
    report.schemaVersion !== 1 ||
    report.suite !== 'nip61-recovery-v1' ||
    report.seedHash !== digest(`nip61-recovery-seed-v1\0${seed}`) ||
    report.mode !== (options.mintUrl ? 'funded' : 'simulated')
  )
    throw Error('Nutzap replay schema, seed or mode mismatch');
  if (
    !report.evidence ||
    typeof report.evidence !== 'object' ||
    Array.isArray(report.evidence) ||
    evidenceFingerprint(report.evidence) !== report.fingerprint
  )
    throw Error('Nutzap replay evidence digest mismatch');
  const verification = verifyNutzapEvidence(report.evidence, report.scenarioId);
  if (
    report.status !== (verification.ok ? 'passed' : 'failed') ||
    JSON.stringify(report.failures) !== JSON.stringify(verification.failures)
  )
    throw Error('Nutzap replay outcome mismatch');
  const replay = await runNutzapScenario(report.scenarioId, seed, options);
  if (replay.fingerprint !== report.fingerprint)
    throw Error('Nutzap replay semantic evidence changed');
  return replay;
}
