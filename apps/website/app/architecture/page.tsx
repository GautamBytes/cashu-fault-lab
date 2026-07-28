import type { Metadata } from 'next';
import styles from '../content-pages.module.css';

export const metadata: Metadata = {
  title: 'Architecture | Cashu Fault Lab',
  description: 'How Cashu Fault Lab separates delivery faults from independent recovery evidence.',
};

const stages = [
  {
    marker: 'S',
    title: 'Durable sender',
    text: 'Reserves proofs, persists one immutable payload, and recovers the same delivery identity.',
  },
  {
    marker: '×',
    title: 'HTTP/Nostr faults',
    text: 'Drops, delays, duplicates, and reorders lab-controlled transport events.',
  },
  {
    marker: 'R',
    title: 'Durable receiver',
    text: 'Persists intent and receipts across crashes without granting itself a pass.',
  },
  {
    marker: 'M',
    title: 'Mint recovery',
    text: 'Reconciles possible proof consumption against independent mint observations.',
  },
  {
    marker: 'O',
    title: 'Independent oracle',
    text: 'Evaluates safety and liveness from authorities outside the implementation under test.',
  },
  {
    marker: 'E',
    title: 'JSON/JUnit/HTML evidence',
    text: 'Emits portable results with unsupported claims kept explicitly not observable.',
  },
] as const;

export default function ArchitecturePage() {
  return (
    <div className={styles.contentPage}>
      <header className={`${styles.pageHero} ${styles.architectureHero}`}>
        <div>
          <p className={styles.eyebrow}>Evidence architecture</p>
          <h1>Faults travel. Trust does not.</h1>
          <p className={styles.lede}>
            The lab controls the disturbance, durable implementations recover, and a separate oracle
            decides what the evidence can support.
          </p>
        </div>
        <aside className={styles.boundaryNote}>
          <span aria-hidden="true">◇</span>
          <p>
            <strong>Trust boundary</strong>
            No wallet, receiver, or demo result can certify itself.
          </p>
        </aside>
      </header>

      <section aria-labelledby="flow-title" className={styles.flowSection}>
        <header className={styles.sectionIntro}>
          <p className={styles.eyebrow}>Six-stage evidence path</p>
          <h2 id="flow-title">One delivery. Separate authorities.</h2>
        </header>
        <ol aria-label="Evidence architecture flow" className={styles.architectureFlow}>
          {stages.map((stage, index) => (
            <li className={styles.flowStage} key={stage.title}>
              <span className={styles.flowMarker} aria-hidden="true">
                {stage.marker}
              </span>
              <span className={styles.flowNumber}>{String(index + 1).padStart(2, '0')}</span>
              <h3>{stage.title}</h3>
              <p>{stage.text}</p>
              {index === 0 ? <span className={styles.payloadLabel}>exact payload →</span> : null}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="separation-title" className={styles.separationSection}>
        <div>
          <p className={styles.eyebrow}>Separation of concerns</p>
          <h2 id="separation-title">Recovery behavior is not release evidence.</h2>
        </div>
        <div className={styles.separationCopy}>
          <p>
            A sender may converge and a receiver may avoid duplicate credit while the release gate
            still remains blocked. Behavior is observed per run; qualification additionally requires
            independent implementations, mints, authorities, and review.
          </p>
          <a className={styles.inlineLink} href="/release-status">
            Inspect the strict release gate <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>
    </div>
  );
}
