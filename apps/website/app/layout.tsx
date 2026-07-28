import "@fontsource/archivo-black";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PortalShell } from "../components/portal-shell";
import { getSearchRecords } from "../lib/markdown";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cashu Fault Lab",
  description: "Cashu delivery fault injection and recovery evidence",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const records = await getSearchRecords();

  return (
    <html lang="en">
      <body>
        <PortalShell records={records}>{children}</PortalShell>
      </body>
    </html>
  );
}
