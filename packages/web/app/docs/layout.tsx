import type { CSSProperties, ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import s from "../../components/docs/docs.module.css";
import { HeaderHeight } from "../../components/landing/header-height";
import { Footer } from "../../components/site/footer";
import { Header } from "../../components/site/header";
import { docsLayoutOptions } from "../../lib/docs-layout";
import { source } from "../../lib/source";

// Fumadocs offsets its sticky sidebar and table of contents by --fd-banner-height, so our sticky site
// header must be counted there or it covers the top of both. --header-h is measured live by HeaderHeight;
// 88px is its height at 1440 wide, used only for the first paint.
const belowSiteHeader = { "--fd-banner-height": "var(--header-h, 88px)" } as CSSProperties;

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }}>
      <div className={`${s.docs} flex min-h-screen flex-col`}>
        <HeaderHeight />
        <Header />
        <DocsLayout
          tree={source.getPageTree()}
          {...docsLayoutOptions()}
          containerProps={{ style: belowSiteHeader }}
        >
          {children}
        </DocsLayout>
        <Footer />
      </div>
    </RootProvider>
  );
}
