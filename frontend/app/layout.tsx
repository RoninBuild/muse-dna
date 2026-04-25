import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import "./globals.css";
import "./acid.css";

export const metadata: Metadata = {
  title: "MUSE DNA — Agentic Micro-Payment Economy",
  description: "AI marketing agency powered by sub-cent micro-payments on Arc. Circle Nanopayments + Hermes Memory."
};

// Explicit viewport export — without this Next.js 15 falls back to its
// default which doesn't include `viewport-fit: cover`. Hackathon judges
// may open the demo on iPhone Pro screens with a notch; without
// `viewport-fit: cover` the topbar gets clipped behind the safe area.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#08090c"
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
