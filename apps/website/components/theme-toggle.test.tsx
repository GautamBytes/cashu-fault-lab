import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_STORAGE_KEY, themeBootstrapScript } from '../lib/theme';
import { ThemeToggle } from './theme-toggle';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('ThemeToggle', () => {
  it('switches themes and persists the visitor choice', () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle />);

    const toggle = screen.getByRole('button', { name: 'Toggle color theme' });
    fireEvent.click(toggle);

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(toggle);

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('uses the system preference before the visitor makes a choice', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );

    Function(themeBootstrapScript)();

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });
});
