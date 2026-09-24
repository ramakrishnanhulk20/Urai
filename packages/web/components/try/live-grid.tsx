"use client";

import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";
import { Slash } from "../brand/slash";
import type { CaseStatus, CaseView } from "./api";
import { useCountUp } from "./count-up";
import s from "./try.module.css";
import { configLabel, type DemoConfig } from "./types";

export type Cell =
  | { kind: "pending" }
  | { kind: "running"; since: number }
  | { kind: "done"; view: CaseView }
  | { kind: "failed"; code: string }
  | { kind: "skipped" };

export interface ColumnTotals {
  /** Answers the server returned, in any status. */
  back: number;
  right: number;
  /** Everything that came back and is not right: wrong verdicts plus refused, filtered, unreadable. */
  wrong: number;
  /** right / back, the same rule the report uses. Null until something is back. */
  accuracy: number | null;
}

export function columnTotals(cells: Cell[][], col: number): ColumnTotals {
  let back = 0;
  let right = 0;
  for (const row of cells) {
    const cell = row[col];
    if (cell?.kind !== "done") continue;
    back += 1;
    if (cell.view.correct) right += 1;
  }
  return { back, right, wrong: back - right, accuracy: back === 0 ? null : right / back };
}

// Plain words for every way a call can end without a verdict.
const STATUS_WORDS: Record<Exclude<CaseStatus, "scored">, string> = {
  failed: "Unreadable",
  refused: "Refused",
  filtered: "Filtered",
  upstream_error: "No answer",
  timeout: "Timed out",
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function CellBody({ cell, now }: { cell: Cell; now: number }) {
  switch (cell.kind) {
    case "pending":
      return (
        <span className={s.cellMain}>
          <span>Waiting</span>
        </span>
      );
    case "skipped":
      return (
        <span className={s.cellMain}>
          <span>Not run</span>
        </span>
      );
    case "running":
      return (
        <>
          <span className={s.cellMain}>
            <span>Reading</span>
          </span>
          <span className={s.cellMeta}>{Math.max(0, Math.floor((now - cell.since) / 1000))} s so far</span>
        </>
      );
    case "failed":
      return (
        <>
          <span className={s.cellMain}>
            <span>Call failed</span>
          </span>
          <span className={s.cellMeta}>{cell.code.replaceAll("_", " ")}</span>
        </>
      );
    case "done": {
      const { view } = cell;
      const latency = view.latencyMs === null ? null : seconds(view.latencyMs);
      if (view.status !== "scored") {
        return (
          <>
            <span className={s.cellMain}>
              <span>{STATUS_WORDS[view.status]}</span>
            </span>
            <span className={s.cellMeta}>{latency ?? "no timing"}</span>
          </>
        );
      }
      return (
        <>
          <span className={s.cellMain}>
            <span>{view.verdict ?? "answered"}</span>
          </span>
          <span className={s.cellMeta}>
            {view.correct ? "Right" : "Wrong"}
            {latency !== null && ` / ${latency}`}
          </span>
          {view.correct ? (
            <motion.span
              className={s.stamp}
              initial={{ opacity: 0, scale: 2.2, rotate: -18 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ duration: 0.5, ease: [0.2, 1.4, 0.4, 1] }}
              aria-hidden="true"
            >
              <Slash className={s.stampMark} />
            </motion.span>
          ) : (
            <motion.span
              className={s.cross}
              initial={{ opacity: 0, scaleX: 0 }}
              animate={{ opacity: 1, scaleX: 1 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden="true"
            />
          )}
        </>
      );
    }
  }
}

function cellState(cell: Cell): string {
  if (cell.kind !== "done") return cell.kind === "failed" ? "other" : cell.kind;
  if (cell.view.status !== "scored") return "other";
  return cell.view.correct ? "right" : "wrong";
}

function Board({ label, totals, cases }: { label: string; totals: ColumnTotals; cases: number }) {
  const shown = useCountUp(totals.right, 0);
  return (
    <div className={s.board}>
      <p className={s.boardLabel}>{label}</p>
      <p className={s.boardNumber} aria-label={`${totals.right} right of ${cases}`}>
        {Math.round(shown)}
        <span className={s.boardOf}>/ {cases} right</span>
      </p>
      <div className={s.boardTrack} aria-hidden="true">
        <div className={s.boardFill} style={{ "--fill": totals.right / cases } as CSSProperties} />
      </div>
      <p className={s.boardStats}>
        <span>{totals.back} back</span>
        <span className={s.right}>{totals.right} right</span>
        <span className={s.wrong}>{totals.wrong} wrong</span>
      </p>
    </div>
  );
}

export interface LiveGridProps {
  title: string;
  cases: string[];
  configs: DemoConfig[];
  cells: Cell[][];
  expected: Record<string, string>;
  now: number;
  elapsedMs: number;
  running: boolean;
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/*
 * The run as it happens: a scoreboard per setting that climbs as answers land, then one row per
 * case with a cell per setting. Cells go from waiting to a gold pulse while the model reads, then
 * teal for right or slate for wrong. Every word in a cell is React text, never HTML.
 */
export function LiveGrid({ title, cases, configs, cells, expected, now, elapsedMs, running }: LiveGridProps) {
  const totals = configs.map((_, k) => columnTotals(cells, k));
  const calls = cases.length * configs.length;
  const settled = cells.flat().filter((c) => c.kind === "done" || c.kind === "failed").length;

  return (
    <>
      <div className={s.liveHead}>
        <h2 id="live-title" className={s.liveTitle}>
          {title}
        </h2>
        <p className={s.progress}>
          <span className={s.progressCount} aria-live="polite">
            {settled}
            <small> / {calls}</small>
          </span>
          <span>
            answers back / {clock(elapsedMs)}
          </span>
        </p>
      </div>

      <div className={s.boards} style={{ "--cols": configs.length } as CSSProperties}>
        {configs.map((config, k) => (
          <Board key={k} label={configLabel(config)} totals={totals[k]!} cases={cases.length} />
        ))}
      </div>

      <AnimatePresence initial={false}>
        {running && (
          <motion.p
            className={s.waitNote}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.5 }}
          >
            <span className={s.liveDot} aria-hidden="true" />
            <span>
              Each call takes about 5 to 15 seconds, because the model really reads the whole rulebook before it answers.
              Three run at once, so the rows fill in a wave.
            </span>
          </motion.p>
        )}
      </AnimatePresence>

      <table className={s.table}>
        <caption>Live answers, one row per case, one column per setting</caption>
        <colgroup>
          <col className={s.colCase} />
          {configs.map((_, k) => (
            <col key={k} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Case</th>
            {configs.map((config, k) => (
              <th key={k} scope="col">
                {configLabel(config)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cases.map((caseId, i) => (
            <motion.tr
              key={caseId}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: Math.min(i, 12) * 0.04, ease: [0.16, 1, 0.3, 1] }}
            >
              <th scope="row" className={s.caseHead}>
                <span className={s.caseId}>{caseId}</span>
                {expected[caseId] !== undefined && (
                  <span className={s.should}>
                    should <b>{expected[caseId]}</b>
                  </span>
                )}
              </th>
              {configs.map((_, k) => {
                const cell = cells[i]?.[k] ?? { kind: "pending" };
                return (
                  <td key={k}>
                    <div className={s.cell} data-state={cellState(cell)}>
                      <CellBody cell={cell} now={now} />
                    </div>
                  </td>
                );
              })}
            </motion.tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
