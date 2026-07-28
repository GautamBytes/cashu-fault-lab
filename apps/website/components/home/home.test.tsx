import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from '../../app/page';
import { getDemoSummary } from '../../lib/demo';
import { getScenarioGroups } from '../../lib/scenarios';
import { EvidenceReport } from './evidence-report';

function homePath(fileName: string): string {
  return resolve(process.cwd(), 'components/home', fileName);
}

function cssRules(source: string, className: string): string[] {
  const rules = [...source.matchAll(new RegExp(`\\.${className}\\s*{([^}]*)}`, 'g'))].map(
    (match) => match[1] ?? '',
  );
  if (rules.length === 0) throw new Error(`Expected .${className} CSS rule`);
  return rules;
}

function stubMotionPreference() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: vi.fn(),
      matches: false,
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('home components', () => {
  it('keeps GitHub in the hero and promotes scenario discovery', async () => {
    stubMotionPreference();
    const groups = await getScenarioGroups();
    const expectedScenarioCount = groups.reduce(
      (total, group) => total + group.scenarios.length,
      0,
    );
    render(await HomePage());

    const hero = screen.getByRole('region', { name: 'Make Cashu delivery fail safely.' });
    expect(within(hero).getByRole('link', { name: /View on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab',
    );
    expect(screen.getByRole('heading', { name: 'Explore fault scenarios' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Explore all scenarios' })).toHaveAttribute(
      'href',
      '/scenarios',
    );

    const explorer = screen.getByRole('region', { name: 'Explore fault scenarios' });
    expect(within(explorer).getAllByRole('listitem')).toHaveLength(4);
    expect(within(explorer).getByText(String(expectedScenarioCount))).toBeVisible();
  });

  it('renders canonical artifact data without a second staged trace', async () => {
    stubMotionPreference();
    const summary = await getDemoSummary();
    render(await HomePage());

    const hero = screen.getByRole('region', { name: 'Make Cashu delivery fail safely.' });
    const runPanel = screen.getByRole('complementary', { name: 'Deterministic demo run' });
    const panelHeader = runPanel.querySelector('header');
    const facts = runPanel.querySelector('dl');

    if (!panelHeader) throw new Error('Expected artifact panel header');
    expect(runPanel).toHaveTextContent('Reviewed deterministic artifact');
    expect(runPanel).toHaveTextContent('Checked in');
    expect(runPanel).toHaveTextContent('Artifact');
    expect(runPanel).not.toHaveTextContent(/\blive\b/i);
    expect(panelHeader).not.toHaveTextContent('v0.1.0');
    expect(within(runPanel).queryByRole('list')).not.toBeInTheDocument();
    expect(within(hero).queryByText(/^TRACE \//)).not.toBeInTheDocument();

    if (!facts) throw new Error('Expected semantic demo facts');
    expect(within(facts).getByText(summary.scenarioId)).toBeVisible();
    expect(within(facts).getByText(summary.seed)).toBeVisible();
    expect(within(facts).getByText(String(summary.commandCount))).toBeVisible();
    expect(within(facts).getByText(String(summary.invariantCount))).toBeVisible();
    expect(within(facts).getByText(new RegExp(summary.status, 'i'))).toBeVisible();
  });

  it('keeps full-width home bands on the dark surface baseline', async () => {
    const css = await readFile(homePath('home.module.css'), 'utf8');

    for (const className of ['profileSection', 'boundarySection', 'contributeSection']) {
      expect(
        cssRules(css, className).some((rule) =>
          /background:\s*var\(--(?:ink|control-surface|elevated-surface)\)/.test(rule),
        ),
      ).toBe(true);
    }
  });

  it('uses explicit CSS module classes for every rendered state', async () => {
    const [timeline, report] = await Promise.all([
      readFile(homePath('fault-timeline.tsx'), 'utf8'),
      readFile(homePath('evidence-report.tsx'), 'utf8'),
    ]);

    expect(timeline).not.toContain('styles[stage.kind]');
    expect(report).not.toMatch(/styles\[(?:status|summary\.status)/);
  });

  it('gives standalone text links a 44 by 44 pixel minimum target', async () => {
    const css = await readFile(homePath('home.module.css'), 'utf8');
    const textLinkRule = css.match(/\.textLink\s*{([^}]*)}/)?.[1];

    expect(textLinkRule).toMatch(/min-height:\s*(?:44px|2\.75rem)/);
    expect(textLinkRule).toMatch(/min-width:\s*(?:44px|2\.75rem)/);
  });

  it('lists every reviewed invariant with its current evidence state', async () => {
    const summary = await getDemoSummary();
    render(<EvidenceReport summary={summary} />);

    const overview = screen.getByRole('group', { name: 'Reviewed evidence summary' });
    const list = screen.getByRole('list', { name: 'Invariant evidence states' });
    const items = within(list).getAllByRole('listitem');

    expect(within(overview).getByText(summary.scenarioId)).toBeVisible();
    expect(within(overview).getByText(new RegExp(`Run ${summary.status}`, 'i'))).toBeVisible();
    expect(list).toBeVisible();
    expect(screen.getByText('18', { selector: 'dd, strong' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Inspect the reviewed artifact/ })).toBeVisible();
    expect(items).toHaveLength(18);
    expect(within(list).getByText('at-most-once-redemption-start')).toBeVisible();
    expect(within(list).getAllByText('Not observable').length).toBeGreaterThan(0);
    expect(within(list).getByText('no-unsupported-pass')).toBeVisible();
  });
});
