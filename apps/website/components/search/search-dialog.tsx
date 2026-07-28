'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchRecord } from '../../lib/content-types';
import styles from './search.module.css';

export interface SearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  records: SearchRecord[];
}

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function searchRecords(records: SearchRecord[], query: string): SearchRecord[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return records.slice(0, 8);

  return records
    .map((record, index) => {
      const title = record.title.toLocaleLowerCase();
      const description = record.description.toLocaleLowerCase();
      const text = record.text.toLocaleLowerCase();
      const rank = title.includes(normalizedQuery)
        ? 0
        : description.includes(normalizedQuery)
          ? 1
          : text.includes(normalizedQuery)
            ? 2
            : -1;
      return { record, rank, index };
    })
    .filter((match) => match.rank >= 0)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, 8)
    .map(({ record }) => record);
}

export function SearchDialog({ open, onOpenChange, records }: SearchDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const results = useMemo(() => searchRecords(records, query), [query, records]);

  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      inputRef.current?.focus();
      return;
    }

    previousFocusRef.current?.focus();
    previousFocusRef.current = null;
    setQuery('');
  }, [open]);

  if (!open) return null;

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        aria-label="Search documentation"
        aria-modal="true"
        className={styles.dialog}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onOpenChange(false);
            return;
          }

          if (event.key === 'Tab') {
            const focusableElements = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
            );
            const firstElement = focusableElements[0];
            const lastElement = focusableElements.at(-1);

            if (!firstElement || !lastElement) {
              event.preventDefault();
              dialogRef.current?.focus();
              return;
            }

            if (event.shiftKey && document.activeElement === firstElement) {
              event.preventDefault();
              lastElement.focus();
            } else if (!event.shiftKey && document.activeElement === lastElement) {
              event.preventDefault();
              firstElement.focus();
            }
          }
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className={styles.dialogHeader}>
          <label htmlFor="documentation-search">Search documentation</label>
          <button aria-label="Close search" onClick={() => onOpenChange(false)} type="button">
            Esc
          </button>
        </div>
        <input
          autoComplete="off"
          id="documentation-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles, headings, and text"
          ref={inputRef}
          type="search"
          value={query}
        />

        {results.length > 0 ? (
          <ul className={styles.results}>
            {results.map((record) => (
              <li key={record.id}>
                <a href={record.href} onClick={() => onOpenChange(false)}>
                  <strong>{record.title}</strong>
                  <span>{record.description}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.emptyState}>
            <img alt="" height="64" src="/cashu-fault-lab.png" width="64" />
            <p>No matching documentation.</p>
            <a href="/scenarios">Browse scenarios</a>
          </div>
        )}
      </div>
    </div>
  );
}
