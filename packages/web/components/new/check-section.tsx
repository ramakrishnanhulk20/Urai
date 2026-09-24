"use client";

import type { LintFinding } from "@urai/engine";
import { AnimatePresence, motion } from "motion/react";
import type { LayoutFix } from "./api";
import s from "./new.module.css";
import { EASE_OUT, Section } from "./parts";

export type CheckResult =
  | { kind: "findings"; findings: LintFinding[]; fix: LayoutFix | null; key: string }
  | { kind: "invalid"; reasons: string[]; key: string };

export interface AppliedFix {
  moved: LayoutFix["moved"];
  before: { systemPrompt: string; context: string };
}

const SEVERITY = { error: s.sevError, warning: s.sevWarning, info: s.sevInfo } as const;
const NUMBER = new Intl.NumberFormat("en-US");

export interface CheckSectionProps {
  result: CheckResult | null;
  /** True when the form has changed since the result above was checked. */
  stale: boolean;
  busy: boolean;
  /** A check is queued and will run on its own once typing stops. */
  queued: boolean;
  error: string | null;
  /** What still has to be filled in before the check can run, empty when it can. */
  blockers: string[];
  promptChars: number;
  contextChars: number;
  applied: AppliedFix | null;
  onCheck: () => void;
  onFix: () => void;
  onUndo: () => void;
}

function statusLine(p: CheckSectionProps): { text: string; bad: boolean } | null {
  if (p.busy) return { text: "Checking your setup", bad: false };
  if (p.error !== null) return { text: p.error, bad: true };
  if (p.blockers.length > 0) return { text: `Before the check can run: ${p.blockers[0]}`, bad: false };
  if (p.queued) return { text: "Changes seen. Checking again once you stop typing", bad: false };
  if (p.result === null) return { text: "Not checked yet", bad: false };
  if (p.stale) return { text: "You changed the setup after this check", bad: false };
  return null;
}

export function CheckSection(props: CheckSectionProps) {
  const { result, stale, busy, blockers, promptChars, contextChars, applied, onCheck, onFix, onUndo } = props;
  const status = statusLine(props);
  const findings = result?.kind === "findings" ? result.findings : [];
  const fix = result?.kind === "findings" && !stale ? result.fix : null;
  const errors = findings.filter((f) => f.severity === "error").length;
  const movedChars = fix?.moved.reduce((sum, m) => sum + m.chars, 0) ?? 0;

  return (
    <Section
      id="check"
      index={5}
      marker="Setup check"
      title={
        <>
          Catch the mistake
          <br />
          before it costs.
        </>
      }
      lede={
        <>
          Urai reads your setup for the mistakes we measured SERV making worse. It is free, it stores nothing, and it
          runs again by itself a couple of seconds after you stop typing.
        </>
      }
    >
      <div className={s.checkGrid}>
        <div className={s.slip} aria-live="polite" aria-busy={busy}>
          <div className={s.slipHead}>
            <span>Setup check</span>
            <span>
              {result?.kind === "findings"
                ? `${findings.length} ${findings.length === 1 ? "finding" : "findings"}${errors > 0 ? `, ${errors} to fix` : ""}`
                : result?.kind === "invalid"
                  ? "Could not read"
                  : "Waiting"}
            </span>
          </div>

          {result === null && (
            <p className={s.slipEmpty}>
              Fill in your agent, its answer shape and its cases, or load a sample, then press Check setup. The findings
              print here.
            </p>
          )}

          {result?.kind === "invalid" && (
            <>
              <p className={s.slipEmpty}>
                The server could not read this test set. Fix each point below, then check again.
              </p>
              <ul className={s.reasons}>
                {result.reasons.map((r, i) => (
                  <li key={`${i}-${r}`}>{r}</li>
                ))}
              </ul>
            </>
          )}

          {result?.kind === "findings" && (
            <ol className={s.slipList}>
              <AnimatePresence initial={false}>
                {findings.map((f) => (
                  <motion.li
                    key={`${f.id}-${f.title}`}
                    className={s.finding}
                    data-finding={f.id}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0 }}
                    transition={{ duration: 0.5, ease: EASE_OUT }}
                  >
                    <span className={`${s.sev} ${SEVERITY[f.severity]}`}>{f.severity}</span>
                    <p className={s.findingTitle}>{f.title}</p>
                    <p className={s.findingDetail}>{f.detail}</p>
                    {f.evidence !== null && <p className={s.findingEvidence}>{f.evidence}</p>}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          )}

          {result !== null && stale && !busy && <p className={s.stale}>Changed since this check</p>}
        </div>

        <div className={s.checkSide}>
          <div className={s.row}>
            <button type="button" className={s.secondary} onClick={onCheck} disabled={busy || blockers.length > 0}>
              <span>{busy ? "Checking" : "Check setup"}</span>
            </button>
          </div>
          {status !== null && (
            <p className={s.status} data-tone={status.bad ? "bad" : undefined} role="status">
              {busy && <span className={s.pulse} aria-hidden="true" />}
              {status.text}
            </p>
          )}

          <AnimatePresence mode="wait" initial={false}>
            {fix !== null && fix.moved.length > 0 && (
              <motion.div
                key="fix"
                className={s.fixCard}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.6, ease: EASE_OUT }}
              >
                <p className={s.fixTitle}>One click moves the data out.</p>
                <ul className={s.moved}>
                  {fix.moved.map((m, i) => (
                    <li key={`${i}-${m.heading ?? m.kind}`}>
                      <span>{m.heading ?? `Unlabelled ${m.kind}`}</span>
                      <span>{NUMBER.format(m.chars)} chars</span>
                    </li>
                  ))}
                </ul>
                <dl className={s.shift}>
                  <dt>System prompt</dt>
                  <dd>
                    {NUMBER.format(promptChars)}
                    <span className={s.shiftArrow} aria-label="becomes">
                      &rarr;
                    </span>
                    <b>{NUMBER.format(fix.systemPrompt.length)}</b>
                  </dd>
                  <dt>Shared data</dt>
                  <dd>
                    {NUMBER.format(contextChars)}
                    <span className={s.shiftArrow} aria-label="becomes">
                      &rarr;
                    </span>
                    <b>{NUMBER.format(fix.context?.length ?? 0)}</b>
                  </dd>
                </dl>
                <p className={s.hint}>
                  {NUMBER.format(movedChars)} characters of data move out of the rules and into shared data, which rides
                  in the user message. Nothing else changes, and you can undo it.
                </p>
                <button type="button" className={s.primary} onClick={onFix}>
                  <span>Fix layout</span>
                  <span className={s.arrow} aria-hidden="true">
                    &rarr;
                  </span>
                </button>
              </motion.div>
            )}

            {fix === null && applied !== null && (
              <motion.div
                key="applied"
                className={s.fixCard}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.6, ease: EASE_OUT }}
              >
                <p className={s.fixTitle}>Layout fixed.</p>
                <p className={s.hint}>
                  Moved {applied.moved.length} {applied.moved.length === 1 ? "block" : "blocks"} of data into shared
                  data. The system prompt is now {NUMBER.format(promptChars)} characters and shared data{" "}
                  {NUMBER.format(contextChars)}. Both fields above show the change.
                </p>
                <div className={s.row}>
                  <button type="button" className={s.secondary} onClick={onUndo}>
                    <span>Undo the fix</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}
