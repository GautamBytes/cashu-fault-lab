import type { Metadata } from 'next';
import { getReleaseStatus } from '../../lib/release-status';
import { sourceUrl } from '../../lib/repository';
import styles from '../content-pages.module.css';

export const metadata: Metadata = {
  title: 'Release status',
  description:
    'The checked-in Cashu Fault Lab release policy, current evidence, and open blockers.',
};

const validationTasks = [
  {
    actor: 'Independent wallet maintainer',
    check: 'Run the 13-scenario release suite with an independently implemented receiver.',
    artifact: 'Signed qualifying matrix entry with receiver evidence references.',
  },
  {
    actor: 'Independent mint operator',
    check: 'Provide mint and ledger observations from authorities outside the wallet under test.',
    artifact: 'Signed mint and ledger evidence linked to the qualifying run.',
  },
  {
    actor: 'Second implementation team',
    check: 'Complete the release suite with a distinct, cross-implementation sender/receiver pair.',
    artifact: 'A second signed qualifying matrix entry from a distinct build.',
  },
  {
    actor: 'Second mint operator',
    check: 'Repeat qualifying coverage against a mint identity not used by the first pair.',
    artifact: 'Evidence bundle identifying the second independent mint authority.',
  },
  {
    actor: 'Cashu protocol reviewer',
    check: 'Review the matrix, evidence provenance, unsupported claims, and release-policy result.',
    artifact: 'Signed review decision referencing the qualifying evidence digest.',
  },
] as const;

export default async function ReleaseStatusPage() {
  const status = await getReleaseStatus();

  return (
    <div className={styles.contentPage}>
      <header className={`${styles.pageHero} ${styles.releaseHero}`}>
        <div>
          <p className={styles.eyebrow}>
            Release status / policy schema {status.policySchemaVersion}
          </p>
          <h1>Awaiting independent validation.</h1>
          <p className={styles.lede}>
            The deterministic demo passes. Cashu Fault Lab remains an experimental developer preview
            until independent implementations, mints, and reviewers satisfy the strict release gate.
          </p>
        </div>
        <div className={styles.statusStamp}>
          <span>Current label</span>
          <strong>{status.label}</strong>
          <small>profile: {status.profile}</small>
        </div>
      </header>

      <section aria-labelledby="gate-title" className={styles.gateSection}>
        <header className={styles.sectionIntro}>
          <p className={styles.eyebrow}>Required versus current</p>
          <h2 id="gate-title">Requirements are not passes.</h2>
          <p>
            Current values remain zero because this repository contains no signed qualifying matrix
            artifact. Test counts and the demo artifact are intentionally excluded.
          </p>
        </header>
        <div className={styles.gateGrid}>
          <article>
            <span>Qualifying implementation pairs</span>
            <strong>
              {status.currentQualifyingPairs} of {status.minimumQualifyingPairs}
            </strong>
            <div aria-hidden="true" className={styles.emptyMeter}>
              <i />
              <i />
            </div>
          </article>
          <article>
            <span>Distinct mint identities</span>
            <strong>
              {status.currentDistinctMints} of {status.minimumDistinctMints}
            </strong>
            <div aria-hidden="true" className={styles.emptyMeter}>
              <i />
              <i />
            </div>
          </article>
          <article>
            <span>Required suite scenarios</span>
            <strong>{status.releaseSuiteScenarioCount}</strong>
            <p>
              Defined by the checked-in suite; scenario inclusion is not a qualification result.
            </p>
          </article>
        </div>
      </section>

      <section aria-labelledby="safety-title" className={styles.blockersSection}>
        <div className={styles.safetyCopy}>
          <p className={styles.eyebrow}>Honest failure</p>
          <h2 id="safety-title">A failing strict gate is a safety feature.</h2>
          <p>
            It prevents internal, incomplete, or self-reported evidence from becoming a public
            interoperability claim. The preview stays useful while every missing authority remains
            visible.
          </p>
        </div>
        <div>
          <p className={styles.listLabel}>Independent validation work</p>
          <ul className={styles.blockerList}>
            {validationTasks.map((task, index) => (
              <li key={task.actor}>
                <span aria-hidden="true">×</span>
                <article>
                  <header>
                    <strong>{task.actor}</strong>
                    <small>{status.blockers[index]}</small>
                  </header>
                  <dl>
                    <div>
                      <dt>Check</dt>
                      <dd>{task.check}</dd>
                    </div>
                    <div>
                      <dt>Expected artifact</dt>
                      <dd>{task.artifact}</dd>
                    </div>
                  </dl>
                </article>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <nav aria-label="Release sources" className={styles.sourceRail}>
        <a href="/docs/release-notes">Release notes</a>
        <a href="/docs/release-checklist">Release checklist</a>
        <a
          href={sourceUrl('spec/release-policy.json', 'view')}
          rel="noreferrer noopener"
          target="_blank"
        >
          Policy source
        </a>
        <a
          href={sourceUrl('spec/release-suite.json', 'view')}
          rel="noreferrer noopener"
          target="_blank"
        >
          Suite source
        </a>
      </nav>
    </div>
  );
}
