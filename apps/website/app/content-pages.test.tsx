import { render, screen, within } from '@testing-library/react';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ArchitecturePage from './architecture/page';
import ReleaseStatusPage from './release-status/page';
import ScenariosPage from './scenarios/page';
import { DocsShell } from '../components/docs/docs-shell';
import { getDocumentationDestinations } from '../lib/content-registry';
import { getDocument } from '../lib/markdown';

vi.mock('../components/docs/markdown-document', () => ({
  MarkdownDocument: () => null,
}));

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

  it('renders Architecture in the docs shell with its generated topology and current state', async () => {
    render(await ArchitecturePage());

    const documentationNavigation = screen.getAllByRole('navigation', {
      name: 'Documentation',
    })[0];
    if (!documentationNavigation) throw new Error('Expected documentation navigation');
    const architectureLink = within(documentationNavigation).getByRole('link', {
      name: 'Architecture',
    });
    const architectureArticle = screen
      .getByRole('heading', { level: 1, name: 'Faults travel. Trust does not.' })
      .closest('article');

    expect(architectureLink).toHaveAttribute('href', '/architecture');
    expect(architectureLink).toHaveAttribute('aria-current', 'page');
    expect(architectureArticle).not.toBeNull();

    const deliveryPath = screen.getByRole('list', { name: 'Primary delivery path' });
    expect(architectureArticle).toContainElement(deliveryPath);
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

  it('orders Architecture after Adapters and includes it in document pagination', async () => {
    const document = await getDocument('adapters');
    if (!document) throw new Error('Expected adapters document');

    render(<DocsShell destinations={getDocumentationDestinations()} document={document} />);

    const documentationNavigation = screen.getAllByRole('navigation', {
      name: 'Documentation',
    })[0];
    if (!documentationNavigation) throw new Error('Expected documentation navigation');

    const links = within(documentationNavigation).getAllByRole('link');
    const adaptersIndex = links.findIndex((link) => link.textContent === 'Adapter guide');
    const architectureIndex = links.findIndex((link) => link.textContent === 'Architecture');

    expect(architectureIndex).toBe(adaptersIndex + 1);
    const architectureLink = links[architectureIndex];
    if (!architectureLink) throw new Error('Expected Architecture navigation link');
    expect(architectureLink).toHaveAttribute('href', '/architecture');
    expect(
      within(screen.getByRole('navigation', { name: 'Document pagination' })).getByRole('link', {
        name: /Next\s*Architecture/,
      }),
    ).toHaveAttribute('href', '/architecture');
  });

  it('keeps public docs sourced from GitHub and links contributors to the canonical file', async () => {
    const document = await getDocument('getting-started');
    if (!document) throw new Error('Expected getting started document');

    render(<DocsShell destinations={getDocumentationDestinations()} document={document} />);

    expect(screen.getByRole('link', { name: 'View source' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Edit on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/GautamBytes/cashu-fault-lab/edit/main/README.md',
    );
    expect(
      screen.getAllByRole('link', { name: 'Contribution guide' }).some((link) => {
        return link.getAttribute('href') === '/docs/contributing';
      }),
    ).toBe(true);
  });

  it('derives documentation group order from the ordered destination source', async () => {
    const document = await getDocument('getting-started');
    if (!document) throw new Error('Expected getting started document');

    const destinations = getDocumentationDestinations();
    const releaseNotes = destinations.find((item) => item.slug === 'release-notes');
    if (!releaseNotes) throw new Error('Expected release notes destination');

    render(
      <DocsShell
        destinations={[
          releaseNotes,
          ...destinations.filter((item) => item.slug !== releaseNotes.slug),
        ]}
        document={document}
      />,
    );

    const documentationNavigation = screen.getAllByRole('navigation', {
      name: 'Documentation',
    })[0];
    if (!documentationNavigation) throw new Error('Expected documentation navigation');
    expect(
      within(documentationNavigation)
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Release', 'Start', 'Operate', 'Integrate', 'Understand']);
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
    expect(source).toContain("import { getScenarioGroups } from '../lib/scenarios'");
    expect(source).toMatch(
      /await Promise\.all\(\[\s*getDemoSummary\(\),\s*getReleaseStatus\(\),\s*getScenarioGroups\(\),\s*\]\)/,
    );
    expect(source).toContain('{releaseStatus.label}');
  });
});
