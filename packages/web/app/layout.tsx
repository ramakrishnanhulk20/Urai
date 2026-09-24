import type { Metadata } from "next";
import type { ReactNode } from "react";
import { displayFont, monoFont } from "../components/brand/fonts";
import "./globals.css";

const DESCRIPTION =
  "Test SERV Reasoning on your own AI agent before you switch: SERV on and off, side by side, and one-click fixes for the setup mistakes that quietly cost accuracy.";

// Share cards need absolute URLs. The live address comes from the deploy; local dev falls back.
const siteUrl = process.env.URAI_PUBLIC_URL ?? "http://localhost:3001";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    template: "%s | Urai",
    default: "Urai: is SERV gold for your agent?",
  },
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "Urai",
    title: "Urai: is SERV gold for your agent?",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "Urai: is SERV gold for your agent?",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${displayFont.variable} ${monoFont.variable}`}>
      <body>{children}</body>
    </html>
  );
}
