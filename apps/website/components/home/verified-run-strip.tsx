import type { DemoSummary } from '../../lib/demo';
import styles from './home.module.css';

export function VerifiedRunStrip({ summary }: { summary: DemoSummary }) {
  return (
    <div
      aria-label="Verified public-package run"
      className={styles.verifiedRunStrip}
      id="verified-run"
      role="group"
    >
      <div className={styles.verifiedRunLead}>
        <span>Verified public-package run</span>
        <strong>
          <span aria-hidden="true">✓</span> {summary.status}
        </strong>
      </div>
      <dl className={styles.verifiedRunFacts}>
        <div>
          <dt>Package</dt>
          <dd>{summary.verification.package}</dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd>
            {summary.invariantCounts.passed} passed · {summary.invariantCounts.not_applicable} not
            applicable
          </dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd>
            {summary.verification.cleanup.containers} containers ·{' '}
            {summary.verification.cleanup.networks} networks ·{' '}
            {summary.verification.cleanup.volumes} volumes
          </dd>
        </div>
      </dl>
      <nav aria-label="Verified run artifacts" className={styles.verifiedRunLinks}>
        <a href="/evidence/v0.2.0-terminal.png">Terminal output</a>
        <a href="/evidence/v0.2.0-report.png">HTML report</a>
      </nav>
    </div>
  );
}
