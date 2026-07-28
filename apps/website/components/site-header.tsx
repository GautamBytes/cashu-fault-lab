"use client";

import { useState } from "react";
import styles from "./site-header.module.css";

export interface SiteHeaderProps {
  onOpenSearch?: () => void;
}

const navigation = [
  { href: "/", label: "Home" },
  { href: "/docs/getting-started", label: "Docs" },
  { href: "/cli", label: "CLI" },
  { href: "/scenarios", label: "Scenarios" },
  { href: "/adapters", label: "Adapters" },
  { href: "/architecture", label: "Architecture" },
  { href: "/release-status", label: "Release status" },
];

export function SiteHeader({ onOpenSearch }: SiteHeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <a className={styles.brand} href="/">
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
          className={`${styles.navigation} ${isMenuOpen ? styles.navigationOpen : ""}`}
          id="primary-navigation"
        >
          <div className={styles.links}>
            {navigation.map((item) => (
              <a href={item.href} key={item.href}>
                {item.label}
              </a>
            ))}
            <a href="https://github.com/cashubtc/cashu" rel="noreferrer noopener" target="_blank">
              GitHub
            </a>
          </div>
          <button
            aria-haspopup="dialog"
            aria-label="Search documentation"
            className={styles.searchButton}
            onClick={onOpenSearch}
            type="button"
          >
            Search <span aria-hidden="true">⌘K</span>
          </button>
        </nav>
      </div>
    </header>
  );
}
