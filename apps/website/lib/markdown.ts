import { readFile } from 'node:fs/promises';
import GithubSlugger from 'github-slugger';
import {
  getDocumentationDestinations,
  getDocumentationNeighbors,
  isMarkdownDestination,
} from './content-registry';
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
  return getDocumentationDestinations().filter(isMarkdownDestination);
}

async function loadDocument(definition: DocumentDefinition): Promise<DocumentPage> {
  const markdown = await readFile(resolveRepositoryPath(definition.sourcePath), 'utf8');
  return {
    ...definition,
    ...getDocumentationNeighbors(definition.slug),
    markdown,
    headings: extractHeadings(markdown),
    viewUrl: sourceUrl(definition.sourcePath, 'view'),
  };
}

export async function getAllDocuments(): Promise<DocumentPage[]> {
  const definitions = sortedRegistry();
  return Promise.all(definitions.map((definition) => loadDocument(definition)));
}

export async function getDocument(slug: string): Promise<DocumentPage | undefined> {
  const documents = await getAllDocuments();
  return documents.find((document) => document.slug === slug);
}

export async function getSearchRecords(): Promise<SearchRecord[]> {
  const documents = await getAllDocuments();
  const documentsBySlug = new Map(documents.map((document) => [document.slug, document]));

  return getDocumentationDestinations().flatMap((destination) => {
    if (destination.kind === 'generated') {
      return [
        {
          id: destination.slug,
          title: destination.title,
          description: destination.description,
          href: destination.href,
          text: destination.searchText,
        },
        ...destination.headings.map((heading) => ({
          id: `${destination.slug}#${heading.id}`,
          title: heading.text,
          description: destination.title,
          href: `${destination.href}#${heading.id}`,
          text: heading.searchText,
        })),
      ];
    }

    const document = documentsBySlug.get(destination.slug);
    if (!document) return [];

    return [
      {
        id: document.slug,
        title: document.title,
        description: document.description,
        href: document.href,
        text: searchableText(document.markdown),
      },
      ...extractHeadingSections(document.markdown).map((heading) => ({
        id: `${document.slug}#${heading.id}`,
        title: heading.text,
        description: document.title,
        href: `${document.href}#${heading.id}`,
        text: heading.searchableText,
      })),
    ];
  });
}
