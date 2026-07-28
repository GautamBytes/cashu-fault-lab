import styles from './home.module.css';

const stages = [
  { label: 'Reserve proofs', icon: '◆', kind: 'prepared' },
  { label: 'Send delivery', icon: '→', kind: 'active' },
  { label: 'Response lost', icon: '×', kind: 'fault' },
  { label: 'Exact retry', icon: '↻', kind: 'retry' },
  { label: 'Recover proofs', icon: '◇', kind: 'recovery' },
  { label: 'One durable credit', icon: '✓', kind: 'converged' },
] as const;

export function FaultTimeline() {
  return (
    <section
      aria-labelledby="fault-timeline-title"
      className={`${styles.section} ${styles.traceSection}`}
    >
      <div className={styles.sectionHeading}>
        <p className={styles.eyebrow}>Deterministic fault trace</p>
        <h2 id="fault-timeline-title">A lost response is not a lost result.</h2>
        <p>
          The lab repeats the exact delivery after transport ambiguity, then checks proof state and
          durable credit before it calls the run converged.
        </p>
      </div>

      <div className={styles.timelineFrame}>
        <div aria-hidden="true" className={styles.timelineRail}>
          <span className={styles.deliverySignal}>◆</span>
        </div>
        <ol aria-label="Six-stage response-loss recovery flow" className={styles.timeline}>
          {stages.map((stage, index) => (
            <li className={`${styles.timelineStage} ${styles[stage.kind]}`} key={stage.label}>
              <span aria-hidden="true" className={styles.stageIcon}>
                {stage.icon}
              </span>
              <span className={styles.stageNumber}>{String(index + 1).padStart(2, '0')}</span>
              <strong>{stage.label}</strong>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
