import { describe, expect, it } from 'vitest';
import { CONTENT_REGISTRY, validateContentRegistry } from './content-registry';
import { extractHeadings, getAllDocuments, getDocument, getSearchRecords } from './markdown';
import { resolveRepositoryPath, sourceUrl } from './repository';

describe('canonical content', () => {
  it('uses unique routes and existing canonical sources', async () => {
    expect(new Set(CONTENT_REGISTRY.map((item) => item.slug)).size).toBe(CONTENT_REGISTRY.length);
    await expect(validateContentRegistry()).resolves.toEqual([]);
  });

  it('deduplicates GitHub-style heading slugs outside code fences', () => {
    expect(extractHeadings('## Retry\n```md\n## ignored\n```\n## Retry\n### NUT-19')).toEqual([
      { depth: 2, id: 'retry', text: 'Retry' },
      { depth: 2, id: 'retry-1', text: 'Retry' },
      { depth: 3, id: 'nut-19', text: 'NUT-19' },
    ]);
  });

  it('keeps headings hidden after a backtick fence marker with trailing text', () => {
    expect(
      extractHeadings('```md\n```` not a closing fence\n## hidden\n```   \n## visible'),
    ).toEqual([{ depth: 2, id: 'visible', text: 'visible' }]);
  });

  it('keeps headings hidden after a tilde fence marker with trailing text', () => {
    expect(
      extractHeadings('~~~md\n~~~~ not a closing fence\n## hidden\n~~~\t\n## visible'),
    ).toEqual([{ depth: 2, id: 'visible', text: 'visible' }]);
  });

  it('removes Markdown decoration when extracting heading text', () => {
    expect(extractHeadings('## [Exact *retry*](#retry) with `payload` ###')).toEqual([
      { depth: 2, id: 'exact-retry-with-payload', text: 'Exact retry with payload' },
    ]);
  });

  it('rejects paths outside the repository', () => {
    expect(() => resolveRepositoryPath('../secret.env')).toThrow(
      'Repository content path escapes the project root',
    );
  });

  it('generates GitHub source URLs for viewing and editing', () => {
    expect(sourceUrl('README.md', 'view')).toBe(
      'https://github.com/GautamBytes/cashu-fault-lab/blob/main/README.md',
    );
    expect(sourceUrl('docs/cli-reference.md', 'edit')).toBe(
      'https://github.com/GautamBytes/cashu-fault-lab/edit/main/docs/cli-reference.md',
    );
  });

  it('loads documents in registry order with source actions and adjacent navigation', async () => {
    const documents = await getAllDocuments();

    expect(documents).toHaveLength(CONTENT_REGISTRY.length);
    expect(documents.map((document) => document.slug)).toEqual(
      [...CONTENT_REGISTRY]
        .sort((left, right) => left.order - right.order)
        .map((document) => document.slug),
    );
    expect(documents[0]).toMatchObject({
      slug: 'getting-started',
      previous: undefined,
      next: { slug: 'cli' },
      viewUrl: 'https://github.com/GautamBytes/cashu-fault-lab/blob/main/README.md',
      editUrl: 'https://github.com/GautamBytes/cashu-fault-lab/edit/main/README.md',
    });
  });

  it('returns undefined for an unregistered document', async () => {
    await expect(getDocument('not-a-document')).resolves.toBeUndefined();
  });

  it('creates document and heading search records from escaped text', async () => {
    const documents = await getAllDocuments();
    const records = await getSearchRecords();
    const readme = documents.find((document) => document.slug === 'getting-started');

    expect(records.filter((record) => record.id === 'getting-started')).toEqual([
      expect.objectContaining({ href: '/docs/getting-started', title: 'Getting started' }),
    ]);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'getting-started#requirements',
          href: '/docs/getting-started#requirements',
          title: 'Requirements',
        }),
      ]),
    );
    expect(readme).toBeDefined();
    expect(records.find((record) => record.id === 'getting-started')?.text).not.toContain('<');
  });
});
