'use client';

import { useState } from 'react';
import styles from './home.module.css';

const DEMO_COMMAND = 'npx --yes cashu-fault-lab@0.2.0 demo';

export function HeroCommand() {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    await navigator.clipboard.writeText(DEMO_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div aria-label="Demo command" className={styles.commandBlock}>
      <span aria-hidden="true">$</span>
      <code tabIndex={0}>{DEMO_COMMAND}</code>
      <button
        aria-label="Copy demo command"
        className={styles.commandCopyButton}
        onClick={copyCommand}
        type="button"
      >
        <span aria-hidden="true" className={styles.commandCopyIcon} />
        <span aria-live="polite">{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  );
}
