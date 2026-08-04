import Image from 'next/image';
import type { DemoInvariant, DemoSummary, InvariantStatus } from '../../lib/demo';
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
  passed: styles.statusPassed!,
  failed: styles.statusFailed!,
  not_observable: styles.statusNotObservable!,
  not_applicable: styles.statusNotApplicable!,
};

function invariantTitle(id: string): string {
  const title = id.replaceAll('-', ' ');
  return `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
}

function confidenceLabel(confidence: string): string {
  const label = confidence.replaceAll('_', ' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function InvariantList({
  ariaLabel,
  emphasizeContext,
  invariants,
}: {
  ariaLabel: string;
  emphasizeContext?: boolean;
  invariants: DemoInvariant[];
}) {
  return (
    <ul aria-label={ariaLabel} className={styles.invariantList}>
      {invariants.map((invariant) => (
        <li
          className={`${styles.invariantItem} ${
            emphasizeContext ? styles.invariantItemContext : ''
          }`}
          key={invariant.id}
        >
          <span
            aria-hidden="true"
            className={`${styles.invariantSignal} ${statusStyles[invariant.status]}`}
          >
            {statusLabels[invariant.status].icon}
          </span>
          <div className={styles.invariantIdentity}>
            <strong className={styles.invariantTitle}>{invariantTitle(invariant.id)}</strong>
            <code>{invariant.id}</code>
          </div>
          <div className={styles.invariantEvidenceBasis}>
            <span>Evidence basis</span>
            <strong>{confidenceLabel(invariant.confidence)}</strong>
            {invariant.reason ? <p>{invariant.reason}</p> : null}
          </div>
          <span className={`${styles.invariantStatus} ${statusStyles[invariant.status]}`}>
            <span aria-hidden="true">{statusLabels[invariant.status].icon}</span>
            {statusLabels[invariant.status].label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function EvidenceReport({ summary }: EvidenceReportProps) {
  const contextInvariants = summary.invariants.filter((invariant) => invariant.status !== 'passed');
  const supportedInvariants = summary.invariants.filter(
    (invariant) => invariant.status === 'passed',
  );

  return (
    <section
      aria-labelledby="evidence-report-title"
      className={`${styles.section} ${styles.evidenceSection}`}
      data-trace-label="Prove"
      data-trace-step="02"
    >
      <div aria-label="Reviewed evidence summary" className={styles.evidenceOverview} role="group">
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>First-party reproducible evidence</p>
          <h2 id="evidence-report-title">Evidence, not a success boolean.</h2>
          <p>
            We ran the public npm package in a clean directory with Node 24 and Docker, exactly as a
            new user would. First-party reproducible evidence is not independent wallet validation
            or certification.
          </p>
          <div className={styles.evidenceCommand}>
            <span>Exact public command</span>
            <code>{summary.verification.command}</code>
          </div>
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
          <p className={styles.seedNote}>
            Package {summary.verification.package}; the CLI&apos;s deterministic default seed
            identifier remains <code>{summary.seed}</code>.
          </p>
        </div>
      </div>

      <div className={styles.reportShell}>
        <ul aria-label="Verified v0.2.0 user results" className={styles.verificationGrid}>
          <li>
            <span className={styles.verificationStep}>01</span>
            <div>
              <strong>Public package</strong>
              <p>{summary.verification.package} downloaded from npm</p>
            </div>
          </li>
          <li>
            <span className={styles.verificationStep}>02</span>
            <div>
              <strong>Environment doctor</strong>
              <p>
                {summary.verification.doctor.checks} checks · {summary.verification.doctor.failed}{' '}
                failed · {summary.verification.doctor.warned} warned
              </p>
            </div>
          </li>
          <li>
            <span className={styles.verificationStep}>03</span>
            <div>
              <strong>Fault and recovery</strong>
              <p>
                {summary.deliveryAttemptCount} attempts · {summary.redemptionStartCount} redemption
                start · {summary.merchantCreditCount} merchant credit
              </p>
            </div>
          </li>
          <li>
            <span className={styles.verificationStep}>04</span>
            <div>
              <strong>Oracle evaluation</strong>
              <p>
                {summary.invariantCounts.passed} passed · {summary.invariantCounts.failed} failed ·{' '}
                {summary.invariantCounts.not_applicable} not applicable
              </p>
            </div>
          </li>
          <li>
            <span className={styles.verificationStep}>05</span>
            <div>
              <strong>Evidence artifacts</strong>
              <p>Secret-scanned JSON and HTML reports retained</p>
            </div>
          </li>
          <li>
            <span className={styles.verificationStep}>06</span>
            <div>
              <strong>Docker cleanup</strong>
              <p>
                {summary.verification.cleanup.containers} containers ·{' '}
                {summary.verification.cleanup.networks} networks ·{' '}
                {summary.verification.cleanup.volumes} volumes
              </p>
            </div>
          </li>
        </ul>

        <div className={styles.evidenceGallery}>
          <figure className={styles.evidenceFigure}>
            <Image
              alt="v0.2.0 terminal showing the public doctor and demo passing"
              height={900}
              src="/evidence/v0.2.0-terminal.png"
              width={1440}
            />
            <figcaption>
              The real user path: public <code>npx</code> commands, environment checks, and the
              final Docker demo result.
            </figcaption>
          </figure>
          <figure className={styles.evidenceFigure}>
            <Image
              alt="v0.2.0 generated evidence report showing the passed response-loss scenario"
              height={960}
              src="/evidence/v0.2.0-report.png"
              width={1440}
            />
            <figcaption>
              The generated HTML report is a human view of the same machine-readable artifact.
            </figcaption>
          </figure>
        </div>

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

        <div
          aria-label="Invariant evidence states"
          className={styles.invariantEvidence}
          role="group"
        >
          <h3>Invariant evidence states</h3>
          <p>
            Every evaluated invariant remains visible; unsupported observations are never promoted
            to passes.
          </p>
          <div className={styles.invariantGroups}>
            <div className={styles.invariantGroup}>
              <header className={styles.invariantGroupHeader}>
                <div>
                  <h4>Requires context</h4>
                  <p>Unavailable or out-of-scope observations, with the reason kept visible.</p>
                </div>
                <strong>{contextInvariants.length}</strong>
              </header>
              <InvariantList
                ariaLabel="Invariants requiring context"
                emphasizeContext
                invariants={contextInvariants}
              />
            </div>

            <div className={styles.invariantGroup}>
              <header className={styles.invariantGroupHeader}>
                <div>
                  <h4>Supported by reviewed evidence</h4>
                  <p>Checks supported by the artifact’s declared evidence basis.</p>
                </div>
                <strong>{supportedInvariants.length}</strong>
              </header>
              <InvariantList
                ariaLabel="Invariants supported by reviewed evidence"
                invariants={supportedInvariants}
              />
            </div>
          </div>
        </div>

        <div className={styles.reportLinks}>
          <a className={styles.reportLink} href="/docs/invariants">
            Read the invariant definitions <span aria-hidden="true">→</span>
          </a>
          <a
            className={styles.reportLink}
            href="https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.2.0-demo.json"
            rel="noreferrer noopener"
            target="_blank"
          >
            Machine-readable evidence <span aria-hidden="true">↗</span>
          </a>
          <a
            className={styles.reportLink}
            href="https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.2.0-demo.html"
            rel="noreferrer noopener"
            target="_blank"
          >
            Full HTML report <span aria-hidden="true">↗</span>
          </a>
          <a
            className={styles.reportLink}
            href="https://github.com/GautamBytes/cashu-fault-lab/blob/main/docs/examples/v0.2.0-provenance.json"
            rel="noreferrer noopener"
            target="_blank"
          >
            Provenance record <span aria-hidden="true">↗</span>
          </a>
          <a
            className={styles.reportLink}
            href="https://github.com/GautamBytes/cashu-fault-lab/releases/tag/v0.2.0"
            rel="noreferrer noopener"
            target="_blank"
          >
            v0.2.0 release <span aria-hidden="true">↗</span>
          </a>
          <a
            className={styles.reportLink}
            href={summary.verification.publicationRunUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            Successful publication run <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>
  );
}
