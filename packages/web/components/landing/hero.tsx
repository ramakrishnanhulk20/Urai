"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { Slash } from "../brand/slash";
import { Streak } from "../brand/streak";
import { usePrefersReducedMotion } from "../reduced-motion";
import s from "./hero.module.css";

export interface HeroProps {
  cases: number;
  model: string;
  servLabel: string;
  beforePct: string;
  afterPct: string;
  reportHref: string;
  /** A CSS length taken off the first screen, so the hero still fits under a sticky header. */
  headerOffset?: string;
  /** Anything that sits under the two main actions, such as a quieter third link. */
  afterActions?: ReactNode;
}

/*
 * The first screen. Every entrance here is a CSS animation, not JavaScript, so the words are on
 * screen within a second of first paint even when the page is still hydrating on a cold load.
 * Only the scroll parallax needs JavaScript, and it writes a single CSS variable.
 */
export function Hero({ cases, model, servLabel, beforePct, afterPct, reportHref, headerOffset, afterActions }: HeroProps) {
  const ref = useRef<HTMLElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (reduced || el === null) return;
    let raf = 0;
    const update = (): void => {
      raf = 0;
      const p = Math.min(1.2, Math.max(0, window.scrollY / window.innerHeight));
      el.style.setProperty("--hs", p.toFixed(4));
    };
    const onScroll = (): void => {
      if (raf === 0) raf = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
      el.style.removeProperty("--hs");
    };
  }, [reduced]);

  const meta = [`${cases} cases`, servLabel, model];

  return (
    <section
      ref={ref}
      className={s.hero}
      style={headerOffset === undefined ? undefined : { minHeight: `calc(100svh - ${headerOffset})` }}
    >
      <Streak className={s.heroStreak} />
      <div className={s.scrim} aria-hidden="true" />

      <div className={s.heroBody}>
        <p className={`${s.meta} ${s.enter}`} style={{ animationDelay: "0.05s" }} data-streak-floor>
          {meta.map((item, i) => (
            <span key={item} className={s.metaItem}>
              {i > 0 && <Slash className={s.metaSlash} />}
              {item}
            </span>
          ))}
        </p>

        <h1 className={s.headline} aria-label="Is SERV gold for your agent?">
          <span className={s.line}>
            <span className={s.rise} style={{ animationDelay: "0.1s" }}>
              Is SERV <em className={s.goldWord} data-streak-from>
                gold
              </em>
            </span>
          </span>
          <span className={s.line}>
            <span className={s.rise} style={{ animationDelay: "0.22s" }}>
              for your agent?
            </span>
          </span>
        </h1>

        <div className={s.heroFoot}>
          <div className={s.pitch}>
            <p className={`${s.sentence} ${s.enter}`} style={{ animationDelay: "0.42s" }}>
              Urai runs your agent&apos;s own test cases with SERV Reasoning on and off, side by side, shows what it
              changes, and fixes the setup mistake that quietly costs the most accuracy.
            </p>
            <div className={`${s.actions} ${s.enter}`} style={{ animationDelay: "0.55s" }}>
              <Link href={reportHref} className={s.primary}>
                <span>Open a sample report</span>
                <span className={s.arrow} aria-hidden="true">
                  &rarr;
                </span>
              </Link>
              <Link href="/new" className={s.secondary}>
                <Slash className={s.secondarySlash} />
                <span>Test your agent</span>
              </Link>
            </div>
            {afterActions}
          </div>

          <p className={`${s.proof} ${s.enter}`} style={{ animationDelay: "0.7s" }}>
            <Slash className={s.proofSlash} />
            <span>
              SERV on: one layout fix, <strong>{beforePct}%</strong> to <strong className={s.proofAfter}>{afterPct}%</strong>
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
