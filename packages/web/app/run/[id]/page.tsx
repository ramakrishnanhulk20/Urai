import type { Metadata } from "next";
import { Stone } from "../../../components/brand/stone";
import { RunView } from "../../../components/run/run-view";
import s from "../../../components/run/run.module.css";
import { Footer } from "../../../components/site/footer";
import { Header } from "../../../components/site/header";
import { SmoothScroll } from "../../../components/smooth-scroll";

export const metadata: Metadata = {
  title: "Your run",
  // A run page only works in the tab that started it; there is nothing here for a search engine.
  robots: { index: false, follow: false },
};

/*
 * The owner's live run. The server knows nothing about the visitor here: whether the page can
 * drive the run depends on the owner token in this tab's sessionStorage and the key in its memory,
 * so every state is decided in the browser by RunView.
 */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <SmoothScroll />
      <Stone streak={false} />
      <Header />
      <main className={s.root}>
        <RunView runId={id} />
      </main>
      <Footer />
    </>
  );
}
