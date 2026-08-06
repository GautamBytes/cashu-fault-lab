'use client';

import { useState } from 'react';
import styles from './site-header.module.css';
import { ThemeToggle } from './theme-toggle';

export interface SiteHeaderProps {
  currentPath?: string;
  onOpenSearch?: () => void;
}

const navigation = [
  { href: '/', label: 'Home' },
  { href: '/docs/getting-started', label: 'Docs' },
];

const exploreNavigation = [
  { href: '/scenarios', label: 'Scenarios' },
  { href: '/architecture', label: 'Architecture' },
  { href: '/#verified-run', label: 'Evidence' },
  { href: '/release-status', label: 'Release status' },
];

function isCurrentPath(currentPath: string, href: string): boolean {
  if (href.includes('#')) return false;
  const route = href.split('#')[0] || '/';
  if (route === '/') return currentPath === '/';
  if (route === '/docs/getting-started') return currentPath.startsWith('/docs');
  return currentPath === route || currentPath.startsWith(`${route}/`);
}

export function SiteHeader({ currentPath = '/', onOpenSearch }: SiteHeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const exploreIsCurrent = exploreNavigation.some((item) => isCurrentPath(currentPath, item.href));

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <a className={styles.brand} href="/">
          <img
            alt=""
            className={styles.brandMark}
            height="28"
            src="/cashu-fault-lab.png"
            width="28"
          />
          Cashu Fault Lab
        </a>
        <button
          aria-controls="primary-navigation"
          aria-expanded={isMenuOpen}
          aria-label="Toggle primary navigation"
          className={styles.menuButton}
          onClick={() => setIsMenuOpen((open) => !open)}
          type="button"
        >
          Menu
        </button>
        <nav
          aria-label="Primary"
          className={`${styles.navigation} ${isMenuOpen ? styles.navigationOpen : ''}`}
          id="primary-navigation"
        >
          <div className={styles.links}>
            {navigation.map((item) => (
              <a
                aria-current={isCurrentPath(currentPath, item.href) ? 'page' : undefined}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </a>
            ))}
            <details className={styles.explore}>
              <summary aria-current={exploreIsCurrent ? 'page' : undefined}>
                Explore <span aria-hidden="true">⌄</span>
              </summary>
              <div className={styles.exploreMenu}>
                {exploreNavigation.map((item) => (
                  <a
                    aria-current={isCurrentPath(currentPath, item.href) ? 'page' : undefined}
                    href={item.href}
                    key={item.href}
                  >
                    {item.label}
                  </a>
                ))}
              </div>
            </details>
          </div>
          <div className={styles.headerActions}>
            <a
              className={styles.npmAction}
              href="https://www.npmjs.com/package/cashu-fault-lab"
              rel="noreferrer noopener"
              target="_blank"
            >
              Install from npm <span aria-hidden="true">↗</span>
            </a>
            <ThemeToggle />
            <button
              aria-haspopup="dialog"
              aria-label="Search documentation"
              className={styles.searchButton}
              onClick={onOpenSearch}
              type="button"
            >
              <span aria-hidden="true" className={styles.searchIcon} />
              <span className={styles.searchLabel}>Search</span>
              <kbd className={styles.searchHint}>⌘K</kbd>
            </button>
          </div>
        </nav>
      </div>
    </header>
  );
}
