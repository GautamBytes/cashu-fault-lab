import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import NotFound from '../app/not-found';
import { SiteHeader } from '../components/site-header';

const globalsCss = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
const homeCss = readFileSync(resolve(process.cwd(), 'components/home/home.module.css'), 'utf8');
const contentPagesCss = readFileSync(resolve(process.cwd(), 'app/content-pages.module.css'), 'utf8');

describe('SiteHeader', () => {
  it('exposes the compact primary navigation', () => {
    render(<SiteHeader />);
    const brand = screen.getByRole('link', { name: 'Cashu Fault Lab' });
    expect(brand).toHaveAttribute('href', '/');
    expect(brand.querySelector('img')).toHaveAttribute('src', '/cashu-fault-lab.png');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      '/docs/getting-started',
    );
    expect(screen.getByRole('link', { name: 'Release status' })).toHaveAttribute(
      'href',
      '/release-status',
    );
    expect(screen.queryByRole('link', { name: 'CLI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Scenarios' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Architecture' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument();
  });
});

describe('checkpoint shell compatibility', () => {
  it('keeps legacy routes readable while dark route states opt into Ink', () => {
    const mainRule = globalsCss.match(/^main\s*\{([\s\S]*?)^\}/m)?.[1];

    expect(mainRule).toContain('background: var(--sand-100);');
    expect(mainRule).toContain('color: var(--purple-950);');
    expect(globalsCss).toContain("main:has([data-shell-surface='dark'])");

    render(<NotFound />);
    expect(
      screen.getByRole('heading', { name: 'Page not found.' }).closest('section'),
    ).toHaveAttribute('data-shell-surface', 'dark');
  });

  it('does not clip page-level focus outlines behind legacy bleed rules', () => {
    expect(homeCss).not.toMatch(/\.home\s*\{[^}]*(?:margin:\s*-|overflow:\s*hidden)/s);
    expect(contentPagesCss).not.toMatch(
      /\.contentPage\s*\{[^}]*(?:margin:\s*-|overflow:\s*hidden)/s,
    );
  });
});
