"use client";

import { motion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Slash } from "../brand/slash";
import { useCountUp } from "./count-up";
import type { ColumnTotals } from "./live-grid";
import s from "./try.module.css";
import { configLabels, percent, type DemoConfig, type SampleChoice } from "./types";

const EASE = [0.16, 1, 0.3, 1] as const;

export type Finish =
  | { kind: "sharing" }
  | { kind: "done"; reportId: string }
  | { kind: "share_failed"; code: string }
  | { kind: "budget"; answered: number }
  /** SERV could not take several calls in a row; the calls not yet run are waiting for Resume. */
  | { kind: "outage"; waiting: number }
  | { kind: "stopped"; status: number; code: string };

export interface OutcomeProps {
  finish: Finish;
  sample: SampleChoice;
  samples: SampleChoice[];
  configs: DemoConfig[];
  totals: ColumnTotals[];
  onReset: () => void;
  onRetryShare: () => void;
  onResume: () => void;
}

function Verdict({ label, totals }: { label: string; totals: ColumnTotals }) {
  const target = totals.accuracy === null ? 0 : totals.accuracy * 100;
  const shown = useCountUp(target, 0, 1400);
  return (
    <div className={s.verdict}>
      <span className={s.verdictLabel}>{label}</span>
      <p className={s.verdictNumber}>
        {totals.accuracy === null ? "n/a" : shown >= target ? percent(totals.accuracy) : shown.toFixed(1)}
        {totals.accuracy !== null && <span className={s.pctSign}>%</span>}
      </p>
      <span className={s.verdictSub}>
        {totals.right} of {totals.back} right
      </span>
    </div>
  );
}

function Panel({ children, label }: { children: ReactNode; label: string }) {
  return (
    <motion.section
      className={s.outcome}
      aria-label={label}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: EASE }}
    >
      {children}
    </motion.section>
  );
}

function SavedReports({ samples }: { samples: SampleChoice[] }) {
  const saved = samples.flatMap((x) => (x.saved === null ? [] : [{ name: x.name, saved: x.saved }]));
  if (saved.length === 0) return null;
  return (
    <ul className={s.reportList}>
      {saved.map(({ name, saved: r }) => (
        <li key={r.reportId}>
          <Link href={`/r/${r.reportId}`} className={s.textLink}>
            <Slash className={s.secondarySlash} />
            <span>{name}</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </Link>
          <span className={s.reportMeta}>
            {r.cases} cases / {r.columns.map((c) => `${c.label} ${percent(c.accuracy)}%`).join(" / ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

const NUMBER = new Intl.NumberFormat("en-US");

// Points between two accuracies, one decimal at most: 0.95 against 0.9 is 5.
function points(a: number, b: number): string {
  return String(Number((Math.abs(a - b) * 100).toFixed(1)));
}

/*
 * The run in one plain sentence: which setting scored higher and by how much, then the token
 * difference, input plus output, the same basis the reports use. SERV off is the yardstick when
 * the run has it.
 */
export function verdictSentence(configs: DemoConfig[], totals: ColumnTotals[]): string {
  const labels = configLabels(configs);
  if (configs.length === 1) {
    const t = totals[0]!;
    return t.accuracy === null ? `${labels[0]} gave no scored answers.` : `${labels[0]} scored ${percent(t.accuracy)}%, ${t.right} of ${t.back} right.`;
  }
  const off = configs.findIndex((c) => c.mode === "raw");
  const on = configs.findIndex((c) => c.mode !== "raw");
  const [a, b] = off !== -1 && on !== -1 ? [on, off] : [0, 1];
  const ta = totals[a]!;
  const tb = totals[b]!;
  if (ta.accuracy === null || tb.accuracy === null) return "Not enough answers came back to compare the settings.";

  let score: string;
  if (ta.accuracy === tb.accuracy) score = `${labels[a]} and ${labels[b]} both scored ${percent(ta.accuracy)}%`;
  else {
    const [hi, lo] = ta.accuracy > tb.accuracy ? [a, b] : [b, a];
    const th = totals[hi]!.accuracy!;
    const tl = totals[lo]!.accuracy!;
    score = `${labels[hi]} scored higher, ${percent(th)}% against ${percent(tl)}% for ${labels[lo]}, ${points(th, tl)} points ahead`;
  }

  if (ta.tokens === null || tb.tokens === null || tb.tokens === 0) return `${score}.`;
  const change = Math.round(((ta.tokens - tb.tokens) / tb.tokens) * 100);
  if (change === 0) return `${score}, on about the same number of tokens.`;
  return `${score}, and ${labels[a]} used ${Math.abs(change)}% ${change < 0 ? "fewer" : "more"} tokens.`;
}

export function stoppedText(status: number, code: string): string {
  if (status === 503 && code === "storage_full") {
    return "Urai's storage is full for now; nothing was charged. The answers already back are above. Try again later, or open a saved report: each one ran every case.";
  }
  if (status === 429 && code === "rate_limited") {
    return "This network has used its live demo calls for the hour, so the run stopped there. The answers already back are above. Try again in an hour, or open a saved report: each one ran every case.";
  }
  if (status === 404) {
    return "Urai no longer recognises this run from this tab. Only the tab that started a demo run can drive it, and demo runs are kept for a short time. Start a new run to try again.";
  }
  return `Urai refused the next call (${code}), so the run stopped there and nothing more was spent. Start a new run, or open a saved report.`;
}

/*
 * What the visitor sees once the calls stop: the verdict with the published report, or a calm
 * explanation and a next step. Never a blank space where the run used to be.
 */
export function Outcome({ finish, sample, samples, configs, totals, onReset, onRetryShare, onResume }: OutcomeProps) {
  const labels = configLabels(configs);
  if (finish.kind === "outage") {
    return (
      <Panel label="Run paused">
        <p className={s.marker}>
          <Slash className={s.markerSlash} />
          Run paused
        </p>
        <h2 className={s.outcomeTitle}>SERV is not answering right now.</h2>
        <p className={s.outcomeText}>
          Three calls in a row either never reached SERV or came back with no answer, so the run paused instead of
          filling up with failures. Nothing was charged for the calls that did not reach SERV, and the{" "}
          {finish.waiting} {finish.waiting === 1 ? "call" : "calls"} not yet run are waiting. Press Resume in a few
          minutes.
        </p>
        <div className={s.actions}>
          <button type="button" className={s.primary} onClick={onResume}>
            <span>Resume</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </button>
          <button type="button" className={s.secondary} onClick={onReset}>
            <Slash className={s.secondarySlash} />
            <span>Pick another sample</span>
          </button>
        </div>
        <SavedReports samples={samples} />
      </Panel>
    );
  }

  if (finish.kind === "budget") {
    return (
      <Panel label="Demo budget">
        <p className={s.marker}>
          <Slash className={s.markerSlash} />
          Demo budget
        </p>
        <h2 className={s.outcomeTitle}>The demo budget is used up for now.</h2>
        <p className={s.outcomeText}>
          The live demo runs on our own SERV key under a small daily cap, which is why nobody needs a key to try it.
          The cap is spent for now, so new live runs are paused.
          {finish.answered > 0 && " The answers that came back before it ran out are above."} Meanwhile, these saved
          reports are full runs of the same samples, open to everyone.
        </p>
        <SavedReports samples={samples} />
      </Panel>
    );
  }

  if (finish.kind === "stopped") {
    return (
      <Panel label="Run stopped">
        <p className={s.marker}>
          <Slash className={s.markerSlash} />
          Run stopped
        </p>
        <h2 className={s.outcomeTitle}>The run stopped early.</h2>
        <p className={s.outcomeText}>{stoppedText(finish.status, finish.code)}</p>
        <div className={s.actions}>
          <button type="button" className={s.primary} onClick={onReset}>
            <span>Start a new run</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </button>
        </div>
        <SavedReports samples={samples} />
      </Panel>
    );
  }

  return (
    <Panel label="The verdict">
      <div className={s.outcomeGrid}>
        <div>
          <p className={s.marker}>
            <Slash className={s.markerSlash} />
            The verdict
          </p>
          <h2 className={s.outcomeTitle}>Every answer is back.</h2>
          <p className={s.outcomeSentence}>{verdictSentence(configs, totals)}</p>
          <p className={s.outcomeTokens}>
            <span>Tokens, input plus output</span>
            {labels.map((label, k) => (
              <span key={k}>
                {label} {totals[k]!.tokens === null ? "unknown" : NUMBER.format(totals[k]!.tokens!)}
              </span>
            ))}
          </p>
          <p className={s.outcomeText}>
            Same cases, same model, {labels.join(" against ")}. The full report shows each answer next to the one it
            should have been, and every case where the settings disagree.
          </p>
        </div>
        <div className={s.verdicts}>
          {labels.map((label, k) => (
            <Verdict key={k} label={label} totals={totals[k]!} />
          ))}
        </div>
      </div>

      {finish.kind === "share_failed" && (
        <p className={s.notice} role="alert">
          Every answer is back, but the report could not be published ({finish.code}). Your answers are safe on the
          server. Press Publish the report to try again.
        </p>
      )}

      <div className={s.actions}>
        {finish.kind === "done" && (
          <Link href={`/r/${finish.reportId}`} className={s.primary}>
            <span>Open the full report</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </Link>
        )}
        {finish.kind === "sharing" && (
          <button type="button" className={s.primary} disabled>
            <span className={s.spinner} aria-hidden="true" />
            <span>Publishing the report</span>
          </button>
        )}
        {finish.kind === "share_failed" && (
          <button type="button" className={s.primary} onClick={onRetryShare}>
            <span>Publish the report</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </button>
        )}
        <button type="button" className={s.secondary} onClick={onReset}>
          <Slash className={s.secondarySlash} />
          <span>Run another sample</span>
        </button>
        {sample.saved !== null && (
          <Link href={`/r/${sample.saved.reportId}`} className={s.textLink}>
            <span>Compare with the saved {sample.saved.cases}-case run</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </Link>
        )}
        <Link href="/new" className={s.secondary}>
          <Slash className={s.secondarySlash} />
          <span>Test your agent</span>
        </Link>
      </div>
    </Panel>
  );
}
