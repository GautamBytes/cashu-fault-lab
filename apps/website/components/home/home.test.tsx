import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function cssHexToken(source: string, token: string): string {
  const value = source.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
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
    expect(within(hero).queryByText('Experimental developer preview')).not.toBeInTheDocument();
    expect(
      within(hero).getByText('Cashu delivery fault injection and recovery evidence'),
    ).toBeVisible();
    expect(within(hero).getByRole('link', { name: 'Open in Codespaces' })).toHaveAttribute(
      'href',
      'https://codespaces.new/GautamBytes/cashu-fault-lab?quickstart=1',
    );
    expect(within(hero).getByText('npx cashu-fault-lab demo')).toBeVisible();
    expect(within(hero).getByRole('link', { name: /View on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab',
    );
    expect(
      within(hero).getByRole('link', { name: 'Next / deterministic fault trace' }),
    ).toHaveAttribute('href', '#fault-trace');
    expect(screen.getByRole('heading', { name: 'Explore fault scenarios' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Explore all scenarios' })).toHaveAttribute(
      'href',
      '/scenarios',
    );
    expect(screen.getByRole('link', { name: 'Read the contribution guide' })).toHaveAttribute(
      'href',
      '/docs/contributing',
    );

    const explorer = screen.getByRole('region', { name: 'Explore fault scenarios' });
    expect(within(explorer).getAllByRole('listitem')).toHaveLength(4);
    expect(within(explorer).getByText(String(expectedScenarioCount))).toBeVisible();
  });

  it('copies the single-line demo command without release metadata', async () => {
    stubMotionPreference();
    const user = userEvent.setup();
    render(await HomePage());

    const command = screen.getByLabelText('Demo command');
    expect(within(command).getByText('npx cashu-fault-lab demo')).toHaveAttribute('tabindex', '0');
    expect(
      within(command).queryByText('available with v0.1.1 · isolated · secret-redacted'),
    ).not.toBeInTheDocument();

    await user.click(within(command).getByRole('button', { name: 'Copy demo command' }));

    expect(await navigator.clipboard.readText()).toBe('npx cashu-fault-lab demo');
    expect(within(command).getByText('Copied')).toBeVisible();
  });

  it('renders canonical artifact data without a second staged trace', async () => {
    stubMotionPreference();
    const summary = await getDemoSummary();
    render(await HomePage());

    const hero = screen.getByRole('region', { name: 'Make Cashu delivery fail safely.' });
    const runPanel = screen.getByRole('complementary', { name: 'Deterministic demo run' });
    const telemetry = screen.getByLabelText('Checked-in demo telemetry');
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
    expect(within(telemetry).getByText(summary.seed)).toBeVisible();
    expect(within(telemetry).getByText(summary.scenarioId)).toBeVisible();
    expect(within(telemetry).getByText(`${summary.invariantCount} invariants`)).toBeVisible();
    expect(within(telemetry).getByText(new RegExp(summary.status, 'i'))).toBeVisible();
  });

  it('connects the primary homepage story with an ordered trace spine', async () => {
    stubMotionPreference();
    render(await HomePage());

    const steps = [
      ['A lost response is not a lost result.', '01', 'Break'],
      ['Evidence, not a success boolean.', '02', 'Prove'],
      ['Explore fault scenarios', '03', 'Explore'],
    ] as const;

    for (const [heading, step, label] of steps) {
      const section = screen.getByRole('region', { name: heading });
      expect(section).toHaveAttribute('data-trace-step', step);
      expect(section).toHaveAttribute('data-trace-label', label);
    }
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

  it('removes the inner outline from the hero quickstart command', async () => {
    const css = await readFile(homePath('home.module.css'), 'utf8');
    const commandCodeRule = css.match(/\.commandBlock code\s*{([^}]*)}/)?.[1];

    expect(commandCodeRule).toMatch(/border:\s*0/);
  });

  it('keeps the hero quickstart command compact and on one line at every breakpoint', async () => {
    const css = await readFile(homePath('home.module.css'), 'utf8');
    const heroCopyRule = cssRules(css, 'heroCopy')[0];
    const commandBlockRule = cssRules(css, 'commandBlock')[0];
    const copyButtonRule = cssRules(css, 'commandCopyButton')[0];
    const commandCodeRule = css.match(/\.commandBlock code\s*{([^}]*)}/)?.[1];

    expect(heroCopyRule).toMatch(/min-width:\s*0/);
    expect(commandBlockRule).toMatch(/min-width:\s*0/);
    expect(commandBlockRule).toMatch(/max-width:\s*100%/);
    expect(commandBlockRule).toMatch(/width:\s*fit-content/);
    expect(commandCodeRule).not.toMatch(/flex:\s*1/);
    expect(commandCodeRule).toMatch(/white-space:\s*nowrap/);
    expect(copyButtonRule).not.toMatch(/margin-left:\s*auto/);
    expect(cssRules(css, 'commandBlock').every((rule) => !/flex-wrap:\s*wrap/.test(rule))).toBe(
      true,
    );
  });

  it('keeps CTA text above 4.5 to 1 across every primary gradient stop', async () => {
    const [css, globals] = await Promise.all([
      readFile(homePath('home.module.css'), 'utf8'),
      readFile(resolve(process.cwd(), 'app/globals.css'), 'utf8'),
    ]);
    const primaryActionRule = cssRules(css, 'primaryAction')[0];
    const onPurple = cssHexToken(globals, 'on-purple');

    expect(primaryActionRule).toMatch(
      /background:\s*linear-gradient\(110deg,\s*var\(--purple-700\),\s*var\(--purple-500\)\)/,
    );
    expect(primaryActionRule).toContain('color: var(--on-purple);');
    expect(primaryActionRule).not.toContain('!important');

    for (const stop of ['purple-700', 'purple-500']) {
      expect(contrastRatio(onPurple, cssHexToken(globals, stop))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps invariant status counts in one four-column strip at every breakpoint', async () => {
    const css = await readFile(homePath('home.module.css'), 'utf8');
    const statusGridRules = cssRules(css, 'statusGrid');

    expect(statusGridRules).toHaveLength(1);
    expect(statusGridRules[0]).toMatch(
      /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(css).not.toMatch(/\.statusGrid,\s*\.reportLinks\s*{[^}]*grid-template-columns:\s*1fr/s);
  });

  it('lists every reviewed invariant with its current evidence state', async () => {
    const summary = await getDemoSummary();
    render(<EvidenceReport summary={summary} />);

    const overview = screen.getByRole('group', { name: 'Reviewed evidence summary' });
    const evidence = screen.getByRole('group', { name: 'Invariant evidence states' });
    const contextList = within(evidence).getByRole('list', {
      name: 'Invariants requiring context',
    });
    const supportedList = within(evidence).getByRole('list', {
      name: 'Invariants supported by reviewed evidence',
    });
    const items = [
      ...within(contextList).getAllByRole('listitem'),
      ...within(supportedList).getAllByRole('listitem'),
    ];

    expect(within(overview).getByText(summary.scenarioId)).toBeVisible();
    expect(within(overview).getByText(new RegExp(`Run ${summary.status}`, 'i'))).toBeVisible();
    expect(contextList).toBeVisible();
    expect(supportedList).toBeVisible();
    expect(screen.getByText('18', { selector: 'dd, strong' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Inspect the reviewed artifact/ })).toBeVisible();
    expect(items).toHaveLength(18);
    expect(within(contextList).getByText('At most once redemption start')).toBeVisible();
    expect(within(contextList).getByText('at-most-once-redemption-start')).toBeVisible();
    expect(within(contextList).getAllByText('Not observable').length).toBeGreaterThan(0);
    expect(within(supportedList).getByText('No unsupported pass')).toBeVisible();
    expect(within(supportedList).getByText('no-unsupported-pass')).toBeVisible();
  });

  it('uses full-width evidence rows with readable type', async () => {
    const css = await readFile(homePath('home.module.css'), 'utf8');
    const invariantListRule = cssRules(css, 'invariantList')[0];
    const invariantItemRule = cssRules(css, 'invariantItem')[0];
    const invariantTitleRule = cssRules(css, 'invariantTitle')[0];

    expect(invariantListRule).toContain('grid-template-columns: 1fr;');
    expect(invariantItemRule).toMatch(
      /grid-template-columns:\s*2rem minmax\(15rem,\s*1\.1fr\) minmax\(12rem,\s*0\.9fr\) auto/,
    );
    expect(invariantTitleRule).toMatch(/font-size:\s*0\.9rem/);
  });
});
