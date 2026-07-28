import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocsShell } from "../../../components/docs/docs-shell";
import { getAllDocuments, getDocument } from "../../../lib/markdown";

export const dynamicParams = false;

interface DocsPageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  const documents = await getAllDocuments();
  return documents.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: DocsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const document = await getDocument(slug);

  if (!document) {
    return {};
  }

  return {
    title: document.title,
    description: document.description,
  };
}

export default async function DocumentPage({ params }: DocsPageProps) {
  const { slug } = await params;
  const [document, documents] = await Promise.all([getDocument(slug), getAllDocuments()]);

  if (!document) {
    notFound();
  }

  return <DocsShell document={document} documents={documents} />;
}
