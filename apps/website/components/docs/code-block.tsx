'use client';

import { type ComponentPropsWithoutRef, useRef, useState } from 'react';
import styles from './docs.module.css';

interface CodeBlockProps extends ComponentPropsWithoutRef<'pre'> {
  node?: unknown;
}

export function CodeBlock({ children, node: _node, ...props }: CodeBlockProps) {
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
      <button className={styles.copyButton} onClick={copyCode} type="button">
        {copied ? 'Copied' : 'Copy code'}
      </button>
      <pre {...props} ref={preRef}>
        {children}
      </pre>
    </div>
  );
}
