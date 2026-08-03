import type { Metadata } from 'next';
import { getScenarioGroups } from '../../lib/scenarios';
import styles from '../content-pages.module.css';

export const metadata: Metadata = {
  title: 'Scenarios',
  description: 'Every checked-in Cashu delivery fault scenario, generated from repository JSON.',
};

function familyTitle(family: string): string {
  return family
    .split('-')
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

export default async function ScenariosPage() {
  const groups = await getScenarioGroups();
  const scenarioCount = groups.reduce((count, group) => count + group.scenarios.length, 0);

  return (
    <div className={styles.contentPage}>
      <header className={styles.pageHero}>
        <div>
          <p className={styles.eyebrow}>Repository-generated scenario index</p>
          <h1>Choose where delivery breaks.</h1>
          <p className={styles.lede}>
            These are the exact fault programs checked into the repository. Each run stays
            deterministic under the demo seed and links back to its reviewable source.
          </p>
        </div>
        <dl className={styles.heroReadout}>
          <div>
            <dt>Scenarios</dt>
            <dd>{scenarioCount}</dd>
          </div>
          <div>
            <dt>Families</dt>
            <dd>{groups.length}</dd>
          </div>
          <div>
            <dt>Index source</dt>
            <dd>scenarios/**/*.json</dd>
          </div>
        </dl>
      </header>

      <div className={styles.scenarioGroups}>
        {groups.map((group) => (
          <section
            aria-labelledby={`family-${group.family}`}
            className={styles.scenarioGroup}
            key={group.family}
          >
            <header className={styles.groupHeading}>
              <div>
                <p className={styles.eyebrow}>Fault family</p>
                <h2 id={`family-${group.family}`}>{familyTitle(group.family)}</h2>
              </div>
              <span>{group.scenarios.length.toString().padStart(2, '0')} programs</span>
            </header>
            <div className={styles.scenarioGrid}>
              {group.scenarios.map((scenario) => {
                const titleId = `scenario-${scenario.slug.replaceAll('/', '-')}`;
                return (
                  <article
                    aria-labelledby={titleId}
                    className={styles.scenarioCard}
                    key={scenario.slug}
                  >
                    <div className={styles.cardMeta}>
                      <span>{scenario.commandCount} commands</span>
                      <span>{scenario.slug}</span>
                    </div>
                    <h3 id={titleId}>{scenario.name}</h3>
                    <p>{scenario.description}</p>
                    <div className={styles.runCommand}>
                      <span aria-hidden="true">$</span>
                      <code>{scenario.runCommand}</code>
                    </div>
                    <a
                      className={styles.sourceLink}
                      href={scenario.sourceUrl}
                      rel="noreferrer noopener"
                      target="_blank"
                    >
                      View source <span aria-hidden="true">↗</span>
                    </a>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
