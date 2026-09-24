"use client";

import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import type { SecuritySummary } from "../../lib/landing-data";
import l from "./landing.module.css";
import { Reveal, rise, SectionMarker } from "./reveal";

const PROMISES = [
  "Your SERV key is used for one request, then dropped. It is never stored and never logged.",
  "Who pays is locked the moment a run starts, and cannot be switched halfway.",
  "The live demo spends a capped daily budget of ours, so it needs no key from you.",
] as const;

export function KeySection({ security }: { security: SecuritySummary | null }) {
  return (
    <MotionConfig reducedMotion="user">
      <section className={l.section} aria-labelledby="key-title">
        <Reveal className={l.keyBody} stagger={0.12}>
          <div>
            <SectionMarker>Your key</SectionMarker>
            <motion.h2 id="key-title" className={l.title} variants={rise}>
              <span className={l.titleLine}>
                Your key <em className={l.gold}>never</em>
              </span>
              <span className={l.titleLine}>leaves the call.</span>
            </motion.h2>
          </div>
          <motion.ol className={l.promises} variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.14, delayChildren: 0.2 } } }}>
            {PROMISES.map((promise) => (
              <motion.li key={promise} className={l.promise} variants={rise}>
                {promise}
              </motion.li>
            ))}
          </motion.ol>
        </Reveal>

        <Reveal>
          <motion.div className={l.secLine} variants={rise}>
            {security !== null && (
              <p className={l.secCounts}>
                <span>Latest security check{security.date === null ? "" : `, ${security.date}`}</span>
                <span className={l.secOk}>
                  <b>{security.ok}</b> OK
                </span>
                <span className={l.secBroken}>
                  <b>{security.broken}</b> broken
                </span>
                <span className={l.secPending}>
                  <b>{security.pending}</b> pending
                </span>
              </p>
            )}
            <Link href="/docs/security" className={l.textLink}>
              How we check
              <span className={l.textArrow} aria-hidden="true">
                &rarr;
              </span>
            </Link>
          </motion.div>
        </Reveal>
      </section>
    </MotionConfig>
  );
}
