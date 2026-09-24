"use client";

import type { RunConfig } from "@urai/engine";
import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { Slash } from "../brand/slash";
import { clip, configLabels, seconds, splitName, valueText } from "../report/format";
import { useCountUp } from "../try/count-up";
import type { Answer } from "./api";
import { Ledger, type BalanceView } from "./ledger";
import s from "./run.module.css";

const EASE = [0.16, 1, 0.3, 1] as const;

export type Cell =
  | { kind: "pending" }
  | { kind: "running"; since: number }
  | { kind: "done"; answer: Answer }
  | { kind: "failed"; code: string };

export interface GridCase {
  id: string;
  /** The first field the case is scored on, shown as the answer in each cell. Null when the case has none. */
  field: string | null;
  expected: string | null;
}

export interface Totals {
  back: number;
  right: number;
}

export function totalsFor(cells: Cell[][], col: number): Totals {
  let back = 0;
  let right = 0;
  for (const row of cells) {
    const cell = row[col];
    if (cell?.kind !== "done") continue;
    back += 1;
    if (cell.answer.correct) right += 1;
  }
  return { back, right };
}

// Plain words for every way a call can end without a scored answer.
const STATUS_WORDS: Record<Exclude<Answer["status"], "scored">, string> = {
  failed: "Unreadable",
  refused: "Refused",
  filtered: "Filtered",
  upstream_error: "No response",
  timeout: "Timed out",
};

function cellState(cell: Cell): string {
  if (cell.kind === "failed") return "other";
  if (cell.kind !== "done") return cell.kind;
  if (cell.answer.status !== "scored") return "other";
  return cell.answer.correct ? "right" : "wrong";
}

function CellBody({ cell, field, now }: { cell: Cell; field: string | null; now: number }) {
  switch (cell.kind) {
    case "pending":
      return (
        <span className={s.cellMain}>
          <span>Waiting</span>
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
            <span>Did not come back</span>
          </span>
          <span className={s.cellMeta}>{cell.code.replaceAll("_", " ")}</span>
        </>
      );
    case "done": {
      const { answer } = cell;
      const latency = answer.latencyMs === null ? null : seconds(answer.latencyMs);
      if (answer.status !== "scored") {
        return (
          <>
            <span className={s.cellMain}>
              <span>{STATUS_WORDS[answer.status]}</span>
            </span>
            <span className={s.cellMeta}>{latency ?? "no timing"}</span>
          </>
        );
      }
      const said = field !== null && answer.answer !== null ? clip(valueText(answer.answer[field]), 28) : "Answered";
      return (
        <>
          <span className={s.cellMain}>
            <span>{said}</span>
          </span>
          <span className={s.cellMeta}>
            {answer.correct ? "Right" : "Wrong"}
            {latency !== null && ` / ${latency}`}
          </span>
          {answer.correct ? (
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
              transition={{ duration: 0.4, ease: EASE }}
              aria-hidden="true"
            />
          )}
        </>
      );
    }
  }
}

function Board({ label, model, totals, cases, index }: { label: string; model: string; totals: Totals; cases: number; index: number }) {
  const shown = useCountUp(totals.right, 0);
  return (
    <motion.div
      className={s.board}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.25 + index * 0.08, ease: EASE }}
    >
      <p className={s.boardLabel}>
        <span>{label}</span>
        <span className={s.boardModel}>{model}</span>
      </p>
      <p className={s.boardNumber} aria-label={`${totals.right} right of ${cases}`}>
        {Math.round(shown)}
        <span className={s.boardOf}>/ {cases} right</span>
      </p>
      <div className={s.boardTrack} aria-hidden="true">
        <div className={s.boardFill} style={{ "--fill": cases === 0 ? 0 : totals.right / cases } as CSSProperties} />
      </div>
      <p className={s.boardStats}>
        <span>{totals.back} back</span>
        <span className={s.right}>{totals.right} right</span>
        <span className={s.wrong}>{totals.back - totals.right} wrong</span>
      </p>
    </motion.div>
  );
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export type LiveStage = "running" | "pausing" | "paused" | "incomplete" | "closing";

export interface RunGridProps {
  title: string;
  configs: RunConfig[];
  cases: GridCase[];
  cells: Cell[][];
  now: number;
  elapsedMs: number;
  stage: LiveStage;
  before: BalanceView;
  after: BalanceView;
  /** What the bar says under the current stage, when it has more to say than the default. */
  notice: ReactNode;
  actions: ReactNode;
}

function waitText(stage: LiveStage, inFlight: number): ReactNode {
  switch (stage) {
    case "running":
      return "Each call takes 5 to 60 seconds depending on the SERV setting: SERV off and plain are the quick ones, full mode is the slow one. Up to three calls run at once, so the rows fill in a wave.";
    case "pausing":
      return `Pausing. No new calls go out; the ${inFlight} already with SERV finish first, and their answers are kept.`;
    case "paused":
      return "Paused. Nothing is being sent to SERV. Resume whenever you like; the answers already back are safe.";
    case "incomplete":
      return "Some calls did not come back. Run the missing ones again: Urai never runs a finished call twice, so nothing already answered is paid for again.";
    case "closing":
      return "Every answer is back. Reading SERV's balance once more and building the report.";
  }
}

/*
 * The run as it happens: the title set like poster billing with the balance ledger beside it, a
 * scoreboard per setting that climbs as answers land, the honest wait label with the controls,
 * then one row per case with a cell per setting. Every string from the API or a model is React
 * text, never HTML (C20).
 */
export function RunGrid({ title, configs, cases, cells, now, elapsedMs, stage, before, after, notice, actions }: RunGridProps) {
  const labels = configLabels(configs);
  const { title: main, deck } = splitName(title);
  // One step smaller than the report's poster title: on a working screen the grid should start near the first fold.
  const size = main.length <= 30 ? "medium" : "long";
  const calls = cases.length * configs.length;
  const flat = cells.flat();
  const settled = flat.filter((c) => c.kind === "done").length;
  const inFlight = flat.filter((c) => c.kind === "running").length;
  const models = [...new Set(configs.map((c) => c.model))];
  const moving = stage === "running" || stage === "pausing" || stage === "closing";

  return (
    <div className={s.liveWrap}>
      <div className={s.head}>
        <div>
          <p className={`${s.marker} ${s.enter}`}>
            <span className={s.live}>
              <span className={s.liveDot} data-still={!moving} aria-hidden="true" />
              {stage === "paused" ? "Run paused" : stage === "incomplete" ? "Run stopped short" : "Live run"}
            </span>
          </p>
          <p className={`${s.meta} ${s.enter}`} style={{ animationDelay: "0.08s" }}>
            {[`${cases.length} ${cases.length === 1 ? "case" : "cases"}`, labels.join(" vs "), models.join(", "), "Your SERV key"].map(
              (item, i) => (
                <span key={i} className={s.metaItem}>
                  {i > 0 && <Slash className={s.metaSlash} />}
                  {item}
                </span>
              ),
            )}
          </p>
          <h1 className={s.title} data-size={size}>
            <span className={s.line}>
              <span className={s.rise} style={{ animationDelay: "0.15s" }}>
                {main}
              </span>
            </span>
          </h1>
          {deck !== null && (
            <p className={`${s.deck} ${s.enter}`} style={{ animationDelay: "0.3s" }}>
              {deck}
            </p>
          )}
        </div>
        <Ledger before={before} after={after} />
      </div>

      <div className={s.boards} data-many={configs.length > 3} style={{ "--cols": configs.length } as CSSProperties}>
        {configs.map((config, k) => (
          <Board key={k} index={k} label={labels[k]!} model={config.model} totals={totalsFor(cells, k)} cases={cases.length} />
        ))}
      </div>

      <motion.div
        className={s.bar}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.45, ease: EASE }}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={stage}
            className={s.waitNote}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35 }}
            aria-live="polite"
          >
            <span className={s.liveDot} data-still={!moving} aria-hidden="true" />
            <span>{waitText(stage, inFlight)}</span>
          </motion.p>
        </AnimatePresence>
        <div className={s.barSide}>
          <p className={s.progress}>
            <span className={s.progressCount}>
              {settled}
              <small> / {calls}</small>
            </span>
            <span>answers back / {clock(elapsedMs)}</span>
          </p>
          {actions}
        </div>
      </motion.div>

      {notice}

      <div className={s.gridWrap} data-lenis-prevent-touch="">
        <table className={s.table} style={{ "--cols": configs.length } as CSSProperties}>
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
              {labels.map((label, k) => (
                <th key={k} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cases.map((c, i) => (
              <motion.tr
                key={c.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, delay: 0.5 + Math.min(i, 12) * 0.04, ease: EASE }}
              >
                <th scope="row" className={s.caseHead}>
                  <span className={s.caseId} title={c.id}>
                    {c.id}
                  </span>
                  {c.expected !== null && (
                    <span className={s.should}>
                      should <b>{c.expected}</b>
                    </span>
                  )}
                </th>
                {configs.map((_, k) => {
                  const cell = cells[i]?.[k] ?? { kind: "pending" };
                  return (
                    <td key={k}>
                      <div className={s.cell} data-state={cellState(cell)}>
                        <CellBody cell={cell} field={c.field} now={now} />
                      </div>
                    </td>
                  );
                })}
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
