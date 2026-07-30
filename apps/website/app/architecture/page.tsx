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
    describedBy: 'sender-title',
    id: 'exact-payload',
    marker: 'P',
    origin: 'From durable sender',
    title: 'Exact payload',
    text: 'Preserves the immutable payload bytes and delivery identity used for every retry.',
  },
  {
    describedBy: 'receiver-title',
    id: 'mint-recovery',
    marker: 'M',
    origin: 'From durable receiver',
    title: 'Mint recovery',
    text: 'Reconciles possible proof consumption against independent mint observations.',
  },
] as const;

const trustPrinciples = [
  ['01', 'The lab controls faults, not wallet behavior.'],
  ['02', 'Implementations own persistence and recovery.'],
  ['03', 'The oracle evaluates claims from outside evidence.'],
] as const;

const qualificationStates = [
  {
    id: 'successful-recovery',
    kicker: 'Run result',
    status: 'Observed',
    title: 'Successful recovery',
    text: 'One tested pair can demonstrate correct behavior for one deterministic run.',
    checks: [
      'Same delivery converges',
      'Duplicate credit is prevented',
      'Receipt and mint state reconcile',
    ],
  },
  {
    id: 'release-qualification',
    kicker: 'Release gate',
    status: 'Independent',
    title: 'Release qualification',
    text: 'A release claim needs broader evidence than a single implementation can produce.',
    checks: [
      'Independent implementation pairs',
      'Distinct mints and authorities',
      'Reviewed qualifying evidence',
    ],
  },
] as const;

export default function ArchitecturePage() {
  return (
    <DocsShell destinations={getDocumentationDestinations()} document={architectureDocument}>
      <div className={styles.contentPage}>
        <header className={`${styles.pageHero} ${styles.architectureHero}`}>
          <div className={styles.architectureHeroCopy}>
            <p className={styles.eyebrow}>Evidence architecture</p>
            <h1>Faults travel. Trust does not.</h1>
            <p className={styles.lede}>
              The lab controls the disturbance, durable implementations recover, and a separate
              oracle decides what the evidence can support.
            </p>
          </div>
          <aside aria-label="Trust boundary" className={styles.boundaryNote}>
            <header className={styles.boundaryHeading}>
              <span aria-hidden="true">◇</span>
              <div>
                <p className={styles.stageKicker}>Trust boundary</p>
                <h2>Recovery is implementation-owned. Judgment is not.</h2>
              </div>
            </header>
            <ol>
              {trustPrinciples.map(([marker, text]) => (
                <li key={marker}>
                  <span>{marker}</span>
                  {text}
                </li>
              ))}
            </ol>
          </aside>
        </header>

        <section
          aria-labelledby="flow-title"
          className={styles.flowSection}
          data-scroll-reveal="off"
        >
          <header className={styles.sectionIntro}>
            <p className={styles.eyebrow}>System map</p>
            <h2 id="flow-title">One delivery. Separate authorities.</h2>
            <p>
              Delivery stays implementation-owned. Evidence crosses the trust boundary before any
              safety or liveness claim is accepted.
            </p>
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
              <div className={styles.pipelineHeading}>
                <span>Delivery path</span>
                <span>Implementation-owned recovery</span>
              </div>
              <ol aria-label="Primary delivery path" className={styles.deliveryPath}>
                {deliveryStages.map((stage, index) => (
                  <li className={styles.pathStage} key={stage.id}>
                    <article aria-labelledby={`${stage.id}-title`} className={styles.stageCard}>
                      <header className={styles.stageHeader}>
                        <span aria-hidden="true" className={styles.flowMarker}>
                          {stage.marker}
                        </span>
                        <span className={styles.stageKicker}>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                      </header>
                      <h3 id={`${stage.id}-title`}>{stage.title}</h3>
                      <p>{stage.text}</p>
                    </article>
                  </li>
                ))}
              </ol>

              <div
                aria-label="Independent evidence path"
                className={styles.evidenceRail}
                role="group"
              >
                <div className={styles.evidenceSources}>
                  <span className={styles.railLabel}>Independent observations</span>
                  <ul aria-label="Evidence sources" className={styles.evidenceSourceList}>
                    {evidenceBranches.map((branch) => (
                      <li key={branch.id}>
                        <article
                          aria-describedby={branch.describedBy}
                          aria-labelledby={`${branch.id}-title`}
                          className={styles.branchCard}
                        >
                          <span aria-hidden="true" className={styles.flowMarker}>
                            {branch.marker}
                          </span>
                          <div>
                            <span className={styles.branchOrigin}>{branch.origin}</span>
                            <h3 id={`${branch.id}-title`}>{branch.title}</h3>
                            <p>{branch.text}</p>
                          </div>
                        </article>
                      </li>
                    ))}
                  </ul>
                </div>

                <span aria-hidden="true" className={styles.evidenceArrow}>
                  →
                </span>

                <article
                  aria-describedby="exact-payload-title mint-recovery-title"
                  aria-labelledby="oracle-title"
                  className={`${styles.evidenceNode} ${styles.oracleStage}`}
                >
                  <span aria-hidden="true" className={styles.flowMarker}>
                    O
                  </span>
                  <span className={styles.stageKicker}>Evaluation</span>
                  <h3 id="oracle-title">Independent oracle</h3>
                  <p>Evaluates safety and liveness from authorities outside the implementation.</p>
                </article>

                <span aria-hidden="true" className={styles.evidenceArrow}>
                  →
                </span>

                <article
                  aria-describedby="oracle-title"
                  aria-labelledby="evidence-title"
                  className={`${styles.evidenceNode} ${styles.evidenceStage}`}
                >
                  <span aria-hidden="true" className={styles.flowMarker}>
                    E
                  </span>
                  <span className={styles.stageKicker}>Portable output</span>
                  <h3 id="evidence-title">JSON/JUnit/HTML evidence</h3>
                  <p>Unsupported claims remain explicitly not observable.</p>
                </article>
              </div>
            </div>
            <figcaption className={styles.topologyCaption} id="topology-caption">
              Durable sender → HTTP/Nostr faults → durable receiver. Sender payload evidence and
              receiver mint-recovery evidence branch downward, converge at the independent oracle,
              then flow to JSON, JUnit, and HTML evidence.
            </figcaption>
          </figure>
        </section>

        <section
          aria-labelledby="separation-title"
          className={styles.separationSection}
          data-scroll-reveal="off"
        >
          <header className={styles.separationIntro}>
            <p className={styles.eyebrow}>Separation of concerns</p>
            <h2 id="separation-title">Recovery behavior is not release evidence.</h2>
            <p>
              A sender may converge and a receiver may avoid duplicate credit while the release gate
              still remains blocked. Behavior is observed per run; qualification additionally
              requires independent implementations, mints, authorities, and review.
            </p>
          </header>
          <div className={styles.qualificationGrid}>
            {qualificationStates.map((state) => (
              <article
                aria-labelledby={`${state.id}-title`}
                className={styles.qualificationCard}
                key={state.id}
              >
                <header>
                  <span className={styles.cardMeta}>{state.kicker}</span>
                  <span className={styles.qualificationStatus}>{state.status}</span>
                </header>
                <h3 id={`${state.id}-title`}>{state.title}</h3>
                <p>{state.text}</p>
                <ul>
                  {state.checks.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <div className={styles.qualificationAction}>
            <p>Use run evidence for feedback. Use the strict gate for release claims.</p>
            <a className={styles.inlineLink} href="/release-status">
              Inspect the strict release gate <span aria-hidden="true">→</span>
            </a>
          </div>
        </section>
      </div>
    </DocsShell>
  );
}
