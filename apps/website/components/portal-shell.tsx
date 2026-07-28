"use client";

import { type ReactNode, useCallback } from "react";
import { SiteHeader } from "./site-header";

export interface PortalShellProps {
  children: ReactNode;
}

export function PortalShell({ children }: PortalShellProps) {
  const openSearch = useCallback(() => {
    // Search records and dialog state are added in Task 3.
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <SiteHeader onOpenSearch={openSearch} />
      <main id="main-content">{children}</main>
      <footer>Experimental developer preview.</footer>
    </>
  );
}
