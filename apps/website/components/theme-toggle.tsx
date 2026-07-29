'use client';

import { useEffect } from 'react';
import { THEME_STORAGE_KEY } from '../lib/theme';
import styles from './site-header.module.css';

type Theme = 'dark' | 'light';

function applyTheme(theme: Theme, persist: boolean) {
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(THEME_STORAGE_KEY, theme);
}

export function ThemeToggle() {
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!preference) return;

    function followSystemPreference(event: MediaQueryListEvent) {
      if (localStorage.getItem(THEME_STORAGE_KEY) === null) {
        applyTheme(event.matches ? 'light' : 'dark', false);
      }
    }

    preference.addEventListener?.('change', followSystemPreference);
    return () => preference.removeEventListener?.('change', followSystemPreference);
  }, []);

  function toggleTheme() {
    const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme(current === 'light' ? 'dark' : 'light', true);
  }

  return (
    <button
      aria-label="Toggle color theme"
      className={styles.themeToggle}
      onClick={toggleTheme}
      title="Toggle light or dark theme"
      type="button"
    >
      <span aria-hidden="true" className={styles.themeSun}>
        ☀
      </span>
      <span aria-hidden="true" className={styles.themeMoon}>
        ☾
      </span>
    </button>
  );
}
