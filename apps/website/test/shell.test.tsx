import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PortalShell } from '../components/portal-shell';
import { SiteHeader } from '../components/site-header';

const globalsCss = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
const homeCss = readFileSync(resolve(process.cwd(), 'components/home/home.module.css'), 'utf8');
const docsCss = readFileSync(resolve(process.cwd(), 'components/docs/docs.module.css'), 'utf8');
const headerCss = readFileSync(resolve(process.cwd(), 'components/site-header.module.css'), 'utf8');
const contentPagesCss = readFileSync(
  resolve(process.cwd(), 'app/content-pages.module.css'),
  'utf8',
);
const searchCss = readFileSync(
  resolve(process.cwd(), 'components/search/search.module.css'),
  'utf8',
);
const notFoundCss = readFileSync(resolve(process.cwd(), 'app/not-found.module.css'), 'utf8');

function cssHexToken(token: string): string {
  const value = globalsCss.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  if (!value) throw new Error(`Expected --${token} hex token`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid hex color: ${hex}`);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(left: string, right: string): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

describe('SiteHeader', () => {
  it('exposes direct entry points and an Explore disclosure', async () => {
    const user = userEvent.setup();
    render(<SiteHeader currentPath="/" />);
    const brand = screen.getByRole('link', { name: 'Cashu Fault Lab' });
    expect(brand).toHaveAttribute('href', '/');
    expect(brand.querySelector('img')).toHaveAttribute('src', '/cashu-fault-lab.png');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      '/docs/getting-started',
    );
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    const explore = screen.getByText('Explore').closest('summary');
    expect(explore).toBeVisible();
    if (!explore) throw new Error('Expected Explore disclosure');
    expect(explore).not.toHaveAttribute('aria-current');
    expect(explore.closest('details')).not.toHaveAttribute('open');
    await user.click(explore);
    expect(screen.getByRole('link', { name: 'Scenarios' })).toHaveAttribute('href', '/scenarios');
    expect(screen.getByRole('link', { name: 'Architecture' })).toHaveAttribute(
      'href',
      '/architecture',
    );
    expect(screen.getByRole('link', { name: 'Evidence' })).toHaveAttribute(
      'href',
      '/#verified-run',
    );
    expect(screen.getByRole('link', { name: 'Release status' })).toHaveAttribute(
      'href',
      '/release-status',
    );
    expect(screen.queryByRole('link', { name: 'CLI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'GitHub' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle color theme' })).toBeVisible();
  });

  it('marks an Explore destination and its parent as current', () => {
    render(<SiteHeader currentPath="/architecture" />);

    expect(screen.getByRole('link', { name: 'Architecture' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const explore = screen.getByText('Explore').closest('summary');
    expect(explore).toHaveAttribute('aria-current', 'page');
    expect(explore?.closest('details')).not.toHaveAttribute('open');
  });

  it('spaces primary navigation labels consistently', () => {
    expect(headerCss).toMatch(/\.links\s*\{[^}]*column-gap:\s*1\.25rem/s);
    expect(headerCss).toMatch(/\.links a\s*\{[^}]*min-width:\s*auto;[^}]*padding:\s*0 0\.25rem/s);
  });

  it('composes Search from a visual icon, desktop label, and shortcut hint', () => {
    render(<SiteHeader />);
    const search = screen.getByRole('button', { name: 'Search documentation' });
    const icon = search.querySelector('[aria-hidden="true"]');

    expect(icon).toBeEmptyDOMElement();
    expect(icon?.className).toContain('searchIcon');
    expect(within(search).getByText('Search').className).toContain('searchLabel');
    expect(within(search).getByText('⌘K').tagName).toBe('KBD');
    expect(headerCss).toMatch(
      /@media \(max-width: 1040px\)[\s\S]*\.searchLabel,\s*\.searchHint\s*\{[^}]*clip-path:\s*inset\(50%\)/,
    );
  });
});

describe('site footer', () => {
  it('keeps the maintainer profiles at the bottom right', () => {
    render(
      <PortalShell records={[]}>
        <div>Page content</div>
      </PortalShell>,
    );

    const footer = screen.getByRole('contentinfo');
    const profiles = within(footer).getByRole('navigation', {
      name: 'Gautam Manchandani profiles',
    });
    expect(within(profiles).getByText('Reach out')).toBeVisible();
    const links = [
      ['X', 'https://x.com/GautamM96'],
      ['LinkedIn', 'https://www.linkedin.com/in/gautam-manchandani/'],
      ['GitHub', 'https://github.com/GautamBytes'],
    ] as const;

    for (const [name, href] of links) {
      expect(within(profiles).getByRole('link', { name })).toHaveAttribute('href', href);
      expect(within(profiles).getByRole('link', { name })).toHaveAttribute('target', '_blank');
      expect(within(profiles).getByRole('link', { name })).toHaveAttribute(
        'rel',
        'noreferrer noopener',
      );
    }

    expect(globalsCss).toMatch(
      /\.footer-inner\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between/s,
    );
  });
});

describe('dark shell contract', () => {
  it('defines a complete light Cashu theme without changing layout tokens', () => {
    expect(globalsCss).toMatch(
      /html\[data-theme='light'\]\s*\{[^}]*--ink:\s*#f7f8fc;[^}]*--control-surface:\s*#eef0f6;[^}]*--sand-100:\s*#211527;[^}]*--success:\s*var\(--sand-500\);[^}]*color-scheme:\s*light/s,
    );
  });

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

  it('keeps mobile TOC hover and focus text readable on Elevated', () => {
    const interactionRules = [
      ...docsCss.matchAll(
        /^\.mobileToc a:hover,\s*\n\.mobileToc a:focus-visible\s*\{([\s\S]*?)^\}/gm,
      ),
    ];
    const winningRule = interactionRules.at(-1)?.[1];

    expect(winningRule).toContain('background: var(--elevated-surface);');
    expect(winningRule).toContain('color: var(--sand-100);');
  });

  it('uses a contrast-safe Warm sand ring on every dark or plum focus surface', () => {
    const focusSources = [globalsCss, homeCss, docsCss, contentPagesCss, searchCss, notFoundCss];
    const warmSand = cssHexToken('sand-500');

    expect(globalsCss).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--sand-500\)/s);
    for (const source of focusSources) {
      expect(source).not.toMatch(/outline:[^;]*var\(--purple-(?:500|700|electric)\)/);
    }
    for (const surface of [
      'ink',
      'control-surface',
      'elevated-surface',
      'purple-950',
      'purple-700',
      'purple-500',
    ]) {
      expect(contrastRatio(warmSand, cssHexToken(surface))).toBeGreaterThanOrEqual(3);
    }
  });
});
