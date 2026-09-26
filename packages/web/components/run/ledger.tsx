"use client";

import { motion } from "motion/react";
import type { ConfigTotals, Report } from "../../lib/report";
import { measuredDrop, tokenCost, usd } from "../report/format";
import { Slash } from "../brand/slash";
import { useCountUp } from "../try/count-up";
import s from "./run.module.css";

// Rounded to four places while it counts, so the climbing figure never shows float noise.
function CountedUsd({ value }: { value: number }) {
  const shown = useCountUp(value, 0, 1400);
  return <dd>{usd(Math.round(shown * 10_000) / 10_000)}</dd>;
}

function costNote(total: number | null, drop: number | null): string {
  const base =
    total === null
      ? "SERV did not send token counts for every call, so the full cost cannot be worked out. A setting reading unknown is one with a missing count."
      : "Worked out from the tokens SERV reports for each call, at the higher of Urai's own price and SERV's live price for the model. It is an upper estimate: SERV's cache discounts can make the real charge lower, and on our sample runs the real balance drop was about two thirds of it. SERV's one-off charge for building the reasoning graph of a system prompt it has not seen is not in the token counts.";
  return drop === null
    ? base
    : `${base} The measured drop is the real change in the key's SERV balance across this run, read before SERV stopped offering a free balance read on 25 Sep.`;
}

export interface LedgerProps {
  labels: string[];
  /** Null while the run is live: the cost comes from the report once every answer is back. */
  totals: ConfigTotals[] | null;
  balance: Report["balance"];
}

/*
 * What the run cost, set like a till receipt in the margin: one line per setting, then the total,
 * all from SERV's own token counts. A run that stored two real balance readings also shows the
 * measured drop, as a second, independent figure.
 */
export function Ledger({ labels, totals, balance }: LedgerProps) {
  const total = totals === null ? null : tokenCost(totals);
  const drop = measuredDrop(balance);
  return (
    <motion.aside
      className={s.ledger}
      aria-label="What this run cost"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, delay: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      <p className={s.ledgerTitle}>
        <Slash className={s.markerSlash} />
        Estimated cost from SERV&apos;s token counts
      </p>
      <dl className={s.ledgerRows}>
        {labels.map((label, i) => {
          const cost = totals?.[i]?.estCostUsd ?? null;
          return (
            <div key={i} className={s.ledgerRow}>
              <dt>{label}</dt>
              {totals === null ? <dd data-muted="true">When the run ends</dd> : <dd data-muted={cost === null}>{usd(cost)}</dd>}
            </div>
          );
        })}
        {totals !== null && (
          <div className={`${s.ledgerRow} ${s.ledgerSpent}`}>
            <dt>Total</dt>
            {total === null ? <dd data-muted="true">unknown</dd> : <CountedUsd value={total} />}
          </div>
        )}
        {drop !== null && (
          <div className={`${s.ledgerRow} ${s.ledgerSpent}`} data-small="true">
            <dt>Measured drop</dt>
            <CountedUsd value={drop} />
          </div>
        )}
      </dl>
      <p className={s.ledgerNote}>
        {totals === null
          ? "Worked out from the tokens SERV reports for each call, at the higher of Urai's own price and SERV's live price for the model. It appears here with the report, once the last answer is back."
          : costNote(total, drop)}
      </p>
    </motion.aside>
  );
}
