"use client";

import { motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { Slash } from "../brand/slash";
import s from "./new.module.css";

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export const rise: Variants = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_OUT } },
};

export interface SectionProps {
  id: string;
  index: number;
  marker: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  className?: string;
}

/*
 * One step of the builder. The heading block enters once as it scrolls into view; the body rises
 * after it on its own, much lower threshold, because a body can be taller than the screen and
 * would otherwise never reach a share of it large enough to trigger.
 */
export function Section({ id, index, marker, title, lede, children, className }: SectionProps) {
  const titleId = `${id}-title`;
  return (
    <section id={id} className={className ? `${s.section} ${className}` : s.section} aria-labelledby={titleId}>
      <motion.div
        className={s.head}
        initial="hidden"
        whileInView="shown"
        viewport={{ once: true, amount: 0.4 }}
        variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.1 } } }}
      >
        <div>
          <motion.p className={s.marker} variants={rise}>
            <Slash className={s.markerSlash} />
            <span className={s.markerIndex}>{String(index).padStart(2, "0")}</span>
            {marker}
          </motion.p>
          <motion.h2 id={titleId} className={s.title} variants={rise}>
            {title}
          </motion.h2>
        </div>
        {lede !== undefined && (
          <motion.p className={s.sectionLede} variants={rise}>
            {lede}
          </motion.p>
        )}
      </motion.div>
      <motion.div
        className={s.body}
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.05 }}
        transition={{ duration: 0.8, ease: EASE_OUT, delay: 0.15 }}
      >
        {children}
      </motion.div>
    </section>
  );
}

export function Count({ value, max }: { value: number; max: number }) {
  return (
    <span className={s.count} data-over={value > max}>
      {value.toLocaleString("en-US")} / {max.toLocaleString("en-US")}
    </span>
  );
}
