import type { ReactNode } from 'react';
import type {
  DocumentationDestination,
  DocumentationPage,
  DocumentHeading,
} from '../../lib/content-types';
import { MarkdownDocument } from './markdown-document';
import styles from './docs.module.css';

function DocumentationNavigation({
  document,
  destinations,
}: {
  document: DocumentationPage;
  destinations: readonly DocumentationDestination[];
}) {
  const groups = [...new Set(destinations.map((destination) => destination.group))];

  return (
    <nav aria-label="Documentation">
      {groups.map((group) => {
        const groupDocuments = destinations.filter((item) => item.group === group);
        if (groupDocuments.length === 0) return null;

        return (
          <section className={styles.navigationGroup} key={group}>
            <h2>{group}</h2>
            <ul>
              {groupDocuments.map((item) => (
                <li key={item.slug}>
                  <a
                    aria-current={item.href === document.href ? 'page' : undefined}
                    href={item.href}
                  >
                    {item.title}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

function TableOfContents({
  className,
  headings,
}: {
  className: string;
  headings: readonly DocumentHeading[];
}) {
  if (headings.length === 0) {
    return null;
  }

  return (
    <nav aria-label="On this page" className={className}>
      <p>On this page</p>
      <ol>
        {headings.map((heading) => (
          <li className={heading.depth === 3 ? styles.nestedHeading : undefined} key={heading.id}>
            <a href={`#${heading.id}`}>{heading.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function DocsShell({
  children,
  document,
  destinations,
}: {
  children?: ReactNode;
  document: DocumentationPage;
  destinations: readonly DocumentationDestination[];
}) {
  const isGenerated = document.kind === 'generated';

  return (
    <div className={styles.docsShell}>
      <aside className={styles.sidebar}>
        <DocumentationNavigation destinations={destinations} document={document} />
      </aside>

      <details className={styles.mobileDocsNav}>
        <summary>Browse documentation</summary>
        <DocumentationNavigation destinations={destinations} document={document} />
      </details>

      <article className={`${styles.article} ${isGenerated ? styles.generatedArticle : ''}`}>
        {!isGenerated ? (
          <header className={styles.articleHeader}>
            <p className={styles.eyebrow}>{document.group}</p>
            <h1>{document.title}</h1>
            <p className={styles.description}>{document.description}</p>
            <div className={styles.sourceActions}>
              <a href={document.viewUrl} rel="noreferrer noopener" target="_blank">
                View source
              </a>
              <a href={document.editUrl} rel="noreferrer noopener" target="_blank">
                Edit on GitHub
              </a>
            </div>
          </header>
        ) : null}

        <TableOfContents className={styles.mobileToc!} headings={document.headings} />
        {isGenerated ? (
          children
        ) : (
          <MarkdownDocument markdown={document.markdown} sourcePath={document.sourcePath} />
        )}

        <nav aria-label="Document pagination" className={styles.pagination}>
          {document.previous ? (
            <a href={document.previous.href}>
              <span>Previous</span>
              {document.previous.title}
            </a>
          ) : (
            <span />
          )}
          {document.next ? (
            <a href={document.next.href}>
              <span>Next</span>
              {document.next.title}
            </a>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className={styles.toc}>
        <TableOfContents className={styles.desktopToc!} headings={document.headings} />
      </aside>
    </div>
  );
}
