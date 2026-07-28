import { readFile } from 'node:fs/promises';
import GithubSlugger from 'github-slugger';
import { CONTENT_REGISTRY } from './content-registry';
import type {
  DocumentDefinition,
  DocumentHeading,
  DocumentPage,
  SearchRecord,
} from './content-types';
import { resolveRepositoryPath, sourceUrl } from './repository';

function headingText(value: string): string {
  return value
    .replace(/\s+#+\s*$/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/[\\*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface HeadingSection extends DocumentHeading {
  searchableText: string;
}

export function extractHeadingSections(markdown: string): HeadingSection[] {
  const slugger = new GithubSlugger();
  const sections: Array<DocumentHeading & { body: string[] }> = [];
  let currentSection: (typeof sections)[number] | undefined;
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
        currentSection?.body.push(line);
        continue;
      }
      if (
        fence.marker === marker &&
        fenceMatch[1].length >= fence.length &&
        /^[ \t]*$/.test(line.slice(fenceMatch[0].length))
      ) {
        fence = undefined;
        currentSection?.body.push(line);
        continue;
      }
    }

    if (fence) {
      currentSection?.body.push(line);
      continue;
    }

    const match = line.match(/^\s{0,3}(##|###)\s+(.+?)\s*$/);
    if (!match) {
      if (/^\s{0,3}#{1,6}(?:\s+|$)/.test(line)) {
        currentSection = undefined;
      } else {
        currentSection?.body.push(line);
      }
      continue;
    }

    const text = headingText(match[2]);
    if (!text) continue;
    currentSection = {
      body: [],
      depth: match[1].length as 2 | 3,
      id: slugger.slug(text),
      text,
    };
    sections.push(currentSection);
  }

  return sections.map(({ body, ...heading }) => ({
    ...heading,
    searchableText: searchableText(body.join('\n')),
  }));
}

export function extractHeadings(markdown: string): DocumentHeading[] {
  return extractHeadingSections(markdown).map(
    ({ searchableText: _searchableText, ...heading }) => ({
      ...heading,
    }),
  );
}

function searchableText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/[>#*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sortedRegistry(): DocumentDefinition[] {
  return [...CONTENT_REGISTRY].sort((left, right) => left.order - right.order);
}

async function loadDocument(
  definition: DocumentDefinition,
  previous?: DocumentDefinition,
  next?: DocumentDefinition,
): Promise<DocumentPage> {
  const markdown = await readFile(resolveRepositoryPath(definition.sourcePath), 'utf8');
  return {
    ...definition,
    markdown,
    headings: extractHeadings(markdown),
    viewUrl: sourceUrl(definition.sourcePath, 'view'),
    editUrl: sourceUrl(definition.sourcePath, 'edit'),
    previous: previous && { slug: previous.slug, title: previous.title },
    next: next && { slug: next.slug, title: next.title },
  };
}

export async function getAllDocuments(): Promise<DocumentPage[]> {
  const definitions = sortedRegistry();
  return Promise.all(
    definitions.map((definition, index) =>
      loadDocument(definition, definitions[index - 1], definitions[index + 1]),
    ),
  );
}

export async function getDocument(slug: string): Promise<DocumentPage | undefined> {
  const documents = await getAllDocuments();
  return documents.find((document) => document.slug === slug);
}

export async function getSearchRecords(): Promise<SearchRecord[]> {
  const documents = await getAllDocuments();
  return documents.flatMap((document) => [
    {
      id: document.slug,
      title: document.title,
      description: document.description,
      href: `/docs/${document.slug}`,
      text: searchableText(document.markdown),
    },
    ...extractHeadingSections(document.markdown).map((heading) => ({
      id: `${document.slug}#${heading.id}`,
      title: heading.text,
      description: document.title,
      href: `/docs/${document.slug}#${heading.id}`,
      text: heading.searchableText,
    })),
  ]);
}
