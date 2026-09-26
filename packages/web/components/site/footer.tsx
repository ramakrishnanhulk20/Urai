"use client";

import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { Slash } from "../brand/slash";
import s from "./site.module.css";

const PITCH =
  "Test SERV Reasoning on your own AI agent before you switch: SERV on and off, side by side, and a one-click fix for the setup mistake that quietly costs the most accuracy.";

const LINKS = [
  { href: "/docs", label: "Docs" },
  { href: "/try", label: "Live demo" },
  { href: "/#reports", label: "Sample reports" },
  { href: "/docs/security", label: "Security" },
] as const;

const REPO = "https://github.com/ramakrishnanhulk20/Urai";

const rise = {
  hidden: { opacity: 0, y: 24 },
  shown: { opacity: 1, y: 0 },
};

export function Footer() {
  return (
    <MotionConfig reducedMotion="user">
      <footer className={s.footer}>
        <motion.div
          className={s.footTop}
          initial="hidden"
          whileInView="shown"
          viewport={{ once: true, amount: 0.3 }}
          transition={{ staggerChildren: 0.12 }}
        >
          <motion.div className={s.footLead} variants={rise} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}>
            <Slash className={s.footMark} />
            <p className={s.footPitch}>{PITCH}</p>
          </motion.div>

          <motion.nav
            className={s.footNav}
            aria-label="Footer"
            variants={rise}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          >
            <ul>
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className={s.footLink}>
                    <Slash className={s.footLinkSlash} />
                    <span>{link.label}</span>
                  </Link>
                </li>
              ))}
              <li>
                <a href={REPO} className={s.footLink} target="_blank" rel="noopener noreferrer">
                  <Slash className={s.footLinkSlash} />
                  <span>Source on GitHub</span>
                </a>
              </li>
            </ul>
          </motion.nav>
        </motion.div>

        <div className={s.footBottom}>
          <Link href="/" className={s.home} aria-label="Urai, home">
            <Slash wordmark size={22} />
          </Link>
          <p className={s.credit}>Built on OpenServ SERV Reasoning for the SERV Hackathon, Edition 01.</p>
        </div>

        {/* The wordmark set huge and cropped by the page edge, like billing at the foot of a poster. */}
        <p className={s.giant} aria-hidden="true">
          Urai
        </p>
      </footer>
    </MotionConfig>
  );
}
