import type { Metadata } from 'next';
import { DocsShell } from '../../components/docs/docs-shell';
import type { GeneratedDocumentPage } from '../../lib/content-types';
import { getDocumentationDestinations, getGeneratedDocumentPage } from '../../lib/content-registry';
import styles from '../content-pages.module.css';

function requireArchitectureDocument(): GeneratedDocumentPage {
  const document = getGeneratedDocumentPage('architecture');
  if (!document) {
    throw new Error('Architecture documentation destination is not registered');
  }
  return document;
}

const architectureDocument = requireArchitectureDocument();

export const metadata: Metadata = {
  title: architectureDocument.title,
  description: architectureDocument.description,
};

const deliveryStages = [
  {
    id: 'sender',
    marker: 'S',
    title: 'Durable sender',
    text: 'Reserves proofs, persists one immutable payload, and recovers the same delivery identity.',
  },
  {
    id: 'faults',
    marker: '×',
    title: 'HTTP/Nostr faults',
    text: 'Drops, delays, duplicates, and reorders lab-controlled transport events.',
  },
  {
    id: 'receiver',
    marker: 'R',
    title: 'Durable receiver',
    text: 'Persists intent and receipts across crashes without granting itself a pass.',
  },
] as const;

const evidenceBranches = [
  {
    className: 'senderBranch' as const,
    describedBy: 'sender-title',
    id: 'exact-payload',
    marker: 'P',
    origin: 'From durable sender',
    title: 'Exact payload',
    text: 'Preserves the immutable payload bytes and delivery identity used for every retry.',
  },
  {
    className: 'receiverBranch' as const,
    describedBy: 'receiver-title',
    id: 'mint-recovery',
    marker: 'M',
    origin: 'From durable receiver',
    title: 'Mint recovery',
    text: 'Reconciles possible proof consumption against independent mint observations.',
  },
] as const;

export default function ArchitecturePage() {
  return (
    <DocsShell destinations={getDocumentationDestinations()} document={architectureDocument}>
      <div className={styles.contentPage}>
        <header className={`${styles.pageHero} ${styles.architectureHero}`}>
          <div>
            <p className={styles.eyebrow}>Evidence architecture</p>
            <h1>Faults travel. Trust does not.</h1>
            <p className={styles.lede}>
              The lab controls the disturbance, durable implementations recover, and a separate
              oracle decides what the evidence can support.
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
            <p className={styles.eyebrow}>Branched evidence path</p>
            <h2 id="flow-title">One delivery. Separate authorities.</h2>
          </header>
          <figure
            aria-describedby="topology-caption"
            aria-labelledby="flow-title"
            className={styles.topologyFigure}
          >
            <div
              aria-label="Cashu delivery and evidence topology"
              className={styles.topologyDiagram}
              role="group"
            >
              <ol aria-label="Primary delivery path" className={styles.deliveryPath}>
                {deliveryStages.map((stage) => (
                  <li className={styles.pathStage} key={stage.id}>
                    <article aria-labelledby={`${stage.id}-title`} className={styles.stageCard}>
                      <span aria-hidden="true" className={styles.flowMarker}>
                        {stage.marker}
                      </span>
                      <span className={styles.stageKicker}>Delivery path</span>
                      <h3 id={`${stage.id}-title`}>{stage.title}</h3>
                      <p>{stage.text}</p>
                    </article>
                  </li>
                ))}
              </ol>

              <ul
                aria-label="Evidence branches converging at independent oracle"
                className={styles.branchList}
              >
                {evidenceBranches.map((branch) => (
                  <li className={styles[branch.className]} key={branch.id}>
                    <article
                      aria-describedby={branch.describedBy}
                      aria-labelledby={`${branch.id}-title`}
                      className={`${styles.stageCard} ${styles.branchCard}`}
                    >
                      <span className={styles.branchOrigin}>
                        {branch.origin} <span aria-hidden="true">↓</span>
                      </span>
                      <span aria-hidden="true" className={styles.flowMarker}>
                        {branch.marker}
                      </span>
                      <h3 id={`${branch.id}-title`}>{branch.title}</h3>
                      <p>{branch.text}</p>
                    </article>
                  </li>
                ))}
              </ul>

              <div aria-hidden="true" className={styles.convergenceLines}>
                <span>Both evidence branches converge</span>
              </div>

              <article
                aria-describedby="exact-payload-title mint-recovery-title"
                aria-labelledby="oracle-title"
                className={`${styles.stageCard} ${styles.oracleStage}`}
              >
                <span aria-hidden="true" className={styles.flowMarker}>
                  O
                </span>
                <span className={styles.stageKicker}>Convergence point</span>
                <h3 id="oracle-title">Independent oracle</h3>
                <p>
                  Evaluates safety and liveness from authorities outside the implementation under
                  test.
                </p>
              </article>

              <div aria-hidden="true" className={styles.oracleOutputLine}>
                <span>evaluated result</span>
              </div>

              <article
                aria-describedby="oracle-title"
                aria-labelledby="evidence-title"
                className={`${styles.stageCard} ${styles.evidenceStage}`}
              >
                <span aria-hidden="true" className={styles.flowMarker}>
                  E
                </span>
                <span className={styles.stageKicker}>Evidence output</span>
                <h3 id="evidence-title">JSON/JUnit/HTML evidence</h3>
                <p>
                  Emits portable results with unsupported claims kept explicitly not observable.
                </p>
              </article>
            </div>
            <figcaption className={styles.topologyCaption} id="topology-caption">
              Durable sender → HTTP/Nostr faults → durable receiver. Sender payload evidence and
              receiver mint-recovery evidence branch downward, converge at the independent oracle,
              then flow to JSON, JUnit, and HTML evidence.
            </figcaption>
          </figure>
        </section>

        <section aria-labelledby="separation-title" className={styles.separationSection}>
          <div>
            <p className={styles.eyebrow}>Separation of concerns</p>
            <h2 id="separation-title">Recovery behavior is not release evidence.</h2>
          </div>
          <div className={styles.separationCopy}>
            <p>
              A sender may converge and a receiver may avoid duplicate credit while the release gate
              still remains blocked. Behavior is observed per run; qualification additionally
              requires independent implementations, mints, authorities, and review.
            </p>
            <a className={styles.inlineLink} href="/release-status">
              Inspect the strict release gate <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>
      </div>
    </DocsShell>
  );
}
