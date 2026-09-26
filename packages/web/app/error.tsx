"use client";

import Link from "next/link";
import { Stone } from "../components/brand/stone";
import { Slash } from "../components/brand/slash";
import s from "../components/run/run.module.css";
import { Footer } from "../components/site/footer";
import { Header } from "../components/site/header";

/*
 * Any page that throws lands here. The visitor gets what happened in plain words and a way back,
 * never the error's message or stack, which can carry server detail nobody outside should read.
 */
export default function PageError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <>
      <Stone streak={false} />
      <Header />
      <main className={s.root}>
        <section className={s.panel} aria-label="Something went wrong">
          <Slash className={s.panelMark} />
          <p className={`${s.marker} ${s.enter}`}>
            <Slash className={s.markerSlash} />
            <span>Something went wrong</span>
          </p>
          <h1 className={s.panelTitle} data-size="medium">
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.1s" }}>
                This page
              </span>
            </span>
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.2s" }}>
                did not <em className={s.goldWord}>load.</em>
              </span>
            </span>
          </h1>
          <div className={s.panelBody}>
            <p className={`${s.panelText} ${s.enter}`} style={{ animationDelay: "0.35s" }}>
              Urai hit a problem building this page. Try again, and if it keeps happening, start from the home page.
            </p>
            <div className={`${s.actions} ${s.enter}`} style={{ animationDelay: "0.5s" }}>
              <button type="button" className={s.primary} onClick={() => reset()}>
                <span>Try again</span>
                <span className={s.arrow} aria-hidden="true">
                  &rarr;
                </span>
              </button>
              <Link href="/" className={s.secondary}>
                <Slash className={s.secondarySlash} />
                <span>Go to the home page</span>
              </Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
