import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getDemoSummary } from '../../lib/demo';
import { EvidenceReport } from './evidence-report';

function homePath(fileName: string): string {
  return resolve(process.cwd(), 'components/home', fileName);
}

describe('home components', () => {
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

    const list = screen.getByRole('list', { name: 'Invariant evidence states' });
    const items = within(list).getAllByRole('listitem');

    expect(items).toHaveLength(18);
    expect(within(list).getByText('at-most-once-redemption-start')).toBeVisible();
    expect(within(list).getAllByText('Not observable').length).toBeGreaterThan(0);
    expect(within(list).getByText('no-unsupported-pass')).toBeVisible();
  });
});
