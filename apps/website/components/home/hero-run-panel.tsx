import Image from 'next/image';
import type { DemoSummary } from '../../lib/demo';
import styles from './home.module.css';

interface HeroRunPanelProps {
  summary: DemoSummary;
}

const traceStages = [
  ['Prepared', '◆'],
  ['Sent', '→'],
  ['Response lost', '×'],
  ['Exact retry', '↻'],
  ['Recovered', '◇'],
] as const;

export function HeroRunPanel({ summary }: HeroRunPanelProps) {
  const converged = summary.status === 'passed';

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
          <span>Live deterministic run</span>
          <strong>Reviewed artifact / v0.1.0</strong>
        </div>
        <span className={styles.runPanelLive}>
          <span aria-hidden="true" />
          Live
        </span>
      </header>

      <ol aria-label="Deterministic run trace preview" className={styles.runPanelTrace}>
        {traceStages.map(([label, symbol]) => (
          <li key={label}>
            <span aria-hidden="true">{symbol}</span>
            <small>{label}</small>
          </li>
        ))}
        <li className={styles.runPanelTraceFinal}>
          <span aria-hidden="true">{converged ? '✓' : '!'}</span>
          <small>{converged ? 'Converged' : 'Not converged'}</small>
        </li>
      </ol>

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
          <dd className={converged ? styles.runPanelConverged : styles.runPanelBlocked}>
            <span aria-hidden="true">{converged ? '✓' : '!'}</span>
            {converged ? 'Converged' : 'Not converged'}
          </dd>
        </div>
      </dl>
    </aside>
  );
}
