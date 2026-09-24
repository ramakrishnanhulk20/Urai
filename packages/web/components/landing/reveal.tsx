"use client";

import { motion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { Slash } from "../brand/slash";
import l from "./landing.module.css";

export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Fade and rise by 24px. A parent Reveal staggers every child that uses these. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.8, ease: EASE_OUT } },
};

export interface RevealProps {
  children: ReactNode;
  className?: string;
  /** Seconds between each child that uses the rise variants. */
  stagger?: number;
  /** How much of the block must be on screen before it enters, 0 to 1. */
  amount?: number;
}

/** A block that enters once as it scrolls into view, and staggers its rising children. */
export function Reveal({ children, className, stagger = 0.1, amount = 0.3 }: RevealProps) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount }}
      transition={{ staggerChildren: stagger }}
      variants={{ hidden: {}, shown: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </motion.div>
  );
}

/** The gold slash and a mono label that opens every section. */
export function SectionMarker({ children }: { children: ReactNode }) {
  return (
    <motion.p className={l.marker} variants={rise}>
      <Slash className={l.markerSlash} />
      {children}
    </motion.p>
  );
}
