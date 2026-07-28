import type { ScenarioGroup } from '../../lib/scenarios';
import styles from './home.module.css';

interface ScenarioExplorerProps {
  groups: ScenarioGroup[];
}

const promotedFamilies = [
  {
    description:
      'Lose requests or responses across HTTP and Nostr, then repeat the exact delivery.',
    families: ['retry'],
    signal: 'RETRY',
    title: 'Response loss and retry',
  },
  {
    description:
      'Restart senders and receivers around persistence, settlement, and receipt boundaries.',
    families: ['crash-recovery'],
    signal: 'RECOVER',
    title: 'Crash recovery',
  },
  {
    description:
      'Challenge single-use guarantees with duplicates, conflicts, and concurrent delivery.',
    families: ['concurrency', 'conformance'],
    signal: 'RACE',
    title: 'Duplicate and concurrency',
  },
  {
    description: 'Probe malformed input, CORS, redirects, and server-side request boundaries.',
    families: ['security'],
    signal: 'BOUNDARY',
    title: 'Security and malformed transport',
  },
] as const;

export function ScenarioExplorer({ groups }: ScenarioExplorerProps) {
  const scenarioCount = groups.reduce((total, group) => total + group.scenarios.length, 0);
  const scenarioCounts = new Map(
    groups.map((group) => [group.family, group.scenarios.length] as const),
  );

  return (
    <section
      aria-labelledby="scenario-explorer-title"
      className={`${styles.section} ${styles.scenarioExplorer}`}
    >
      <header className={styles.scenarioExplorerHeader}>
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>Repository fault programs</p>
          <h2 id="scenario-explorer-title">Explore fault scenarios</h2>
          <p>
            Choose a deterministic break point, inspect its exact command sequence, and link every
            run back to reviewed JSON.
          </p>
        </div>
        <p className={styles.scenarioCount}>
          <strong>{scenarioCount}</strong>
          <span>checked-in scenarios</span>
        </p>
      </header>

      <ul className={styles.scenarioFamilyGrid}>
        {promotedFamilies.map((family) => {
          const familyCount = family.families.reduce(
            (total, familyName) => total + (scenarioCounts.get(familyName) ?? 0),
            0,
          );

          return (
            <li key={family.title}>
              <span className={styles.scenarioFamilySignal}>{family.signal}</span>
              <strong>{family.title}</strong>
              <p>{family.description}</p>
              <span className={styles.scenarioFamilyCount}>
                {familyCount.toString().padStart(2, '0')} programs
              </span>
            </li>
          );
        })}
      </ul>

      <a className={styles.primaryAction} href="/scenarios">
        Explore all scenarios
      </a>
    </section>
  );
}
