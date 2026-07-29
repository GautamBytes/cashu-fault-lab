import Image from 'next/image';
import type { DemoSummary } from '../../lib/demo';
import styles from './home.module.css';

interface HeroRunPanelProps {
  summary: DemoSummary;
}

export function HeroRunPanel({ summary }: HeroRunPanelProps) {
  const passed = summary.status === 'passed';

  return (
    <aside aria-label="Deterministic demo run" className={styles.heroRunPanel}>
      <header className={styles.runPanelHeader}>
        <Image
          alt="Cashu Fault Lab pixel-art mark"
          className={styles.runPanelMark}
          height={48}
          priority
          src="/cashu-fault-lab.png"
          width={48}
        />
        <div>
          <span>Reviewed deterministic artifact</span>
          <strong>Checked in</strong>
        </div>
        <span className={styles.runPanelArtifact}>Artifact</span>
      </header>

      <dl className={styles.runPanelFacts}>
        <div className={styles.runPanelScenario}>
          <dt>Scenario</dt>
          <dd>{summary.scenarioId}</dd>
        </div>
        <div className={styles.runPanelSeed}>
          <dt>Seed</dt>
          <dd>{summary.seed}</dd>
        </div>
        <div>
          <dt>Commands</dt>
          <dd>{summary.commandCount}</dd>
        </div>
        <div>
          <dt>Invariants</dt>
          <dd>{summary.invariantCount}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd className={passed ? styles.runPanelPassed : styles.runPanelReview}>
            <span aria-hidden="true">{passed ? '✓' : '!'}</span>
            {summary.status}
          </dd>
        </div>
      </dl>
    </aside>
  );
}
