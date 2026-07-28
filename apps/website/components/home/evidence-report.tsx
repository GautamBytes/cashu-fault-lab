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

export function EvidenceReport({ summary }: EvidenceReportProps) {
  return (
    <section
      aria-labelledby="evidence-report-title"
      className={`${styles.section} ${styles.evidenceSection}`}
    >
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>Reviewed demo artifact</p>
        <h2 id="evidence-report-title">Evidence, not a success boolean.</h2>
        <p>
          This report is summarized on the server from the checked-in v0.1.0 demo. Commands, proof
          secrets, and arbitrary evidence payloads never reach this page.
        </p>
      </div>

      <div className={styles.reportShell}>
        <header className={styles.reportHeader}>
          <div>
            <span className={styles.reportLabel}>Scenario</span>
            <strong>{summary.scenarioId}</strong>
          </div>
          <span
            className={`${styles.runStatus} ${styles[summary.status === 'passed' ? 'passed' : 'failed']}`}
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

        <ul aria-label="Invariant status counts" className={styles.statusGrid}>
          {(Object.keys(statusLabels) as InvariantStatus[]).map((status) => (
            <li className={`${styles.statusCard} ${styles[status]}`} key={status}>
              <span aria-hidden="true" className={styles.statusIcon}>
                {statusLabels[status].icon}
              </span>
              <span>{statusLabels[status].label}</span>
              <strong>{summary.invariantCounts[status]}</strong>
            </li>
          ))}
        </ul>

        <a
          className={styles.reportLink}
          href="https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.1.0-demo.json"
          rel="noreferrer noopener"
          target="_blank"
        >
          Inspect the reviewed artifact <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}
