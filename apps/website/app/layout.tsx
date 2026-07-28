import "@fontsource/archivo-black";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PortalShell } from "../components/portal-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cashu Fault Lab",
  description: "Cashu delivery fault injection and recovery evidence",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <PortalShell>{children}</PortalShell>
      </body>
    </html>
  );
}
