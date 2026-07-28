import type { DemoSummary, InvariantStatus } from '../../lib/demo';
import styles from './home.module.css';

interface EvidenceReportProps {
  summary: DemoSummary;
}

const statusLabels: Record<InvariantStatus, { icon: string; label: string }> = {
  passed: { icon: '✓', label: 'Passed' },
  failed: { icon: '!', label: 'Failed' },
  not_observable: { icon: '?', label: 'Not observable' },
  not_applicable: { icon: '–', label: 'Not applicable' },
};

const statusStyles: Record<InvariantStatus, string> = {
  passed: styles.statusPassed,
  failed: styles.statusFailed,
  not_observable: styles.statusNotObservable,
  not_applicable: styles.statusNotApplicable,
};

export function EvidenceReport({ summary }: EvidenceReportProps) {
  return (
    <section
      aria-labelledby="evidence-report-title"
      className={`${styles.section} ${styles.evidenceSection}`}
    >
      <div aria-label="Reviewed evidence summary" className={styles.evidenceOverview} role="group">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>Reviewed demo artifact</p>
          <h2 id="evidence-report-title">Evidence, not a success boolean.</h2>
          <p>
            This report is summarized on the server from the checked-in v0.1.0 demo. Commands, proof
            secrets, and arbitrary evidence payloads never reach this page.
          </p>
        </div>

        <div className={styles.reportMeta}>
          <header className={styles.reportHeader}>
            <div>
              <span className={styles.reportLabel}>Scenario</span>
              <strong>{summary.scenarioId}</strong>
            </div>
            <span
              className={`${styles.runStatus} ${
                summary.status === 'passed' ? styles.statusPassed : styles.statusFailed
              }`}
            >
              <span aria-hidden="true">{summary.status === 'passed' ? '✓' : '!'}</span>
              Run {summary.status}
            </span>
          </header>

          <dl className={styles.reportFacts}>
            <div>
              <dt>Seed</dt>
              <dd>{summary.seed}</dd>
            </div>
            <div>
              <dt>Commands</dt>
              <dd>{summary.commandCount}</dd>
            </div>
            <div>
              <dt>Timeline observations</dt>
              <dd>{summary.timelineCount}</dd>
            </div>
            <div>
              <dt>Invariants evaluated</dt>
              <dd>{summary.invariantCount}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className={styles.reportShell}>
        <ul aria-label="Invariant status counts" className={styles.statusGrid}>
          {(Object.keys(statusLabels) as InvariantStatus[]).map((status) => (
            <li className={`${styles.statusCard} ${statusStyles[status]}`} key={status}>
              <span aria-hidden="true" className={styles.statusIcon}>
                {statusLabels[status].icon}
              </span>
              <span>{statusLabels[status].label}</span>
              <strong>{summary.invariantCounts[status]}</strong>
            </li>
          ))}
        </ul>

        <div className={styles.invariantEvidence}>
          <h3>Invariant evidence states</h3>
          <p>
            Every evaluated invariant remains visible; unsupported observations are never promoted
            to passes.
          </p>
          <ul aria-label="Invariant evidence states" className={styles.invariantList}>
            {summary.invariants.map((invariant) => (
              <li className={styles.invariantItem} key={invariant.id}>
                <code>{invariant.id}</code>
                <span className={`${styles.invariantStatus} ${statusStyles[invariant.status]}`}>
                  <span aria-hidden="true">{statusLabels[invariant.status].icon}</span>
                  {statusLabels[invariant.status].label}
                </span>
                <span className={styles.invariantConfidence}>{invariant.confidence}</span>
                {invariant.reason ? (
                  <span className={styles.invariantReason}>{invariant.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>

        <div className={styles.reportLinks}>
          <a className={styles.reportLink} href="/docs/invariants">
            Read the invariant definitions <span aria-hidden="true">→</span>
          </a>
          <a
            className={styles.reportLink}
            href="https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.1.0-demo.json"
            rel="noreferrer noopener"
            target="_blank"
          >
            Inspect the reviewed artifact <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>
  );
}
