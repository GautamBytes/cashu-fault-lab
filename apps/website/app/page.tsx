import { EvidenceReport } from '../components/home/evidence-report';
import { FaultTimeline } from '../components/home/fault-timeline';
import { HeroCommand } from '../components/home/hero-command';
import { HeroRunPanel } from '../components/home/hero-run-panel';
import styles from '../components/home/home.module.css';
import { ScenarioExplorer } from '../components/home/scenario-explorer';
import { VerifiedRunStrip } from '../components/home/verified-run-strip';
import { getDemoSummary } from '../lib/demo';
import { getReleaseStatus } from '../lib/release-status';
import { getScenarioGroups } from '../lib/scenarios';
import { serializeJsonLd } from './site-metadata';

const softwareApplication = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Cashu Fault Lab',
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Linux, macOS, Windows with Docker',
  description:
    'An experimental developer preview for Cashu delivery fault injection, recovery, and independent evidence.',
  license: 'https://opensource.org/license/mit',
  codeRepository: 'https://github.com/GautamBytes/cashu-fault-lab',
} as const;

const safeSoftwareApplicationJson = serializeJsonLd(softwareApplication);

export default async function HomePage() {
  const [summary, releaseStatus, scenarioGroups] = await Promise.all([
    getDemoSummary(),
    getReleaseStatus(),
    getScenarioGroups(),
  ]);

  return (
    <div className={styles.home}>
      <script
        dangerouslySetInnerHTML={{ __html: safeSoftwareApplicationJson }}
        type="application/ld+json"
      />
      <section aria-labelledby="home-title" className={styles.hero}>
        <div className={styles.heroGrid}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              <span>Cashu delivery fault injection and recovery evidence</span>
            </p>
            <h1 id="home-title">Make Cashu delivery fail safely.</h1>
            <p className={styles.heroDescription}>
              Inject response loss, retries, duplicates, and process crashes across real wallets and
              mints—then prove every implementation converges.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href="#verified-run">
                Run the verified demo
              </a>
              <a
                className={styles.secondaryAction}
                href="https://codespaces.new/GautamBytes/cashu-fault-lab?quickstart=1"
                rel="noreferrer noopener"
                target="_blank"
              >
                Open in Codespaces <span aria-hidden="true">↗</span>
              </a>
              <a
                className={styles.secondaryAction}
                href="https://github.com/GautamBytes/cashu-fault-lab"
                rel="noreferrer noopener"
                target="_blank"
              >
                View on GitHub <span aria-hidden="true">↗</span>
              </a>
            </div>
            <HeroCommand />
          </div>
          <HeroRunPanel summary={summary} />
          <div aria-hidden="true" className={styles.heroSignalPath}>
            <span>inject / response_lost</span>
            <i>×</i>
          </div>
        </div>
        <div className={styles.heroTelemetry}>
          <a className={styles.traceCue} href="#verified-run">
            Next / verified run evidence
          </a>
          <dl aria-label="Checked-in demo telemetry" className={styles.heroTelemetryData}>
            <div>
              <dt>Seed</dt>
              <dd>{summary.seed}</dd>
            </div>
            <div>
              <dt>Fault program</dt>
              <dd>{summary.scenarioId}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{summary.invariantCount} invariants</dd>
            </div>
            <div>
              <dt>Outcome</dt>
              <dd className={styles.telemetryPassed}>✓ {summary.status}</dd>
            </div>
          </dl>
        </div>
      </section>

      <VerifiedRunStrip summary={summary} />

      <div className={styles.storySequence}>
        <FaultTimeline />
        <EvidenceReport summary={summary} />
        <ScenarioExplorer groups={scenarioGroups} />
      </div>

      <section
        aria-labelledby="integrate-title"
        className={`${styles.section} ${styles.integrationSection}`}
      >
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>Integrate and validate</p>
          <h2 id="integrate-title">
            Integrate and validate without changing implementation behavior.
          </h2>
          <p>
            Connect a wallet through the language-neutral adapter contract, inspect its trust
            boundary, and keep release claims tied to independent evidence.
          </p>
        </div>
        <div className={styles.integrationGrid}>
          <article>
            <span className={styles.integrationIndex}>01 / Adapter</span>
            <h3>Expose behavior, not internals.</h3>
            <p>
              Preserve native wallet and mint behavior while the lab drives response loss,
              duplicates, crashes, and <strong>Mint ambiguity</strong>.
            </p>
            <a className={styles.textLink} href="/docs/adapters">
              Adapter guide <span aria-hidden="true">→</span>
            </a>
            <a className={styles.textLink} href="/docs/wallet-lifecycle">
              Review wallet lifecycle scope <span aria-hidden="true">→</span>
            </a>
          </article>
          <article>
            <span className={styles.integrationIndex}>02 / Trust boundary</span>
            <h3>Keep evaluation independent.</h3>
            <p>
              Implementations own persistence and recovery. The oracle evaluates safety and liveness
              from evidence outside the implementation.
            </p>
            <a className={styles.textLink} href="/architecture">
              Architecture <span aria-hidden="true">→</span>
            </a>
          </article>
          <article>
            <span className={styles.integrationIndex}>03 / Release gate</span>
            <h3>{releaseStatus.label}</h3>
            <p>
              The deterministic run is useful evidence, not certification. Qualification still needs
              independent pairs, mints, and review.
            </p>
            <a className={styles.textLink} href="/release-status">
              Validation status <span aria-hidden="true">→</span>
            </a>
          </article>
        </div>
      </section>

      <section
        aria-labelledby="contribute-title"
        className={`${styles.section} ${styles.contributeSection}`}
      >
        <div>
          <p className={styles.eyebrow}>Contribution</p>
          <h2 id="contribute-title">Add an adapter. Break a delivery. Improve the evidence.</h2>
        </div>
        <div className={styles.contributeActions}>
          <a className={styles.primaryAction} href="/docs/contributing">
            Read the contribution guide
          </a>
          <a
            className={styles.secondaryAction}
            href="https://github.com/GautamBytes/cashu-fault-lab/issues"
            rel="noreferrer noopener"
            target="_blank"
          >
            Open an issue <span aria-hidden="true">↗</span>
          </a>
        </div>
      </section>
    </div>
  );
}
