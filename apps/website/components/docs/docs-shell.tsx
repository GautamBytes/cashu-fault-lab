import type { DocumentHeading, DocumentPage } from "../../lib/content-types";
import { MarkdownDocument } from "./markdown-document";
import styles from "./docs.module.css";

const groups: DocumentPage["group"][] = ["Start", "Operate", "Integrate", "Understand", "Release"];

function TableOfContents({
  className,
  headings,
}: {
  className: string;
  headings: DocumentHeading[];
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
  document,
  documents,
}: {
  document: DocumentPage;
  documents: DocumentPage[];
}) {
  return (
    <div className={styles.docsShell}>
      <aside className={styles.sidebar}>
        <nav aria-label="Documentation">
          {groups.map((group) => {
            const groupDocuments = documents.filter((item) => item.group === group);
            if (groupDocuments.length === 0) return null;

            return (
              <section className={styles.navigationGroup} key={group}>
                <h2>{group}</h2>
                <ul>
                  {groupDocuments.map((item) => (
                    <li key={item.slug}>
                      <a
                        aria-current={item.slug === document.slug ? "page" : undefined}
                        href={`/docs/${item.slug}`}
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
      </aside>

      <article className={styles.article}>
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

        <TableOfContents className={styles.mobileToc} headings={document.headings} />
        <MarkdownDocument markdown={document.markdown} />

        <nav aria-label="Document pagination" className={styles.pagination}>
          {document.previous ? (
            <a href={`/docs/${document.previous.slug}`}>
              <span>Previous</span>
              {document.previous.title}
            </a>
          ) : (
            <span />
          )}
          {document.next ? (
            <a href={`/docs/${document.next.slug}`}>
              <span>Next</span>
              {document.next.title}
            </a>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className={styles.toc}>
        <TableOfContents className={styles.desktopToc} headings={document.headings} />
      </aside>
    </div>
  );
}
