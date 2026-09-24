"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { MotionConfig, motion } from "motion/react";
import { useEffect, useRef, type CSSProperties } from "react";
import { Slash } from "../brand/slash";
import s from "./hero.module.css";

export interface AssayRow {
  label: string;
  detail: string;
  accuracy: number;
  pct: string;
  correct: number;
  calls: number;
}

export interface AssayBeatProps {
  cases: number;
  before: AssayRow;
  after: AssayRow;
  /*
   * The name of a CSS custom property on <html> that holds a sticky header's height. The pin then
   * starts under the header, and --pin-offset carries the same length for the page to size by.
   */
  headerVar?: string;
  /** Extra class on the pinned screen, for a page that sits it under a header. */
  className?: string;
}

// Where in the section's scroll each bar starts filling, and over how much of it. The CSS reads
// the same numbers through --start and --span, so the counters and the bars can never drift apart.
const ROWS = [
  { start: 0.3, converge: 1 },
  { start: 0.44, converge: -1 },
] as const;
const SPAN = 0.42;

// Grain for the gold: long horizontal striations with gaps, the texture a rub leaves on stone.
const RUB_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='360' height='60' preserveAspectRatio='none'>" +
  "<filter id='r' x='0' y='0' width='100%' height='100%'>" +
  "<feTurbulence type='fractalNoise' baseFrequency='0.012 0.45' numOctaves='3' seed='5' stitchTiles='stitch'/>" +
  "<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  3.2 0 0 0 -0.75'/></filter>" +
  "<rect width='100%' height='100%' filter='url(#r)'/></svg>";
const RUB_MASK = `url("data:image/svg+xml,${encodeURIComponent(RUB_SVG)}")`;

function rowProgress(beat: number, start: number): number {
  return Math.min(1, Math.max(0, (beat - start) / SPAN));
}

/*
 * The only scroll section. On desktop it pins, and the streak from the hero flattens and splits
 * into two gold bars that draw to the real before and after accuracy. On phones it is a plain
 * stacked pair that draws once when it comes into view. With reduced motion nothing moves and
 * the final numbers are what the server rendered.
 */
export function AssayBeat({ cases, before, after, headerVar, className }: AssayBeatProps) {
  const pinRef = useRef<HTMLDivElement>(null);
  const counterRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rows = [before, after];

  useEffect(() => {
    const el = pinRef.current;
    if (el === null) return;
    gsap.registerPlugin(ScrollTrigger);

    // Written straight to the DOM: React never re-renders while the section scrolls.
    const publish = (beat: number): void => {
      el.style.setProperty("--beat", beat.toFixed(4));
      rows.forEach((row, i) => {
        const node = counterRefs.current[i];
        if (node) node.textContent = (row.accuracy * 100 * rowProgress(beat, ROWS[i]!.start)).toFixed(1);
      });
    };
    const finish = (): void => {
      el.style.removeProperty("--beat");
      rows.forEach((row, i) => {
        const node = counterRefs.current[i];
        if (node) node.textContent = row.pct;
      });
    };

    // Each row's piece travels half the gap between the two bars, so they meet as one streak.
    const measure = (): void => {
      const tracks = el.querySelectorAll<HTMLElement>(`.${s.track}`);
      if (tracks.length !== 2) return;
      const gap = tracks[1]!.getBoundingClientRect().top - tracks[0]!.getBoundingClientRect().top;
      el.style.setProperty("--converge", `${(gap / 2).toFixed(1)}px`);
    };

    const offset = (): number =>
      headerVar === undefined ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue(headerVar)) || 0;

    const mm = gsap.matchMedia();
    mm.add("(min-width: 768px) and (prefers-reduced-motion: no-preference)", () => {
      measure();
      ScrollTrigger.addEventListener("refresh", measure);
      const trigger = ScrollTrigger.create({
        trigger: el,
        start: () => `top ${offset()}px`,
        end: "+=150%",
        pin: true,
        anticipatePin: 1,
        onUpdate: (self) => publish(self.progress),
      });
      publish(trigger.progress);
      return () => {
        ScrollTrigger.removeEventListener("refresh", measure);
        el.style.removeProperty("--converge");
        finish();
      };
    });
    mm.add("(max-width: 767px) and (prefers-reduced-motion: no-preference)", () => {
      const state = { beat: 0 };
      publish(0);
      const tween = gsap.to(state, {
        beat: 1,
        duration: 1.8,
        ease: "power2.out",
        paused: true,
        onUpdate: () => publish(state.beat),
      });
      const trigger = ScrollTrigger.create({ trigger: el, start: "top 75%", once: true, onEnter: () => tween.play() });
      return () => {
        trigger.kill();
        tween.kill();
        finish();
      };
    });
    return () => mm.revert();
    // Runs once: the rows come from server props and never change for the life of the page.
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <section className={s.beatWrap} aria-labelledby="assay-title">
        <div
          ref={pinRef}
          className={className ? `${s.beat} ${className}` : s.beat}
          style={
            {
              "--rub-mask": RUB_MASK,
              ...(headerVar === undefined ? {} : { "--pin-offset": `var(${headerVar}, 0px)` }),
            } as CSSProperties
          }
        >
          <motion.div
            className={s.beatHead}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className={s.marker}>
              <Slash className={s.markerSlash} />
              The assay
            </p>
            <h2 id="assay-title" className={s.beatTitle}>
              Same agent. Same {cases} cases. One setup fix.
            </h2>
          </motion.div>

          <div className={s.bars}>
            {rows.map((row, i) => (
              <div
                key={row.label}
                className={s.row}
                style={
                  {
                    "--start": ROWS[i]!.start,
                    "--span": SPAN,
                    "--acc": row.accuracy,
                    "--dir": ROWS[i]!.converge,
                  } as CSSProperties
                }
              >
                <div className={s.rowLabel}>
                  <span className={s.rowName}>{row.label}</span>
                  <span className={s.rowDetail}>{row.detail}</span>
                </div>
                <div className={s.rowBar}>
                  <div className={s.track}>
                    <div className={s.piece} aria-hidden="true" />
                    <div className={s.fill} />
                  </div>
                  <p className={s.rowNumber}>
                    <span ref={(node) => void (counterRefs.current[i] = node)}>{row.pct}</span>
                    <span className={s.pctSign}>%</span>
                  </p>
                </div>
                <p className={s.rowStatus}>
                  <span className={s.right}>
                    {row.correct} of {row.calls} right
                  </span>
                  <span className={s.wrong}>{row.calls - row.correct} wrong</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </MotionConfig>
  );
}
