"use client";

import { MotionConfig, motion, useInView } from "motion/react";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { usePrefersReducedMotion } from "../reduced-motion";

const EASE = [0.16, 1, 0.3, 1] as const;

const rise = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE } },
};

/** A block that fades and rises into place the first time it scrolls into view, staggering its RevealItems. */
export function Reveal({
  children,
  className,
  as = "div",
  stagger = 0.09,
  amount = 0.15,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "ol" | "ul" | "aside";
  stagger?: number;
  amount?: number;
}) {
  const Tag = motion[as];
  return (
    <MotionConfig reducedMotion="user">
      <Tag
        className={className}
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, amount }}
        variants={{ hidden: {}, shown: { transition: { staggerChildren: stagger } } }}
      >
        {children}
      </Tag>
    </MotionConfig>
  );
}

export function RevealItem({
  children,
  className,
  as = "div",
  style,
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "li" | "p" | "article";
  style?: CSSProperties;
}) {
  const Tag = motion[as];
  return (
    <Tag className={className} style={style} variants={rise}>
      {children}
    </Tag>
  );
}

/*
 * The big accuracy number. The server renders the final value, so a reader with no script or
 * with reduced motion sees the real figure straight away; otherwise it counts up once, the first
 * time it comes into view, written straight to the DOM so React never re-renders per frame.
 */
export function CountUp({ value, text }: { value: number; text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (el === null || reduced || !inView) return;
    const decimals = text.includes(".") ? 1 : 0;
    let raf = 0;
    let start = 0;
    const frame = (now: number): void => {
      if (start === 0) start = now;
      const t = Math.min(1, (now - start) / 1400);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = t < 1 ? (value * eased).toFixed(decimals) : text;
      if (t < 1) raf = window.requestAnimationFrame(frame);
    };
    el.textContent = (0).toFixed(decimals);
    raf = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(raf);
      el.textContent = text;
    };
  }, [inView, reduced, value, text]);

  return <span ref={ref}>{text}</span>;
}

/** The gold rub that draws across the track to the accuracy, once, as it scrolls into view. */
export function RubBar({ accuracy, className }: { accuracy: number; className?: string }) {
  return (
    <MotionConfig reducedMotion="user">
      <motion.span
        className={className}
        style={{ width: `${accuracy * 100}%`, originX: 0 }}
        initial={{ scaleX: 0 }}
        whileInView={{ scaleX: 1 }}
        viewport={{ once: true, amount: 0.8 }}
        transition={{ duration: 1.4, ease: EASE, delay: 0.15 }}
      />
    </MotionConfig>
  );
}
