"use client";

import { MotionConfig, motion, useInView } from "motion/react";
import Link from "next/link";
import { useRef } from "react";
import type { SetupData } from "../../lib/landing-data";
import { evidenceText } from "../report/format";
import { usePrefersReducedMotion } from "../reduced-motion";
import l from "./landing.module.css";
import { EASE_OUT, Reveal, rise, SectionMarker } from "./reveal";

const NUMBER = new Intl.NumberFormat("en-US");
const SEVERITY = { error: l.sevError, warning: l.sevWarning, info: l.sevInfo } as const;

function points(before: string, after: string): string {
  return String(Number((Number(after) - Number(before)).toFixed(1)));
}

function Cursor() {
  return (
    <svg className={l.cursor} viewBox="0 0 24 28" aria-hidden="true">
      <path d="M3 2 21 15.5 12.6 16.6 17.4 25.4 14 27 9.3 18.3 3 24Z" fill="#efe9df" stroke="#0b0b0c" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/*
 * The signature moment: the check names the mistake, a pointer presses Fix layout, and the
 * supplier data slides out of the instructions into the user message. The move is a single
 * data attribute flipped once when the stage comes into view; CSS does the rest.
 */
export function SetupCheck({ data }: { data: SetupData }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const inView = useInView(stageRef, { once: true, amount: 0.45 });
  const reduced = usePrefersReducedMotion();
  const go = inView || reduced;
  const gap = points(data.before.pct, data.after.pct);
  const movedChars = data.moved.reduce((sum, m) => sum + m.chars, 0);

  return (
    <MotionConfig reducedMotion="user">
      <section className={l.section} aria-labelledby="setup-title">
        <Reveal className={l.head}>
          <div>
            <SectionMarker>The setup check</SectionMarker>
            <motion.h2 id="setup-title" className={l.title} variants={rise}>
              <span className={l.titleLine}>The mistake</span>
              <span className={l.titleLine}>
                that cost <em className={l.gold}>{gap} points.</em>
              </span>
            </motion.h2>
          </div>
          <motion.p className={`${l.lead} ${l.headLead}`} variants={rise}>
            Before a single call, Urai reads your setup for the mistakes we measured SERV making worse. On this sample
            agent it found one that cost <strong>{gap} points</strong> of accuracy, and one click fixed it.
          </motion.p>
        </Reveal>

        <div className={l.setupBody}>
          <Reveal amount={0.2}>
            <motion.div className={l.slip} variants={rise}>
              <div className={l.slipHead}>
                <span>Setup check</span>
                <span>
                  {data.findings.length} {data.findings.length === 1 ? "finding" : "findings"}
                </span>
              </div>
              <p className={l.slipName}>{data.workloadName}</p>
              <motion.ol className={l.slipList} variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.12, delayChildren: 0.3 } } }}>
                {data.findings.map((f) => (
                  <motion.li key={f.title} className={l.finding} variants={rise}>
                    <span className={`${l.sev} ${SEVERITY[f.severity]}`}>{f.severity}</span>
                    <p className={l.findingTitle}>{f.title}</p>
                    <p className={l.findingDetail}>{f.detail}</p>
                    {f.severity === "error" && f.evidence !== null && <p className={l.findingEvidence}>{evidenceText(f)}</p>}
                  </motion.li>
                ))}
              </motion.ol>
            </motion.div>
          </Reveal>

          <div ref={stageRef} className={`${l.fix} ${l.fixStage}`} data-go={go}>
            <div className={l.fixButtonRow}>
              <motion.div
                className={l.fixButton}
                aria-hidden="true"
                initial={false}
                animate={go && !reduced ? { scale: [1, 1, 0.93, 1] } : { scale: 1 }}
                transition={{ duration: 1, times: [0, 0.55, 0.65, 0.85] }}
              >
                <motion.span
                  className={l.fixGlint}
                  initial={{ x: "-130%" }}
                  animate={go && !reduced ? { x: "130%" } : { x: "-130%" }}
                  transition={{ delay: 0.62, duration: 0.8, ease: EASE_OUT }}
                />
                <span>Fix layout</span>
              </motion.div>
              {!reduced && (
                <motion.span
                  style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
                  initial={{ opacity: 0, x: 90, y: 70 }}
                  animate={go ? { opacity: 1, x: 0, y: 0 } : { opacity: 0, x: 90, y: 70 }}
                  transition={{ duration: 0.6, ease: EASE_OUT }}
                >
                  <Cursor />
                </motion.span>
              )}
              <span className={l.fixCaption}>One click, no rewrite by hand</span>
            </div>

            <div className={l.boxes}>
              <div className={l.box}>
                <span className={l.boxLabel}>System prompt</span>
                <span className={l.boxChars}>
                  <b>{NUMBER.format(go ? data.promptCharsAfter : data.promptCharsBefore)}</b> characters
                </span>
                <span className={l.boxLines} aria-hidden="true">
                  <span style={{ width: "92%" }} />
                  <span style={{ width: "78%" }} />
                  <span style={{ width: "85%" }} />
                </span>
                <div className={l.slot}>
                  {data.moved.map((m) => (
                    <div key={`home-${m.heading}`} className={`${l.chip} ${l.chipHome}`}>
                      <span className={l.chipName}>{m.heading}</span>
                      <span className={l.chipSize}>{NUMBER.format(m.chars)} characters</span>
                    </div>
                  ))}
                  <div className={l.ghostChip}>Moved out</div>
                </div>
              </div>

              <div className={l.box}>
                <span className={l.boxLabel}>User message</span>
                <span className={l.boxChars}>
                  <b>+{NUMBER.format(go ? movedChars : 0)}</b> characters
                </span>
                <span className={l.boxLines} aria-hidden="true">
                  <span style={{ width: "70%" }} />
                </span>
                {data.moved.map((m) => (
                  <div key={`moved-${m.heading}`} className={`${l.chip} ${l.chipMoved}`}>
                    <span className={l.chipName}>{m.heading}</span>
                    <span className={l.chipSize}>{NUMBER.format(m.chars)} characters</span>
                  </div>
                ))}
              </div>
            </div>

            <motion.div
              className={l.verdictRow}
              initial={{ opacity: 0, y: 24 }}
              animate={go ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
              transition={{ delay: reduced ? 0 : 1.5, duration: 0.8, ease: EASE_OUT }}
            >
              <Link href={data.before.href} className={l.bigPctLink}>
                <span className={l.bigPctLabel}>Before, SERV on</span>
                <span className={l.bigPct}>
                  {data.before.pct}
                  <small>%</small>
                </span>
              </Link>
              <span className={l.bigArrow} aria-hidden="true">
                &rarr;
              </span>
              <Link href={data.after.href} className={`${l.bigPctLink} ${l.bigPctAfter}`}>
                <span className={l.bigPctLabel}>After the fix, SERV on</span>
                <span className={l.bigPct}>
                  {data.after.pct}
                  <small>%</small>
                </span>
              </Link>
            </motion.div>

            <motion.p
              className={l.why}
              initial={{ opacity: 0, y: 24 }}
              animate={go ? { opacity: 1, y: 0 } : { opacity: 0, y: 24 }}
              transition={{ delay: reduced ? 0 : 1.7, duration: 0.8, ease: EASE_OUT }}
            >
              The fix moves data out of the instructions, because SERV compresses the instructions into its own
              reasoning graph and drops data it finds there. Same model, same {data.after.calls} cases. Open either
              number for the full report.
            </motion.p>
          </div>
        </div>
      </section>
    </MotionConfig>
  );
}
