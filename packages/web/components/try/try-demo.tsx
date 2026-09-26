"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Slash } from "../brand/slash";
import { usePrefersReducedMotion } from "../reduced-motion";
import { createDemoRun, rememberOwnerToken, runDemoCase, shareRun, wait, type CreateOutcome, type DemoRun } from "./api";
import { columnTotals, LiveGrid, type Cell } from "./live-grid";
import { Outcome, type Finish } from "./outcome";
import { SamplePicker } from "./sample-picker";
import s from "./try.module.css";
import type { SampleChoice } from "./types";

// One under the server's per-run cap of four, so a call that is slow to release its claim never trips run_busy.
const IN_FLIGHT = 3;
// This many calls in a row that never reached SERV or came back empty reads as an outage, so the run pauses.
const OUTAGE_STREAK = 3;
// A call SERV could not take goes to the back of the queue after this wait, so a busy SERV is not asked again at once.
const UNAVAILABLE_BACKOFF_MS = 4_000;

type Stage =
  | { kind: "pick"; starting: boolean; error: Exclude<CreateOutcome, { kind: "created" }> | null }
  | { kind: "live"; run: DemoRun; sample: SampleChoice; startedAt: number; endedAt: number | null; finish: Finish | null };

function setCell(cells: Cell[][], row: number, col: number, cell: Cell): Cell[][] {
  return cells.map((r, i) => (i === row ? r.map((c, k) => (k === col ? cell : c)) : r));
}

export interface TryDemoProps {
  samples: SampleChoice[];
  cases: number;
}

/*
 * The live demo. Creates a demo run on the chosen sample, then drives every case under every
 * setting with at most IN_FLIGHT calls open, and publishes the report when the last answer lands.
 * No SERV key is asked for or sent anywhere on this page: the operator's key pays, server-side.
 * Three calls in a row that SERV could not take pause the run, so an outage does not spend the demo
 * budget on failures; Resume sends only the calls still waiting.
 */
export function TryDemo({ samples, cases }: TryDemoProps) {
  const firstOpen = samples.find((x) => x.configs.length > 0)?.workloadId ?? null;
  const [selected, setSelected] = useState<string | null>(firstOpen);
  const [stage, setStage] = useState<Stage>({ kind: "pick", starting: false, error: null });
  const [cells, setCells] = useState<Cell[][]>([]);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  // The driver reads the grid between awaits, so it keeps its own copy rather than a stale render's.
  const cellsRef = useRef<Cell[][]>([]);
  const reduced = usePrefersReducedMotion();

  const update = useCallback((next: (c: Cell[][]) => Cell[][]) => {
    cellsRef.current = next(cellsRef.current);
    setCells(cellsRef.current);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ticking = stage.kind === "live" && stage.endedAt === null;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  // A ref callback rather than an effect: the live section only mounts once the picker has finished leaving.
  const showLive = useCallback(
    (node: HTMLElement | null) => {
      node?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    },
    [reduced],
  );

  const publish = useCallback(async (run: DemoRun) => {
    setStage((st) => (st.kind === "live" ? { ...st, finish: { kind: "sharing" } } : st));
    const shared = await shareRun(run);
    setStage((st) =>
      st.kind === "live" && st.run.runId === run.runId
        ? { ...st, finish: shared.kind === "shared" ? { kind: "done", reportId: shared.reportId } : { kind: "share_failed", code: shared.code } }
        : st,
    );
  }, []);

  // Sends every call still waiting in the grid. Used for the first pass and for each Resume.
  const drive = useCallback(
    async (run: DemoRun, ctrl: AbortController) => {
      // Case by case, both settings of a case next to each other, so the rows fill top to bottom.
      const jobs: { caseId: string; row: number; col: number }[] = [];
      cellsRef.current.forEach((r, row) =>
        r.forEach((cell, col) => {
          if (cell.kind === "pending") jobs.push({ caseId: run.cases[row]!, row, col });
        }),
      );
      // One object the workers share. Plain lets would be narrowed by TypeScript as if the workers never wrote them.
      const tally = {
        next: 0,
        budgetHit: false,
        answered: 0,
        stopped: null as { status: number; code: string } | null,
        streak: 0,
        outage: false,
      };
      const unreached = (): void => {
        tally.streak += 1;
        if (tally.streak >= OUTAGE_STREAK) tally.outage = true;
      };

      const worker = async (): Promise<void> => {
        while (!tally.budgetHit && tally.stopped === null && !tally.outage && !ctrl.signal.aborted) {
          const job = jobs[tally.next];
          if (job === undefined) return;
          tally.next += 1;
          update((c) => setCell(c, job.row, job.col, { kind: "running", since: Date.now() }));
          const out = await runDemoCase(run, job.caseId, job.col, ctrl.signal);
          if (ctrl.signal.aborted) return;
          switch (out.kind) {
            case "result":
              tally.answered += 1;
              update((c) => setCell(c, job.row, job.col, { kind: "done", view: out.view }));
              if (out.view.status === "upstream_error" || out.view.status === "timeout") unreached();
              else tally.streak = 0;
              break;
            case "failed":
              update((c) => setCell(c, job.row, job.col, { kind: "failed", code: out.code }));
              break;
            case "unavailable":
              update((c) => setCell(c, job.row, job.col, { kind: "pending" }));
              unreached();
              jobs.push(job);
              await wait(UNAVAILABLE_BACKOFF_MS, ctrl.signal);
              break;
            case "budget":
              tally.budgetHit = true;
              update((c) => setCell(c, job.row, job.col, { kind: "skipped" }));
              break;
            case "fatal":
              tally.stopped = { status: out.status, code: out.code };
              update((c) => setCell(c, job.row, job.col, { kind: "skipped" }));
              break;
          }
        }
      };
      await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
      if (ctrl.signal.aborted) return;

      const endedAt = Date.now();
      setNow(endedAt);
      const { budgetHit, answered, stopped, outage } = tally;
      const waiting = cellsRef.current.flat().filter((c) => c.kind === "pending").length;
      // The streak can end on the very last call, and then there is nothing left to resume.
      if (outage && !budgetHit && stopped === null && waiting > 0) {
        setStage((st) => (st.kind === "live" ? { ...st, endedAt, finish: { kind: "outage", waiting } } : st));
        return;
      }
      update((c) => c.map((r) => r.map((cell) => (cell.kind === "pending" ? { kind: "skipped" } : cell))));
      if (budgetHit || stopped !== null) {
        const finish: Finish = budgetHit || stopped === null ? { kind: "budget", answered } : { kind: "stopped", ...stopped };
        setStage((st) => (st.kind === "live" ? { ...st, endedAt, finish } : st));
        return;
      }
      setStage((st) => (st.kind === "live" ? { ...st, endedAt } : st));
      await publish(run);
    },
    [update, publish],
  );

  const start = useCallback(async () => {
    const sample = samples.find((x) => x.workloadId === selected);
    if (sample === undefined || sample.configs.length === 0) return;
    setStage({ kind: "pick", starting: true, error: null });

    const created = await createDemoRun(sample.workloadId, sample.configs);
    if (created.kind !== "created") {
      setStage({ kind: "pick", starting: false, error: created });
      return;
    }
    const run = created.run;
    rememberOwnerToken(run);

    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    update(() => run.cases.map(() => run.configs.map((): Cell => ({ kind: "pending" }))));
    setNow(Date.now());
    setStage({ kind: "live", run, sample, startedAt: Date.now(), endedAt: null, finish: null });
    await drive(run, ctrl);
  }, [samples, selected, update, drive]);

  // The clock skips the paused stretch, so it only counts the time calls were actually out.
  const resume = useCallback(
    async (run: DemoRun) => {
      const ctrl = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ctrl;
      const at = Date.now();
      setNow(at);
      setStage((st) =>
        st.kind === "live" && st.run.runId === run.runId
          ? { ...st, startedAt: st.startedAt + (at - (st.endedAt ?? at)), endedAt: null, finish: null }
          : st,
      );
      await drive(run, ctrl);
    },
    [drive],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    update(() => []);
    setStage({ kind: "pick", starting: false, error: null });
    window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [reduced, update]);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait" initial={false}>
        {stage.kind === "pick" ? (
          <motion.div key="pick" exit={{ opacity: 0, y: -24 }} transition={{ duration: 0.45, ease: [0.7, 0, 0.84, 0] }}>
            <SamplePicker
              samples={samples}
              cases={cases}
              selected={selected}
              onSelect={setSelected}
              onStart={() => void start()}
              starting={stage.starting}
              startError={stage.error}
            />
          </motion.div>
        ) : (
          <motion.section
            key={stage.run.runId}
            ref={showLive}
            className={`${s.section} ${s.liveSection}`}
            aria-labelledby="live-title"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className={s.marker}>
              {stage.endedAt === null ? (
                <span className={s.live}>
                  <span className={s.liveDot} aria-hidden="true" />
                  Live now
                </span>
              ) : (
                <>
                  <Slash className={s.markerSlash} />
                  <span>{stage.finish?.kind === "outage" ? "Run paused" : "Run finished"}</span>
                </>
              )}
            </p>
            <LiveGrid
              title={stage.sample.name}
              cases={stage.run.cases}
              configs={stage.run.configs}
              cells={cells}
              expected={stage.sample.expected}
              now={now}
              elapsedMs={(stage.endedAt ?? now) - stage.startedAt}
              running={stage.endedAt === null}
            />
            {stage.finish !== null && (
              <Outcome
                finish={stage.finish}
                sample={stage.sample}
                samples={samples}
                configs={stage.run.configs}
                totals={stage.run.configs.map((_, k) => columnTotals(cells, k))}
                onReset={reset}
                onRetryShare={() => void publish(stage.run)}
                onResume={() => void resume(stage.run)}
              />
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
