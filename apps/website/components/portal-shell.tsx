'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { SearchRecord } from '../lib/content-types';
import { ScrollReveal } from './scroll-reveal';
import { SearchDialog } from './search/search-dialog';
import { SiteHeader } from './site-header';

export interface PortalShellProps {
  children: ReactNode;
  records: SearchRecord[];
}

function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') !== null
  );
}

export function PortalShell({ children, records }: PortalShellProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function openWithKeyboard(event: KeyboardEvent) {
      if (
        event.key.toLocaleLowerCase() === 'k' &&
        (event.metaKey || event.ctrlKey) &&
        !isEditingTarget(event.target)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }

    function openWithAction() {
      setOpen(true);
    }

    window.addEventListener('keydown', openWithKeyboard);
    window.addEventListener('cashu-fault-lab:open-search', openWithAction);
    document.documentElement.dataset.searchShortcutReady = 'true';
    return () => {
      delete document.documentElement.dataset.searchShortcutReady;
      window.removeEventListener('keydown', openWithKeyboard);
      window.removeEventListener('cashu-fault-lab:open-search', openWithAction);
    };
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <SiteHeader onOpenSearch={() => setOpen(true)} />
      <SearchDialog onOpenChange={setOpen} open={open} records={records} />
      <main id="main-content">{children}</main>
      <ScrollReveal />
      <footer>
        <div className="footer-inner">
          <span>Experimental developer preview.</span>
          <nav aria-label="Gautam Manchandani profiles" className="footer-profiles">
            <a href="https://x.com/GautamM96" rel="noreferrer noopener" target="_blank">
              X <span aria-hidden="true">↗</span>
            </a>
            <a
              href="https://www.linkedin.com/in/gautam-manchandani/"
              rel="noreferrer noopener"
              target="_blank"
            >
              LinkedIn <span aria-hidden="true">↗</span>
            </a>
            <a href="https://github.com/GautamBytes" rel="noreferrer noopener" target="_blank">
              GitHub <span aria-hidden="true">↗</span>
            </a>
          </nav>
        </div>
      </footer>
    </>
  );
}
