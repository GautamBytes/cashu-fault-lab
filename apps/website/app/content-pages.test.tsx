import { render, screen, within } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ArchitecturePage from './architecture/page';
import ReleaseStatusPage from './release-status/page';
import ScenariosPage from './scenarios/page';

describe('generated content pages', () => {
  it('renders every repository scenario with an exact run command and source link', async () => {
    render(await ScenariosPage());

    expect(screen.getAllByRole('article')).toHaveLength(32);
    const responseLost = screen.getByRole('article', { name: 'http-response-lost' });
    expect(
      within(responseLost).getByText('pnpm lab run retry/response-lost --seed demo'),
    ).toBeInTheDocument();
    expect(within(responseLost).getByRole('link', { name: 'View source' })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/scenarios/retry/response-lost.json',
    );
  });

  it('presents the evidence architecture as a semantic six-stage flow', () => {
    render(<ArchitecturePage />);

    expect(screen.getByRole('list', { name: 'Evidence architecture flow' }).children).toHaveLength(
      6,
    );
    expect(screen.getByText('Durable sender')).toBeInTheDocument();
    expect(screen.getByText('HTTP/Nostr faults')).toBeInTheDocument();
    expect(screen.getByText('Durable receiver')).toBeInTheDocument();
    expect(screen.getByText('Independent oracle')).toBeInTheDocument();
    expect(screen.getByText('JSON/JUnit/HTML evidence')).toBeInTheDocument();
  });

  it('shows the blocked gate and links to every governing release source', async () => {
    render(await ReleaseStatusPage());

    expect(screen.getAllByText('0 of 2', { selector: 'strong' })).toHaveLength(2);
    expect(screen.getByText('A failing strict gate is a safety feature.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      '/docs/release-notes',
    );
    expect(screen.getByRole('link', { name: 'Release checklist' })).toHaveAttribute(
      'href',
      '/docs/release-checklist',
    );
    expect(screen.getByRole('link', { name: 'Policy source' })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/spec/release-policy.json',
    );
    expect(screen.getByRole('link', { name: 'Suite source' })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/spec/release-suite.json',
    );
  });

  it('keeps the home release section on the shared release loader', async () => {
    const source = await readFile(resolve(process.cwd(), 'app/page.tsx'), 'utf8');

    expect(source).toContain("import { getReleaseStatus } from '../lib/release-status'");
    expect(source).toContain('await Promise.all([getDemoSummary(), getReleaseStatus()])');
    expect(source).toContain('{releaseStatus.label}');
  });
});
