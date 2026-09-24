"use client";

import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useState } from "react";
import b from "../brand/brand.module.css";
import { Slash } from "../brand/slash";
import { Streak } from "../brand/streak";
import l from "./landing.module.css";
import { Reveal, rise, SectionMarker } from "./reveal";

/*
 * The closing screen mirrors the first: open stone, a gold streak rubbed off the gold word, and
 * the headline underneath. The streak mounts only when the screen is reached, so the rub plays
 * where someone can see it rather than at page load.
 */
export function FinalCall() {
  const [reached, setReached] = useState(false);

  return (
    <MotionConfig reducedMotion="user">
      <motion.section
        className={l.final}
        aria-labelledby="final-title"
        onViewportEnter={() => setReached(true)}
        viewport={{ once: true, amount: 0.4 }}
      >
        {reached && <Streak />}
        <div className={l.finalTop} data-streak-ceiling>
          <Reveal>
            <SectionMarker>Your turn</SectionMarker>
          </Reveal>
        </div>
        <Reveal className={l.finalBody} stagger={0.12} amount={0.4}>
          <motion.h2 id="final-title" className={l.finalTitle} variants={rise} data-streak-floor>
            <span className={l.titleLine}>
              Rub your{" "}
              <em className={l.gold} data-streak-from>
                agent
              </em>
            </span>
            <span className={l.titleLine}>on the stone.</span>
          </motion.h2>
          <motion.div className={l.finalFoot} variants={rise}>
            <div className={l.finalActions}>
              <Link href="/try" className={b.goldButton}>
                <span>Run the live demo</span>
                <span className={b.goldArrow} aria-hidden="true">
                  &rarr;
                </span>
              </Link>
              <Link href="/new" className={l.ghost}>
                <Slash className={l.ghostSlash} />
                <span>Test your agent</span>
              </Link>
            </div>
            <p className={l.finalNote}>
              Start with the demo on our sample agent, no key needed. Then bring your own test cases and a SERV key.
            </p>
          </motion.div>
        </Reveal>
      </motion.section>
    </MotionConfig>
  );
}
