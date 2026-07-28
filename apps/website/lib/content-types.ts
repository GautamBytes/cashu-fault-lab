export interface DocumentDefinition {
  slug: string;
  sourcePath: string;
  title: string;
  description: string;
  group: "Start" | "Operate" | "Integrate" | "Understand" | "Release";
  order: number;
}

export interface DocumentHeading {
  id: string;
  text: string;
  depth: 2 | 3;
}

export interface DocumentPage extends DocumentDefinition {
  markdown: string;
  headings: DocumentHeading[];
  viewUrl: string;
  editUrl: string;
  previous?: Pick<DocumentDefinition, "slug" | "title">;
  next?: Pick<DocumentDefinition, "slug" | "title">;
}

export interface SearchRecord {
  id: string;
  title: string;
  description: string;
  href: string;
  text: string;
}
