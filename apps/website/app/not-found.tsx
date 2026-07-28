import type { Metadata } from 'next';
import { OpenSearchButton } from '../components/open-search-button';
import styles from './not-found.module.css';

export const metadata: Metadata = {
  alternates: {
    canonical: null,
  },
};

export default function NotFound() {
  return (
    <section aria-labelledby="not-found-title" className={styles.notFound}>
      <div>
        <p className={styles.eyebrow}>Route fault / no matching artifact</p>
        <h1 id="not-found-title">Page not found.</h1>
        <p className={styles.description}>
          The requested route did not converge on a public page. Search the documentation or return
          to a known starting point.
        </p>
        <div aria-label="Recovery actions" className={styles.actions}>
          <OpenSearchButton aria-label="Search documentation">
            Search documentation
          </OpenSearchButton>
          <a href="/docs/getting-started">Getting started</a>
          <a href="/scenarios">Scenarios</a>
          <a
            href="https://github.com/GautamBytes/cashu-fault-lab"
            rel="noreferrer noopener"
            target="_blank"
          >
            GitHub <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
      <aside aria-label="Fault readout" className={styles.instrument}>
        <strong>404</strong>
        <span>FAULT: ROUTE_NOT_FOUND</span>
        <span>RECOVERY: DOCUMENTATION_READY</span>
      </aside>
    </section>
  );
}
