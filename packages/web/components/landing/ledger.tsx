"use client";

import { MotionConfig, motion } from "motion/react";
import Link from "next/link";
import type { CSSProperties } from "react";
import type { LedgerData, LedgerRow } from "../../lib/landing-data";
import { Slash } from "../brand/slash";
import l from "./landing.module.css";
import { EASE_OUT, Reveal, rise, SectionMarker } from "./reveal";

const barIn = {
  hidden: { scaleX: 0 },
  shown: { scaleX: 1, transition: { delay: 0.35, duration: 1, ease: EASE_OUT } },
};

function Stat({ label, pct, accuracy, on, className }: { label: string; pct: string | null; accuracy: number | null; on: boolean; className?: string }) {
  return (
    <div className={`${l.stat} ${className ?? ""}`}>
      <span className={l.statLabel}>{label}</span>
      {pct === null || accuracy === null ? (
        <span className={l.statNone}>Not run</span>
      ) : (
        <>
          <span className={`${l.statNum} ${on ? l.statOn : ""}`}>
            {pct}
            <small>%</small>
          </span>
          <span className={`${l.statBar} ${on ? l.statOnBar : ""}`} style={{ "--acc": accuracy } as CSSProperties}>
            <motion.span variants={barIn} />
          </span>
        </>
      )}
    </div>
  );
}

function tokenText(change: number | null): string | null {
  if (change === null) return null;
  if (change === 0) return "The same";
  return `${Math.abs(change)}% ${change < 0 ? "fewer" : "more"}`;
}

function Row({ row, index }: { row: LedgerRow; index: number }) {
  const tokens = tokenText(row.tokenChange);
  return (
    <motion.li className={l.ledgerRow} variants={rise}>
      <span className={l.ledgerIdx}>
        <Slash className={l.ledgerSlash} />
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className={l.ledgerName}>
        <h3 className={l.ledgerTitle}>{row.title}</h3>
        {row.detail !== "" && <p className={l.ledgerDetail}>{row.detail}</p>}
      </div>
      <Stat label="SERV off" pct={row.off} accuracy={row.offAccuracy} on={false} className={l.statOff} />
      <Stat label="SERV on" pct={row.on} accuracy={row.onAccuracy} on className={l.statOnCol} />
      <div className={`${l.stat} ${l.statTok}`}>
        <span className={l.statLabel}>Tokens with SERV</span>
        {tokens === null ? <span className={l.statNone}>Not compared</span> : <span className={l.tokens}>{tokens}</span>}
      </div>
      <Link href={row.href} className={l.rowLink} aria-label={`Open report: ${row.title}`}>
        Open report
        <span className={l.rowArrow} aria-hidden="true">
          &rarr;
        </span>
      </Link>
    </motion.li>
  );
}

/*
 * Every sample run, good news and bad, as ruled rows. The losing run is on the page on purpose:
 * a tester that only ever says yes is not a tester.
 */
export function Ledger({ data }: { data: LedgerData }) {
  const { hard, parity } = data;
  const rulebook = hard.clauses === null ? "a large rulebook" : `a ${hard.clauses}-clause rulebook`;
  const fewer = parity.tokenChange !== null && parity.tokenChange < 0 ? ` on ${-parity.tokenChange}% fewer tokens` : "";
  const close = parity.gap <= 0 ? `it matched it${fewer}` : `it came within ${parity.gap} points${fewer}`;

  return (
    <MotionConfig reducedMotion="user">
      <section id="reports" className={`${l.section} ${l.ledgerSection}`} aria-labelledby="reports-title">
        <Reveal className={l.head}>
          <div>
            <SectionMarker>Where SERV fits</SectionMarker>
            <motion.h2 id="reports-title" className={l.title} variants={rise}>
              <span className={l.titleLine}>Sometimes</span>
              <span className={l.titleLine}>
                the answer is <em className={l.gold}>no.</em>
              </span>
            </motion.h2>
          </div>
          <motion.p className={`${l.lead} ${l.headLead}`} variants={rise}>
            On {rulebook}, SERV scored <strong>{hard.on}%</strong> where the same model alone scored{" "}
            <strong>{hard.off}%</strong>. With the right layout on a mid-size rulebook {close}. Test before you
            switch.
          </motion.p>
        </Reveal>

        <Reveal className={l.ledgerWrap} amount={0.15} stagger={0.12}>
          <div className={l.ledgerHead} aria-hidden="true">
            <span />
            <span>Sample run</span>
            <span>SERV off</span>
            <span>SERV on</span>
            <span>Tokens with SERV</span>
            <span />
          </div>
          <motion.ol className={l.ledger} variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.12 } } }}>
            {data.rows.map((row, i) => (
              <Row key={row.slug} row={row} index={i} />
            ))}
          </motion.ol>
        </Reveal>
      </section>
    </MotionConfig>
  );
}
