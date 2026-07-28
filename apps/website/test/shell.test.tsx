import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteHeader } from '../components/site-header';

const globalsCss = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
const homeCss = readFileSync(resolve(process.cwd(), 'components/home/home.module.css'), 'utf8');
const docsCss = readFileSync(resolve(process.cwd(), 'components/docs/docs.module.css'), 'utf8');
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

describe('dark shell contract', () => {
  it('gives main and every current route root a readable dark baseline', () => {
    const mainRule = globalsCss.match(/^main\s*\{([\s\S]*?)^\}/m)?.[1];
    const homeRule = homeCss.match(/^\.home\s*\{([\s\S]*?)^\}/m)?.[1];
    const docsRule = docsCss.match(/^\.docsShell\s*\{([\s\S]*?)^\}/m)?.[1];
    const contentPageRule = contentPagesCss.match(/^\.contentPage\s*\{([\s\S]*?)^\}/m)?.[1];

    expect(mainRule).toContain('background: var(--ink);');
    expect(mainRule).toContain('color: var(--sand-100);');
    expect(homeRule).toContain('color: var(--sand-100);');
    expect(docsRule).toContain('color: var(--sand-100);');
    expect(contentPageRule).toContain('color: var(--sand-100);');
  });

  it('does not clip page-level focus outlines behind legacy bleed rules', () => {
    expect(homeCss).not.toMatch(/\.home\s*\{[^}]*(?:margin:\s*-|overflow:\s*hidden)/s);
    expect(contentPagesCss).not.toMatch(
      /\.contentPage\s*\{[^}]*(?:margin:\s*-|overflow:\s*hidden)/s,
    );
  });

  it('keeps mobile TOC hover and focus text readable on Sand', () => {
    const interactionRules = [
      ...docsCss.matchAll(
        /^\.mobileToc a:hover,\s*\n\.mobileToc a:focus-visible\s*\{([\s\S]*?)^\}/gm,
      ),
    ];
    const winningRule = interactionRules.at(-1)?.[1];

    expect(winningRule).toContain('color: var(--purple-950);');
  });
});
