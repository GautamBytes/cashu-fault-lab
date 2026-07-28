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

  it('preserves the delivery branches, oracle convergence, and evidence output in the DOM', () => {
    render(<ArchitecturePage />);

    const deliveryPath = screen.getByRole('list', { name: 'Primary delivery path' });
    expect(within(deliveryPath).getAllByRole('listitem')).toHaveLength(3);
    expect(within(deliveryPath).getByText('Durable sender')).toBeInTheDocument();
    expect(within(deliveryPath).getByText('HTTP/Nostr faults')).toBeInTheDocument();
    expect(within(deliveryPath).getByText('Durable receiver')).toBeInTheDocument();

    const branches = screen.getByRole('list', {
      name: 'Evidence branches converging at independent oracle',
    });
    expect(within(branches).getAllByRole('listitem')).toHaveLength(2);
    expect(within(branches).getByText('Exact payload')).toBeInTheDocument();
    expect(within(branches).getByText('Mint recovery')).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Exact payload' })).toHaveAttribute(
      'aria-describedby',
      'sender-title',
    );
    expect(screen.getByRole('article', { name: 'Mint recovery' })).toHaveAttribute(
      'aria-describedby',
      'receiver-title',
    );

    expect(screen.getByRole('article', { name: 'Independent oracle' })).toHaveAttribute(
      'aria-describedby',
      'exact-payload-title mint-recovery-title',
    );
    expect(screen.getByRole('article', { name: 'JSON/JUnit/HTML evidence' })).toHaveAttribute(
      'aria-describedby',
      'oracle-title',
    );
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
