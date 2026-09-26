"use client";

import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Report } from "../../lib/report";
import {
  clearTeamKey,
  forgetOwnerToken,
  getTeamKey,
  openedFromLink,
  privateRunLink,
  readOwnerToken,
  stripOwnerHash,
  takeOwnerTokenFromHash,
} from "../app/session";
import { Slash } from "../brand/slash";
import { configLabels, expectedText, hasManyModels, isTruncated, splitName } from "../report/format";
import { fromReport, getReport, getStatus, runCase, shareRun, unshareRun, wait, type Fail } from "./api";
import { Finished, type ShareState } from "./finished";
import { RunGrid, type Cell, type GridCase, type LiveStage } from "./run-grid";
import s from "./run.module.css";
import { KeyForm, LinkConfirm, LoadFailed, Loading, NoToken, PrivateLink, type KeyNotice, type LoadProblem } from "./states";

// One under the server's per-run cap of four, so a call that is slow to release its claim never trips run_busy.
const IN_FLIGHT = 3;
// This many calls in a row that never reached SERV or came back empty reads as an outage, not bad luck.
const OUTAGE_STREAK = 3;
// A call SERV could not take goes to the back of the queue after this wait, so a busy SERV is not asked again at once.
const UNAVAILABLE_BACKOFF_MS = 4_000;
// When to look at the address bar again while Next's router settles after hydration and may rewrite it.
const RESTRIP_MS = [0, 50, 250, 1000, 2500, 5000];

type View =
  | { kind: "checking" }
  | { kind: "no_token" }
  | { kind: "loading" }
  | { kind: "failed"; problem: LoadProblem }
  | { kind: "confirm" }
  | { kind: "key"; notice: KeyNotice }
  | { kind: "live"; stage: LiveStage }
  | { kind: "finished"; report: Report };

type StopNote =
  | { kind: "credits" }
  | { kind: "outage" }
  | { kind: "storage" }
  | { kind: "refusals" }
  | { kind: "missing"; count: number; codes: string[] }
  | null;

type Halt = "refused" | "bad_key" | "gone" | "credits" | "no_key" | "refusal_budget" | "outage" | "storage";

function problemFor(fail: Fail): LoadProblem {
  if (fail.kind === "http" && fail.status === 404) return { kind: "gone" };
  if (fail.kind === "network") return { kind: "unreachable", detail: "no connection" };
  if (fail.kind === "bad_response") return { kind: "unreachable", detail: "an unreadable reply" };
  return { kind: "unreachable", detail: `${fail.status} ${fail.code.replaceAll("_", " ")}` };
}

function gridCases(report: Report): GridCase[] {
  return report.cases.map((c) => {
    const first = Object.entries(c.expected)[0];
    return { id: c.id, field: first?.[0] ?? null, expected: first === undefined ? null : expectedText(first[1]) };
  });
}

function cellsFrom(report: Report): Cell[][] {
  return report.cases.map((c) =>
    c.results.map((r): Cell => {
      const answer = fromReport(r);
      return answer === null ? { kind: "pending" } : { kind: "done", answer };
    }),
  );
}

const allDone = (cells: Cell[][]): boolean => cells.every((row) => row.every((c) => c.kind === "done"));

const callsLeft = (cells: Cell[][]): number => cells.flat().filter((c) => c.kind !== "done").length;

function promptText(prompt: Report["systemPrompt"]): string {
  return isTruncated(prompt) ? prompt.text : prompt;
}

/*
 * The owner's run. Reads the run with the owner token this tab saved or a private run link brought,
 * asks for the key when it is not in memory, drives every unfinished case under every setting with
 * at most IN_FLIGHT calls open, then shows the full report with its cost from SERV's token counts.
 * Urai sends SERV nothing but case calls, so no balance is read (C7). The key is read from session
 * memory for this run id at each call and sent only in the x-serv-key header (C1, C22); nothing here
 * logs it or puts it in state or a URL.
 *
 * A run this tab opened from a private link may belong to someone else, so it first shows what a key
 * would pay for and waits for "This is my run", and after the key it waits for Continue. It is never
 * driven on load. Three calls in a row that SERV could not take pause the run instead of filling it
 * with failures.
 */
export function RunView({ runId }: { runId: string }) {
  const router = useRouter();
  const [view, setView] = useState<View>({ kind: "checking" });
  const [base, setBase] = useState<Report | null>(null);
  const [cells, setCells] = useState<Cell[][]>([]);
  const [stopNote, setStopNote] = useState<StopNote>(null);
  const [share, setShare] = useState<ShareState>({ kind: "unknown" });
  const [keyHeld, setKeyHeld] = useState(false);
  const [refusedCalls, setRefusedCalls] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [link, setLink] = useState<string | null>(null);

  const tokenRef = useRef<string | null>(null);
  const baseRef = useRef<Report | null>(null);
  const cellsRef = useRef<Cell[][]>([]);
  const pauseRef = useRef(false);
  const drivingRef = useRef(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const aliveRef = useRef(true);
  const loadedRef = useRef(false);
  const linkedRef = useRef(false);
  const confirmedRef = useRef(false);
  const linkTokenRef = useRef<string | null>(null);

  const put = useCallback((row: number, col: number, cell: Cell) => {
    cellsRef.current = cellsRef.current.map((r, i) => (i === row ? r.map((c, k) => (k === col ? cell : c)) : r));
    setCells(cellsRef.current);
  }, []);

  const close = useCallback(async () => {
    const token = tokenRef.current;
    if (token === null || !aliveRef.current) return;
    setView({ kind: "live", stage: "closing" });
    const rep = await getReport(runId, token);
    if (!aliveRef.current) return;
    if (!rep.ok) {
      // Calls may have gone to SERV by now, so this failure gets its own words, not the load screen's.
      const problem = problemFor(rep.fail);
      setView({ kind: "failed", problem: problem.kind === "unreachable" ? { kind: "report_unreachable", detail: problem.detail } : problem });
      return;
    }
    setView({ kind: "finished", report: rep.value });
  }, [runId]);

  const drive = useCallback(async () => {
    const token = tokenRef.current;
    const report = baseRef.current;
    if (token === null || report === null || drivingRef.current || !aliveRef.current) return;
    if (getTeamKey(runId) === null) {
      setView({ kind: "key", notice: null });
      return;
    }
    drivingRef.current = true;
    pauseRef.current = false;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setStopNote(null);
    setStartedAt((t) => t ?? Date.now());
    setNow(Date.now());
    setView({ kind: "live", stage: "running" });

    // Case by case, every setting of a case next to each other, so the rows fill top to bottom.
    const jobs: { caseId: string; row: number; col: number }[] = [];
    cellsRef.current.forEach((row, i) =>
      row.forEach((cell, k) => {
        if (cell.kind === "done") return;
        if (cell.kind !== "pending") put(i, k, { kind: "pending" });
        jobs.push({ caseId: report.cases[i]!.id, row: i, col: k });
      }),
    );
    // One object the workers share. Plain lets would be narrowed by TypeScript as if the workers never wrote them.
    const tally = { next: 0, halt: null as Halt | null, refused: 0, missing: [] as string[], streak: 0 };
    // Counts toward the outage pause; a good answer anywhere in the run clears it.
    const unreached = (): void => {
      tally.streak += 1;
      if (tally.streak >= OUTAGE_STREAK) tally.halt ??= "outage";
    };

    const worker = async (): Promise<void> => {
      while (tally.halt === null && !pauseRef.current && !ctrl.signal.aborted && aliveRef.current) {
        const job = jobs[tally.next];
        if (job === undefined) return;
        const key = getTeamKey(runId);
        if (key === null) {
          tally.halt = "no_key";
          return;
        }
        tally.next += 1;
        put(job.row, job.col, { kind: "running", since: Date.now() });
        const out = await runCase(runId, token, key, job.caseId, job.col, ctrl.signal);
        switch (out.kind) {
          case "answer":
            put(job.row, job.col, { kind: "done", answer: out.answer });
            if (out.answer.status === "upstream_error" || out.answer.status === "timeout") unreached();
            else tally.streak = 0;
            if (out.answer.status === "upstream_error" && (out.httpStatus === 401 || out.httpStatus === 403)) {
              tally.refused += 1;
              tally.halt ??= "refused";
            } else if (out.answer.status === "upstream_error" && out.httpStatus === 402) {
              tally.halt ??= "credits";
            }
            break;
          case "bad_key":
            put(job.row, job.col, { kind: "pending" });
            tally.halt ??= "bad_key";
            break;
          case "key_refused":
            put(job.row, job.col, { kind: "pending" });
            tally.halt ??= "refused";
            break;
          case "no_credit":
            put(job.row, job.col, { kind: "pending" });
            tally.halt ??= "credits";
            break;
          case "refusal_budget":
            put(job.row, job.col, { kind: "pending" });
            tally.halt ??= "refusal_budget";
            break;
          case "unavailable":
            put(job.row, job.col, { kind: "pending" });
            unreached();
            jobs.push(job);
            await wait(UNAVAILABLE_BACKOFF_MS, ctrl.signal);
            break;
          case "storage_full":
            put(job.row, job.col, { kind: "pending" });
            tally.halt ??= "storage";
            break;
          case "gone":
            put(job.row, job.col, { kind: "pending" });
            tally.halt = "gone";
            break;
          case "failed":
            put(job.row, job.col, { kind: "failed", code: out.code });
            tally.missing.push(out.code);
            break;
          case "stopped":
            put(job.row, job.col, { kind: "pending" });
            return;
        }
      }
    };
    await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
    drivingRef.current = false;
    if (ctrl.signal.aborted || !aliveRef.current) return;

    switch (tally.halt) {
      case "refused":
        clearTeamKey(runId);
        setKeyHeld(false);
        setRefusedCalls((n) => n + tally.refused);
        // With every call already answered there is nothing left for a new key to run, so the report is shown instead.
        if (allDone(cellsRef.current)) await close();
        else setView({ kind: "key", notice: "refused" });
        return;
      case "bad_key":
        clearTeamKey(runId);
        setKeyHeld(false);
        setView({ kind: "key", notice: "bad_key" });
        return;
      case "no_key":
        setKeyHeld(false);
        setView({ kind: "key", notice: "forgotten" });
        return;
      // The key itself was never judged: the 429 is about this network, so the key stays and the run waits to be resumed.
      case "refusal_budget":
        if (allDone(cellsRef.current)) break;
        setStopNote({ kind: "refusals" });
        setView({ kind: "live", stage: "paused" });
        return;
      case "gone":
        setView({ kind: "failed", problem: { kind: "gone" } });
        return;
      case "credits":
        setStopNote({ kind: "credits" });
        setView({ kind: "live", stage: "paused" });
        return;
      case "storage":
        setStopNote({ kind: "storage" });
        setView({ kind: "live", stage: "paused" });
        return;
      case "outage":
        // The streak can end on the very last call, and then there is nothing left to resume.
        if (allDone(cellsRef.current)) break;
        setStopNote({ kind: "outage" });
        setView({ kind: "live", stage: "paused" });
        return;
      case null:
        break;
    }
    if (pauseRef.current) {
      setView({ kind: "live", stage: "paused" });
      return;
    }
    if (!allDone(cellsRef.current)) {
      setStopNote({ kind: "missing", count: tally.missing.length, codes: [...new Set(tally.missing)] });
      setView({ kind: "live", stage: "incomplete" });
      return;
    }
    await close();
  }, [runId, put, close]);

  const load = useCallback(async () => {
    const fromLink = linkTokenRef.current;
    linkTokenRef.current = null;
    const token = fromLink ?? readOwnerToken(runId);
    linkedRef.current = fromLink !== null || openedFromLink(runId);
    if (token === null) {
      setView({ kind: "no_token" });
      return;
    }
    tokenRef.current = token;
    setLink(privateRunLink(runId, token));
    setView({ kind: "loading" });
    const [status, rep] = await Promise.all([getStatus(runId, token), getReport(runId, token)]);
    if (!aliveRef.current) return;
    if (!status.ok) {
      setView({ kind: "failed", problem: problemFor(status.fail) });
      return;
    }
    if (!rep.ok) {
      setView({ kind: "failed", problem: problemFor(rep.fail) });
      return;
    }
    if (status.value.payer === "demo") {
      setView({ kind: "failed", problem: { kind: "demo" } });
      return;
    }
    const shared = status.value.shared;
    setShare(shared === null ? { kind: "unknown" } : shared ? { kind: "public" } : { kind: "private", again: false });

    const report = rep.value;
    const grid = cellsFrom(report);
    baseRef.current = report;
    cellsRef.current = grid;
    setBase(report);
    setCells(grid);

    const held = getTeamKey(runId) !== null;
    setKeyHeld(held);
    if (allDone(grid)) {
      await close();
      return;
    }
    if (linkedRef.current) {
      if (!confirmedRef.current) setView({ kind: "confirm" });
      else setView(held ? { kind: "live", stage: "ready" } : { kind: "key", notice: null });
      return;
    }
    if (!held) {
      setView({ kind: "key", notice: null });
      return;
    }
    await drive();
  }, [runId, drive, close]);

  /*
   * The token leaves the address bar before the first paint after hydration. A second StrictMode
   * pass finds the bar already clean and keeps the token the first pass took.
   */
  useLayoutEffect(() => {
    const token = takeOwnerTokenFromHash(runId);
    if (token !== null) linkTokenRef.current = token;
  }, [runId]);

  // Next's router can write the fragment back while it settles, so the bar is checked again then.
  useEffect(() => {
    const timers = RESTRIP_MS.map((ms) => window.setTimeout(stripOwnerHash, ms));
    const nav = (window as { navigation?: EventTarget }).navigation;
    window.addEventListener("hashchange", stripOwnerHash);
    window.addEventListener("popstate", stripOwnerHash);
    nav?.addEventListener("navigatesuccess", stripOwnerHash);
    return () => {
      timers.forEach((t) => window.clearTimeout(t));
      window.removeEventListener("hashchange", stripOwnerHash);
      window.removeEventListener("popstate", stripOwnerHash);
      nav?.removeEventListener("navigatesuccess", stripOwnerHash);
    };
  }, []);

  // StrictMode mounts twice in development: the load runs once, and the second mount marks the page alive again.
  useEffect(() => {
    aliveRef.current = true;
    if (!loadedRef.current) {
      loadedRef.current = true;
      void load();
    }
    return () => {
      aliveRef.current = false;
      ctrlRef.current?.abort();
    };
  }, [load]);

  const ticking = view.kind === "live" && (view.stage === "running" || view.stage === "pausing" || view.stage === "closing");
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const pause = useCallback(() => {
    pauseRef.current = true;
    setView({ kind: "live", stage: "pausing" });
  }, []);

  const forget = useCallback(() => {
    clearTeamKey(runId);
    setKeyHeld(false);
  }, [runId]);

  const onKey = useCallback(() => {
    setKeyHeld(true);
    if (allDone(cellsRef.current)) void close();
    else if (linkedRef.current) setView({ kind: "live", stage: "ready" });
    else void drive();
  }, [close, drive]);

  const confirm = useCallback(() => {
    confirmedRef.current = true;
    setView(getTeamKey(runId) === null ? { kind: "key", notice: null } : { kind: "live", stage: "ready" });
  }, [runId]);

  // The visitor says the run is not theirs, so this tab lets go of its pass to it.
  const leave = useCallback(() => {
    forgetOwnerToken(runId);
    clearTeamKey(runId);
    router.push("/");
  }, [runId, router]);

  const doShare = useCallback(async (action: "share" | "unshare") => {
    const token = tokenRef.current;
    if (token === null) return;
    setShare({ kind: "working", action });
    const out = action === "share" ? await shareRun(runId, token) : await unshareRun(runId, token);
    if (out.kind === "shared") setShare({ kind: "shared", reportId: out.reportId });
    else if (out.kind === "private") setShare({ kind: "private", again: true });
    else setShare({ kind: "failed", action, code: out.code.replaceAll("_", " ") });
  }, [runId]);

  const total = base === null ? 0 : base.cases.length * base.configs.length;
  const done = cells.flat().filter((c) => c.kind === "done").length;

  let body: ReactNode;
  switch (view.kind) {
    case "checking":
      body = null;
      break;
    case "loading":
      body = <Loading />;
      break;
    case "no_token":
      body = <NoToken />;
      break;
    case "failed":
      body = <LoadFailed problem={view.problem} onRetry={() => void load()} />;
      break;
    case "confirm":
      body =
        base === null ? null : (
          <LinkConfirm
            name={base.name}
            settings={configLabels(base.configs).map((label, k) => ({ label, model: hasManyModels(base.configs) ? null : base.configs[k]!.model }))}
            callsLeft={callsLeft(cells)}
            prompt={promptText(base.systemPrompt)}
            onConfirm={confirm}
            onLeave={leave}
          />
        );
      break;
    case "key":
      body = (
        <KeyForm
          runId={runId}
          title={base === null ? "Your run" : splitName(base.name).title}
          next={linkedRef.current ? "ready" : "run"}
          notice={view.notice}
          refusedCalls={refusedCalls}
          done={done}
          total={total}
          privateLink={link}
          onKey={onKey}
        />
      );
      break;
    case "finished":
      body = (
        <Finished
          report={view.report}
          share={share}
          keyHeld={keyHeld}
          privateLink={link}
          onShare={() => void doShare("share")}
          onUnshare={() => void doShare("unshare")}
          onForget={forget}
        />
      );
      break;
    case "live":
      body =
        base === null ? null : (
          <>
            {link !== null && (
              <div className={s.linkTop}>
                <PrivateLink url={link} className={s.enter} />
              </div>
            )}
            <RunGrid
              title={base.name}
              configs={base.configs}
              cases={gridCases(base)}
              cells={cells}
              now={now}
              elapsedMs={startedAt === null ? 0 : now - startedAt}
              stage={view.stage}
              notice={<StopNotice note={stopNote} stage={view.stage} />}
              stopped={stopShows(stopNote, view.stage)}
              actions={<Actions stage={view.stage} keyHeld={keyHeld} onPause={pause} onResume={() => void drive()} onForget={forget} />}
            />
          </>
        );
      break;
  }

  // Live stages share one key so the grid stays mounted from running to paused to closing.
  const motionKey = view.kind === "live" ? "live" : view.kind === "key" ? `key-${view.notice ?? ""}` : view.kind;

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={motionKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: -24 }}
          transition={{ duration: 0.45, ease: [0.7, 0, 0.84, 0] }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
      <div className={s.tail} />
    </MotionConfig>
  );
}

function stopShows(note: StopNote, stage: LiveStage): boolean {
  return note !== null && (stage === "paused" || stage === "incomplete");
}

function StopNotice({ note, stage }: { note: StopNote; stage: LiveStage }) {
  if (note === null || !stopShows(note, stage)) return null;
  return (
    <motion.p className={s.notice} role="alert" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
      <span>
        {note.kind === "credits" ? (
          <>
            <strong>Your SERV balance ran out.</strong> SERV refused the last call with 402, so the run paused and nothing
            more is sent. Top up the balance on your SERV account, then press Resume the run.
          </>
        ) : note.kind === "storage" ? (
          <>
            <strong>Urai&apos;s storage is full for now; nothing was saved or charged; try again later.</strong> The run
            paused, and every call it did not finish is back to waiting. Press Resume the run later.
          </>
        ) : note.kind === "refusals" ? (
          <>
            <strong>SERV refused keys sent from this network, or too many calls from it are in flight.</strong> Nothing was
            charged for refused calls. This budget counts per clock hour, so press Resume the run after the hour turns.
          </>
        ) : note.kind === "outage" ? (
          <>
            <strong>SERV is not answering right now.</strong> {OUTAGE_STREAK} calls in a row either never reached SERV or
            came back with no answer, so the run paused instead of filling up with failures. Nothing was charged for the
            calls that did not reach SERV, and they are back to waiting. Press Resume the run in a few minutes.
          </>
        ) : (
          <>
            <strong>
              {note.count} {note.count === 1 ? "call" : "calls"} did not come back
            </strong>
            {note.codes.length > 0 && ` (${note.codes.map((c) => c.replaceAll("_", " ")).join(", ")})`}. Press Run the
            missing calls to send them again. If it keeps happening, wait a minute: SERV or Urai may be busy.
          </>
        )}
      </span>
    </motion.p>
  );
}

function Actions({ stage, keyHeld, onPause, onResume, onForget }: { stage: LiveStage; keyHeld: boolean; onPause: () => void; onResume: () => void; onForget: () => void }) {
  switch (stage) {
    case "ready":
    case "paused":
    case "incomplete":
      return (
        <div className={s.shareActions}>
          <button type="button" className={s.primary} onClick={onResume}>
            <span>{stage === "ready" ? "Continue the run" : stage === "paused" ? "Resume the run" : "Run the missing calls"}</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </button>
          {keyHeld && (
            <button type="button" className={s.quiet} onClick={onForget}>
              Forget my key
            </button>
          )}
        </div>
      );
    case "running":
      return (
        <button type="button" className={s.secondary} onClick={onPause}>
          <Slash className={s.secondarySlash} />
          <span>Pause</span>
        </button>
      );
    case "pausing":
      return (
        <button type="button" className={s.secondary} disabled>
          <span className={s.spinner} aria-hidden="true" />
          <span>Pausing</span>
        </button>
      );
    case "closing":
      return (
        <span className={s.live}>
          <span className={s.spinner} aria-hidden="true" />
        </span>
      );
  }
}
