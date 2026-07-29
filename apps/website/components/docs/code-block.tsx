'use client';

import { type ComponentPropsWithoutRef, useRef, useState } from 'react';
import styles from './docs.module.css';

interface CodeBlockProps extends ComponentPropsWithoutRef<'pre'> {
  'data-language'?: string;
  node?: unknown;
}

export function CodeBlock({
  children,
  'data-language': language,
  node: _node,
  ...props
}: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function copyCode() {
    const text = preRef.current?.innerText ?? '';
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeUtility}>
        {language ? <span className={styles.codeLanguage}>{language}</span> : <span />}
        <button
          aria-label="Copy code"
          className={styles.copyButton}
          onClick={copyCode}
          type="button"
        >
          <span aria-hidden="true" className={styles.copyIcon} />
          <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre {...props} data-language={language} ref={preRef}>
        {children}
      </pre>
    </div>
  );
}
