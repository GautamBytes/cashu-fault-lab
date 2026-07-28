import "@fontsource/archivo-black";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PortalShell } from "../components/portal-shell";
import { getSearchRecords } from "../lib/markdown";
import "./globals.css";
import { siteUrl } from "./site-metadata";

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "Cashu Fault Lab",
    template: "%s | Cashu Fault Lab",
  },
  description:
    "An experimental developer preview for Cashu delivery fault injection, recovery, and independent evidence.",
  alternates: {
    canonical: "./",
  },
  manifest: "/manifest.webmanifest",
  openGraph: {
    description:
      "An experimental developer preview for Cashu delivery fault injection, recovery, and independent evidence.",
    images: ["/opengraph-image"],
    siteName: "Cashu Fault Lab",
    title: "Cashu Fault Lab",
    type: "website",
  },
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
