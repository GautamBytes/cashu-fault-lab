import type { ComponentPropsWithoutRef } from "react";
import { MarkdownAsync as ReactMarkdown } from "react-markdown";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { getSingletonHighlighter } from "shiki";
import { createCssVariablesTheme } from "shiki/core";
import type { BundledHighlighterOptions } from "shiki/types";
import { CONTENT_REGISTRY } from "../../lib/content-registry";
import { sourceUrl } from "../../lib/repository";
import { CodeBlock } from "./code-block";
import styles from "./docs.module.css";

const cssVariablesTheme = createCssVariablesTheme();

async function getCssVariablesHighlighter(options: BundledHighlighterOptions<string, string>) {
  return getSingletonHighlighter({
    ...options,
    themes: [cssVariablesTheme],
  });
}

function decodedRepositoryPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function resolveMarkdownHref(href: string, sourcePath: string): string {
  if (
    href.length === 0 ||
    href.startsWith("#") ||
    href.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(href)
  ) {
    return href;
  }

  const source = new URL(encodeURI(sourcePath), "https://repository.invalid/");
  const resolved = new URL(href, source);
  const repositoryPath = decodedRepositoryPath(resolved.pathname.slice(1));
  const document = CONTENT_REGISTRY.find((item) => item.sourcePath === repositoryPath);
  const suffix = `${resolved.search}${resolved.hash}`;

  if (document) {
    return `/docs/${document.slug}${suffix}`;
  }

  return `${sourceUrl(repositoryPath, "view")}${suffix}`;
}

interface SafeMarkdownLinkProps extends ComponentPropsWithoutRef<"a"> {
  node?: unknown;
  sourcePath: string;
}

export function SafeMarkdownLink({
  href = "",
  node: _node,
  sourcePath,
  ...props
}: SafeMarkdownLinkProps) {
  const resolvedHref = resolveMarkdownHref(href, sourcePath);
  const external = /^(?:https?:)?\/\//i.test(resolvedHref);

  return (
    <a
      {...props}
      href={resolvedHref}
      {...(external ? { rel: "noreferrer noopener", target: "_blank" } : {})}
    />
  );
}

export function MarkdownDocument({
  markdown,
  sourcePath,
}: {
  markdown: string;
  sourcePath: string;
}) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          rehypeSlug,
          [
            rehypePrettyCode,
            {
              theme: "css-variables",
              keepBackground: false,
              getHighlighter: getCssVariablesHighlighter,
            },
          ],
        ]}
        skipHtml
        components={{
          pre: CodeBlock,
          table: ({ node: _node, ...props }) => (
            <table aria-label="Scrollable data table" tabIndex={0} {...props} />
          ),
          a: (props) => <SafeMarkdownLink {...props} sourcePath={sourcePath} />,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
