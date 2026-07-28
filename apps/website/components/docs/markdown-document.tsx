import type { ComponentPropsWithoutRef } from "react";
import { MarkdownAsync as ReactMarkdown } from "react-markdown";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";
import { getSingletonHighlighter } from "shiki";
import { createCssVariablesTheme } from "shiki/core";
import type { BundledHighlighterOptions } from "shiki/types";
import { CodeBlock } from "./code-block";
import styles from "./docs.module.css";

const cssVariablesTheme = createCssVariablesTheme();

async function getCssVariablesHighlighter(options: BundledHighlighterOptions<string, string>) {
  return getSingletonHighlighter({
    ...options,
    themes: [cssVariablesTheme],
  });
}

function SafeMarkdownLink({ href = "", ...props }: ComponentPropsWithoutRef<"a">) {
  const external = /^(?:https?:)?\/\//i.test(href);

  return (
    <a
      {...props}
      href={href}
      {...(external ? { rel: "noreferrer noopener", target: "_blank" } : {})}
    />
  );
}

export function MarkdownDocument({ markdown }: { markdown: string }) {
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
          a: SafeMarkdownLink,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
