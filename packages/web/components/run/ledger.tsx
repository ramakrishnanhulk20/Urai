"use client";

import { motion } from "motion/react";
import { usd } from "../report/format";
import { Slash } from "../brand/slash";
import { useCountUp } from "../try/count-up";
import s from "./run.module.css";

export type BalanceView = { kind: "usd"; usd: number } | { kind: "reading" } | { kind: "later" } | { kind: "none"; why: string };

function Value({ view }: { view: BalanceView }) {
  switch (view.kind) {
    case "usd":
      return <dd>{usd(view.usd)}</dd>;
    case "reading":
      return <dd data-muted="true">Reading SERV</dd>;
    case "later":
      return <dd data-muted="true">When the run ends</dd>;
    case "none":
      return <dd data-muted="true">Not measured</dd>;
  }
}

// The smallest change SERV's balance can show, read from how many decimals it reports: $3.32 means cents.
function balanceStep(before: number, after: number): number {
  const places = (n: number): number => {
    const text = String(n);
    const dot = text.indexOf(".");
    return dot === -1 ? 0 : text.length - dot - 1;
  };
  return Math.pow(10, -Math.max(2, places(before), places(after)));
}

function Spent({ before, after }: { before: number; after: number }) {
  const spent = before - after;
  const shown = useCountUp(Math.max(0, spent), 0, 1400);
  const step = balanceStep(before, after);
  let text: string;
  if (spent < 0) text = "n/a";
  else if (spent < step / 2) text = `Under ${usd(step)}`;
  else text = usd(Math.round(shown * 10_000) / 10_000);
  return (
    <div className={`${s.ledgerRow} ${s.ledgerSpent}`} data-small={spent >= 0 && spent < step / 2}>
      <dt>Realised spend</dt>
      <dd>{text}</dd>
    </div>
  );
}

function spendNote(before: BalanceView, after: BalanceView): string {
  if (before.kind === "usd" && after.kind === "usd") {
    if (after.usd > before.usd) return "The balance went up during the run, most likely a top-up, so the spend cannot be read from it.";
    const step = balanceStep(before.usd, after.usd);
    if (before.usd - after.usd < step / 2) {
      return `SERV shows the balance in steps of ${usd(step)} and it did not move, so this run cost less than that. The report's per-setting costs are the finer estimate.`;
    }
    return "Measured by SERV's own balance for your key: before the first call minus after the last. Anything else spent on the same key in the meantime is counted too.";
  }
  if (before.kind === "none") return before.why;
  if (after.kind === "none") return after.why;
  return "Read from SERV's own balance for your key, once before the first call and once after the last. Reading it costs nothing.";
}

/*
 * What SERV's balance said before and after, set like a till receipt in the margin. The spend is
 * the difference of two real readings, never an estimate; with either reading missing it says
 * why instead of showing a number.
 */
export function Ledger({ before, after }: { before: BalanceView; after: BalanceView }) {
  const both = before.kind === "usd" && after.kind === "usd";
  return (
    <motion.aside
      className={s.ledger}
      aria-label="SERV balance"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <p className={s.ledgerTitle}>
        <Slash className={s.markerSlash} />
        SERV balance
      </p>
      <dl className={s.ledgerRows}>
        <div className={s.ledgerRow}>
          <dt>Before</dt>
          <Value view={before} />
        </div>
        <div className={s.ledgerRow}>
          <dt>After</dt>
          <Value view={after} />
        </div>
        {both && <Spent before={before.usd} after={after.usd} />}
      </dl>
      <p className={s.ledgerNote}>{spendNote(before, after)}</p>
    </motion.aside>
  );
}
