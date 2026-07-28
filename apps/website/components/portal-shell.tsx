"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { SearchRecord } from "../lib/content-types";
import { SearchDialog } from "./search/search-dialog";
import { SiteHeader } from "./site-header";

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
        event.key.toLocaleLowerCase() === "k" &&
        (event.metaKey || event.ctrlKey) &&
        !isEditingTarget(event.target)
      ) {
        event.preventDefault();
        setOpen(true);
      }
    }

    window.addEventListener("keydown", openWithKeyboard);
    return () => window.removeEventListener("keydown", openWithKeyboard);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <SiteHeader onOpenSearch={() => setOpen(true)} />
      <SearchDialog onOpenChange={setOpen} open={open} records={records} />
      <main id="main-content">{children}</main>
      <footer>Experimental developer preview.</footer>
    </>
  );
}
