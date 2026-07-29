export type DocumentationGroup = 'Start' | 'Operate' | 'Integrate' | 'Understand' | 'Release';

export interface DocumentationDestinationBase {
  slug: string;
  href: string;
  title: string;
  description: string;
  group: DocumentationGroup;
  order: number;
}

export interface DocumentHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface GeneratedDocumentHeading extends DocumentHeading {
  searchText: string;
}

export interface MarkdownDocumentDefinition extends DocumentationDestinationBase {
  kind: 'markdown';
  sourcePath: string;
}

export interface GeneratedDocumentDefinition extends DocumentationDestinationBase {
  kind: 'generated';
  headings: readonly GeneratedDocumentHeading[];
  searchText: string;
}

export type DocumentationDestination = MarkdownDocumentDefinition | GeneratedDocumentDefinition;
export type DocumentDefinition = MarkdownDocumentDefinition;
export type DocumentationLink = Pick<DocumentationDestinationBase, 'href' | 'slug' | 'title'>;

interface DocumentationPageNavigation {
  previous?: DocumentationLink;
  next?: DocumentationLink;
}

export interface DocumentPage extends MarkdownDocumentDefinition, DocumentationPageNavigation {
  markdown: string;
  headings: DocumentHeading[];
  viewUrl: string;
  editUrl: string;
}

export type GeneratedDocumentPage = GeneratedDocumentDefinition & DocumentationPageNavigation;
export type DocumentationPage = DocumentPage | GeneratedDocumentPage;

export interface SearchRecord {
  id: string;
  title: string;
  description: string;
  href: string;
  text: string;
}
