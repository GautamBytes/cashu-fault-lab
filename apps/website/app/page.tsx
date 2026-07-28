import Image from 'next/image';
import { EvidenceReport } from '../components/home/evidence-report';
import { FaultTimeline } from '../components/home/fault-timeline';
import styles from '../components/home/home.module.css';
import { getDemoSummary } from '../lib/demo';

const testedFaults = [
  {
    title: 'Response loss',
    text: 'Drop the transport response after a receiver may already have accepted the proofs.',
    icon: '×',
  },
  {
    title: 'Exact retries',
    text: 'Repeat one immutable delivery identity and payload instead of creating a second payment.',
    icon: '↻',
  },
  {
    title: 'Duplicate delivery',
    text: 'Send the same delivery more than once and verify that side effects remain singular.',
    icon: '≡',
  },
  {
    title: 'Process crashes',
    text: 'Restart senders and receivers at persistence boundaries, then inspect durable recovery.',
    icon: '‖',
  },
] as const;

const profileSteps = [
  ['01', 'Reserve', 'Bind one proof set to one immutable delivery identity.'],
  ['02', 'Deliver', 'Send the exact payload over a declared transport.'],
  ['03', 'Observe', 'Record receipts, proof state, ledger credit, and fault history.'],
  ['04', 'Converge', 'Retry or recover until one terminal, evidence-backed result remains.'],
] as const;

export default async function HomePage() {
  const summary = await getDemoSummary();

  return (
    <div className={styles.home}>
      <section aria-labelledby="home-title" className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>Cashu delivery fault injection and recovery evidence</p>
          <h1 id="home-title">Make Cashu delivery fail safely.</h1>
          <p className={styles.heroDescription}>
            Inject response loss, retries, duplicates, and process crashes across real wallets and
            mints—then prove every implementation converges.
          </p>
          <div className={styles.heroActions}>
            <a
              className={styles.primaryAction}
              href="/docs/getting-started#run-the-deterministic-demo"
            >
              Run the deterministic demo
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
          <div aria-label="Demo command" className={styles.commandBlock}>
            <span aria-hidden="true">$</span>
            <code>pnpm lab demo</code>
            <span className={styles.commandNote}>seeded · local · secret-redacted</span>
          </div>
        </div>

        <aside aria-label="Cashu Fault Lab mark" className={styles.heroInstrument}>
          <div className={styles.markFrame}>
            <Image
              alt="Cashu Fault Lab pixel-art mark"
              height={256}
              priority
              src="/cashu-fault-lab.png"
              width={256}
            />
          </div>
          <div className={styles.instrumentReadout}>
            <span>LAB / v0.1</span>
            <span>FAULT: RESPONSE_LOST</span>
            <strong>CONVERGED ✓</strong>
          </div>
        </aside>
      </section>

      <FaultTimeline />
      <EvidenceReport summary={summary} />

      <section aria-labelledby="tested-title" className={styles.section}>
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>What gets tested</p>
          <h2 id="tested-title">Ambiguity at the delivery boundary.</h2>
          <p>
            The lab controls faults and observes outcomes while wallet and mint implementations keep
            their native behavior.
          </p>
        </div>
        <ul className={styles.faultGrid}>
          {testedFaults.map((fault) => (
            <li key={fault.title}>
              <span aria-hidden="true">{fault.icon}</span>
              <h3>{fault.title}</h3>
              <p>{fault.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-labelledby="profile-title"
        className={`${styles.section} ${styles.profileSection}`}
      >
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>cashu-delivery-v1 flow</p>
          <h2 id="profile-title">One identity from reservation to recovery.</h2>
          <p>
            An experimental application profile makes retries observable without changing the
            underlying Cashu or Nostr protocols.
          </p>
        </div>
        <ol className={styles.profileFlow}>
          {profileSteps.map(([number, title, text]) => (
            <li key={number}>
              <span>{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
        <a className={styles.textLink} href="/docs/delivery-profile">
          Read the delivery profile <span aria-hidden="true">→</span>
        </a>
      </section>

      <section
        aria-labelledby="coverage-title"
        className={`${styles.section} ${styles.coverageSection}`}
      >
        <div className={styles.sectionHeading}>
          <p className={styles.eyebrow}>Invariant coverage</p>
          <h2 id="coverage-title">Safety, liveness, and independent evidence.</h2>
        </div>
        <div className={styles.coverageLayout}>
          <p className={styles.coverageCount}>
            <strong>{summary.invariantCount}</strong>
            <span>structured invariant results in every artifact</span>
          </p>
          <ul>
            <li>
              <strong>Safety</strong>
              <span>No duplicate credit, proof reuse, or mutable delivery identity.</span>
            </li>
            <li>
              <strong>Liveness</strong>
              <span>Retries and recovery reach a terminal state.</span>
            </li>
            <li>
              <strong>Evidence</strong>
              <span>Missing observations stay not observable; they never become passes.</span>
            </li>
          </ul>
        </div>
        <a className={styles.textLink} href="/docs/invariants">
          Explore all invariants <span aria-hidden="true">→</span>
        </a>
      </section>

      <section
        aria-labelledby="adapters-title"
        className={`${styles.section} ${styles.splitSection}`}
      >
        <div>
          <p className={styles.eyebrow}>Adapters</p>
          <h2 id="adapters-title">Bring the implementation. Keep its behavior.</h2>
        </div>
        <div>
          <p>
            Language-neutral HTTP adapters expose wallet capabilities and test controls. The lab
            does not require cashu-ts, CDK, or another implementation to share its runtime.
          </p>
          <a className={styles.textLink} href="/docs/adapters">
            Integrate an adapter <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>

      <section
        aria-labelledby="security-title"
        className={`${styles.section} ${styles.boundarySection}`}
      >
        <div className={styles.boundaryMark} aria-hidden="true">
          ◇
        </div>
        <div>
          <p className={styles.eyebrow}>Security boundary</p>
          <h2 id="security-title">The implementation does not judge itself.</h2>
          <p>
            The independent oracle consumes adapter observations and lab-controlled transport,
            ledger, and mint evidence. Reports expose counts and safe references—not proof secrets
            or arbitrary evidence values.
          </p>
          <a className={styles.textLink} href="/docs/threat-model">
            Review the threat model <span aria-hidden="true">→</span>
          </a>
        </div>
      </section>

      <section
        aria-labelledby="release-title"
        className={`${styles.section} ${styles.releaseSection}`}
      >
        <div className={styles.releaseFlag}>
          <span aria-hidden="true">!</span>
          Experimental developer preview
        </div>
        <div>
          <p className={styles.eyebrow}>Release status</p>
          <h2 id="release-title">Useful evidence. Not certification.</h2>
          <p>
            The strict gate remains blocked on an independent wallet receiver, distinct qualifying
            mint identities, trustworthy build provenance, and external integrations.
          </p>
          <a className={styles.textLink} href="/docs/release-notes">
            Read the v0.1 release notes <span aria-hidden="true">→</span>
          </a>
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
          <a className={styles.primaryAction} href="/docs/adapters">
            Start with the adapter guide
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
