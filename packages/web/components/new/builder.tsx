"use client";

import type { ServMode } from "@urai/engine";
import { MotionConfig } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { handOverRun } from "../app/session";
import { AgentSection } from "./agent-section";
import { lintSetup, loadModels, saveWorkload, startRun, type SaveOutcome, type StartOutcome } from "./api";
import { parseCases } from "./cases";
import { CasesSection } from "./cases-section";
import { CheckSection, type AppliedFix, type CheckResult } from "./check-section";
import {
  bodyBytes,
  buildConfigs,
  buildWorkload,
  compareProblem,
  draftFromWorkload,
  draftProblems,
  EMPTY_COMPARE,
  EMPTY_DRAFT,
  estimate,
  keyShapeOk,
  readSchema,
  scoreRules,
  type Compare,
  type Draft,
  type FormLimits,
  type SampleEntry,
} from "./draft";
import { KeySection } from "./key-section";
import s from "./new.module.css";
import { draftHasInput, loadForm, saveForm } from "./persist";
import { RunSection, type StartPhase } from "./run-section";
import { SampleRow } from "./sample-row";
import { SettingsSection, type ModelsState } from "./settings-section";
import { ShapeSection } from "./shape-section";

// The check is rate limited per network, so typing only triggers it once the form has been still this long.
const AUTO_CHECK_MS = 2_000;
// Writing the whole form to sessionStorage on every keystroke is wasted work; this is short enough that a reload keeps nearly everything.
const SAVE_FORM_MS = 400;
const STORAGE_FULL = "Urai's storage is full for now; nothing was saved or charged; try again later.";

// The model our published sample results were measured on, picked first when SERV lists it.
const PREFERRED_MODEL = "gpt-6-luna";

type RailState = "done" | "attention" | "idle";

function kb(bytes: number): number {
  return Math.floor(bytes / 1024);
}

function saveMessage(out: Exclude<SaveOutcome, { kind: "saved" }>, limits: FormLimits): string {
  switch (out.kind) {
    case "invalid":
      return "The server refused this test set. Press Check setup to see exactly what it could not read, fix that, then press Start again.";
    case "too_large":
      return `The test set is over the ${kb(limits.bodyMaxBytes)} KB limit. Trim cases, long inputs or shared data, then press Start again.`;
    case "rate_limited":
      return "Too many test sets were saved from this network in the last hour. Nothing was spent. Wait a while, then press Start again.";
    case "storage_full":
      return STORAGE_FULL;
    case "network":
      return "Could not reach Urai, so nothing was saved or spent. Check your connection, then press Start again.";
    case "refused":
      return `The server would not save the test set (${out.code}). Nothing was spent. Press Start again, and reload the page if it keeps happening.`;
  }
}

function startMessage(out: Exclude<StartOutcome, { kind: "started" }>): string {
  switch (out.kind) {
    case "not_found":
      return "Your saved test set could not be found. Nothing was spent. Press Start again to save it afresh.";
    case "invalid_configs":
      return "One of the settings was refused. Pick the model again under Settings to compare, then press Start.";
    case "rate_limited":
      return "Too many runs were started from this network in the last hour. Nothing was spent. Wait a while, then press Start again.";
    case "storage_full":
      return STORAGE_FULL;
    case "network":
      return "Could not reach Urai, so the run did not start and nothing was spent. Check your connection, then press Start again.";
    case "refused":
      return `The server would not start the run (${out.code}). Nothing was spent. Press Start again, and reload the page if it keeps happening.`;
  }
}

export interface BuilderProps {
  samples: SampleEntry[];
  limits: FormLimits;
}

export function Builder({ samples, limits }: BuilderProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loaded, setLoaded] = useState<SampleEntry["slug"] | null>(null);
  const [flash, setFlash] = useState({ prompt: 0, shape: 0, cases: 0 });

  const [models, setModels] = useState<ModelsState>({ kind: "loading" });
  const [model, setModel] = useState("");
  const [modes, setModes] = useState<ServMode[]>(["raw", "plain"]);
  const [compare, setCompare] = useState<Compare>(EMPTY_COMPARE);
  const [key, setKey] = useState("");

  const [check, setCheck] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);
  const [attempted, setAttempted] = useState<string | null>(null);
  const [checkNow, setCheckNow] = useState(0);
  const [applied, setApplied] = useState<AppliedFix | null>(null);

  const [phase, setPhase] = useState<StartPhase>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // False until the saved form has been read back, so the empty first render never overwrites it.
  const [restored, setRestored] = useState(false);
  const startedRef = useRef(false);

  const seq = useRef(0);
  const lastCallAt = useRef(0);
  // A test set saved on an earlier Start that failed at the run step, reused while it is unchanged.
  const saved = useRef<{ body: string; workloadId: string; ownerToken: string } | null>(null);

  const schema = useMemo(() => readSchema(draft.schemaText), [draft.schemaText]);
  const rules = useMemo(() => scoreRules(draft.scoring), [draft.scoring]);
  const parsed = useMemo(() => parseCases(draft.casesText, rules, limits), [draft.casesText, rules, limits]);
  const blockers = useMemo(() => draftProblems(draft, schema, parsed, limits), [draft, schema, parsed, limits]);
  const workload = useMemo(
    () => (blockers.length === 0 ? buildWorkload(draft, schema, parsed.cases) : null),
    [blockers, draft, schema, parsed],
  );
  const configs = useMemo(() => buildConfigs(model, modes, compare, limits), [model, modes, compare, limits]);
  const compareIssue = compareProblem(model, modes, compare, limits);
  const checkKey = useMemo(() => (workload === null ? null : JSON.stringify({ workload, configs })), [workload, configs]);
  const bytes = useMemo(() => (workload === null ? null : bodyBytes(workload)), [workload]);

  // Read after mount, not during render, so the server's empty form and the first client render match.
  useEffect(() => {
    const form = loadForm();
    if (form !== null) {
      setDraft(form.draft);
      setLoaded(form.loaded);
      if (form.model !== "") setModel(form.model);
      setModes(form.modes);
      setCompare(form.compare);
    }
    // A sample report's "Open the builder" link names its sample, and that click wins over a saved draft.
    const url = new URL(window.location.href);
    const linked = samples.find((x) => x.slug === url.searchParams.get("sample"));
    if (linked !== undefined) {
      setDraft(draftFromWorkload(linked.workload));
      setLoaded(linked.slug);
      setFlash((f) => ({ prompt: f.prompt + 1, shape: f.shape + 1, cases: f.cases + 1 }));
      // Dropped from the address bar, so a reload keeps the team's later edits instead of loading the sample again.
      url.searchParams.delete("sample");
      window.history.replaceState(window.history.state, "", url);
    }
    setRestored(true);
    // Runs once: the samples come from the server and never change on this page.
  }, []);

  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => saveForm({ draft, loaded, model, modes, compare }), SAVE_FORM_MS);
    return () => window.clearTimeout(timer);
  }, [restored, draft, loaded, model, modes, compare]);

  const hasInput = draftHasInput(draft) || key.trim() !== "";
  // The key is never kept, and closing the tab loses the form too, so leaving asks first until a run has started.
  useEffect(() => {
    if (!hasInput || phase === "opening") return;
    const warn = (e: BeforeUnloadEvent): void => {
      if (startedRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasInput, phase]);

  useEffect(() => {
    let live = true;
    void loadModels().then((out) => {
      if (!live) return;
      if (out.kind === "failed") {
        setModels({ kind: "failed" });
        return;
      }
      setModels(out);
      const ids = out.list.models.map((m) => m.id);
      setModel((current) => (current !== "" ? current : ids.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : (ids[0] ?? "")));
    });
    return () => {
      live = false;
    };
  }, []);

  const runCheck = useCallback(
    async (w: NonNullable<typeof workload>, cfgs: typeof configs, forKey: string): Promise<void> => {
      const id = ++seq.current;
      lastCallAt.current = Date.now();
      setAttempted(forKey);
      setBusy(true);
      setCheckError(null);
      const out = await lintSetup(w, cfgs);
      if (id !== seq.current) return;
      setBusy(false);
      switch (out.kind) {
        case "checked":
          setCheck({ kind: "findings", findings: out.findings, fix: out.fix, key: forKey });
          setAutoPaused(false);
          break;
        case "invalid":
          setCheck({ kind: "invalid", reasons: out.reasons, key: forKey });
          break;
        case "rate_limited":
          setAutoPaused(true);
          setCheckError("Too many checks from this network in the last hour. Automatic checks are paused. Wait a few minutes, then press Check setup.");
          break;
        case "too_large":
          setCheckError(`This test set is over the ${kb(limits.bodyMaxBytes)} KB limit. Trim cases or shared data, then check again.`);
          break;
        case "network":
          setCheckError("Could not reach Urai. Check your connection, then press Check setup.");
          break;
        case "refused":
          setCheckError(
            out.code === "invalid_configs"
              ? "The model id was refused. Pick it again under Settings to compare, then press Check setup."
              : `The check was refused (${out.code}). Press Check setup to try again.`,
          );
          break;
      }
    },
    [limits.bodyMaxBytes],
  );

  // Typing queues a check; each new change restarts the wait, and calls are never closer than AUTO_CHECK_MS.
  useEffect(() => {
    if (workload === null || checkKey === null || autoPaused || checkKey === attempted) return;
    const wait = Math.max(AUTO_CHECK_MS, lastCallAt.current + AUTO_CHECK_MS - Date.now());
    const timer = window.setTimeout(() => void runCheck(workload, configs, checkKey), wait);
    return () => window.clearTimeout(timer);
  }, [workload, configs, checkKey, autoPaused, attempted, runCheck]);

  // The fix and its undo ask for a check straight away, on the values they just wrote.
  useEffect(() => {
    if (checkNow === 0 || workload === null || checkKey === null) return;
    void runCheck(workload, configs, checkKey);
    // Only a new request fires this; the values are the ones from the render that made the request.
  }, [checkNow]);

  const edit = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // Hand edits to the fixed fields make the saved "before" meaningless, so undo is withdrawn.
    if ("systemPrompt" in patch || "context" in patch) setApplied(null);
  }, []);

  const loadSample = (sample: SampleEntry): void => {
    setDraft(draftFromWorkload(sample.workload));
    setLoaded(sample.slug);
    setApplied(null);
    setFlash((f) => ({ prompt: f.prompt + 1, shape: f.shape + 1, cases: f.cases + 1 }));
  };

  const onCheck = (): void => {
    if (workload === null || checkKey === null) return;
    setAutoPaused(false);
    void runCheck(workload, configs, checkKey);
  };

  const onFix = (): void => {
    if (check?.kind !== "findings" || check.fix === null || check.key !== checkKey) return;
    const fix = check.fix;
    setApplied({ moved: fix.moved, before: { systemPrompt: draft.systemPrompt, context: draft.context } });
    setDraft((d) => ({ ...d, systemPrompt: fix.systemPrompt, context: fix.context ?? "" }));
    setFlash((f) => ({ ...f, prompt: f.prompt + 1 }));
    setCheckNow((n) => n + 1);
  };

  const onUndo = (): void => {
    if (applied === null) return;
    setDraft((d) => ({ ...d, ...applied.before }));
    setApplied(null);
    setFlash((f) => ({ ...f, prompt: f.prompt + 1 }));
    setCheckNow((n) => n + 1);
  };

  const toggleMode = (mode: ServMode): void =>
    setModes((current) => (current.includes(mode) ? current.filter((m) => m !== mode) : [...current, mode]));

  const stale = check !== null && check.key !== checkKey;
  const findings = check?.kind === "findings" && !stale ? check.findings : [];
  const checkErrors = findings.filter((f) => f.severity === "error").length;
  // The note's wording never depends on the form, so the last check's copy stays up while a new one runs.
  const fullNote = check?.kind === "findings" ? check.findings.find((f) => f.id === "full-mode-cost")?.detail : undefined;
  const est = estimate(workload, configs, models.kind === "loaded" ? models.list.models : null);
  const keyOk = keyShapeOk(key, limits);

  const todo: string[] = [...blockers];
  if (model.trim() === "") todo.push("Pick a model under Settings to compare.");
  if (modes.length === 0) todo.push("Tick at least one setting to compare.");
  if (compareIssue !== null) todo.push(compareIssue);
  if (bytes !== null && bytes > limits.bodyMaxBytes) todo.push(`Trim the test set to under ${kb(limits.bodyMaxBytes)} KB.`);
  if (check?.kind === "invalid" && !stale) todo.push("Fix the points the setup check could not read.");
  if (key.trim() === "") todo.push("Paste your SERV key.");
  else if (!keyOk) todo.push("Check your SERV key: it does not look like one.");

  const onStart = async (): Promise<void> => {
    if (workload === null || configs.length === 0 || !keyOk || todo.length > 0 || phase !== null) return;
    setStartError(null);
    const body = JSON.stringify(workload);
    let target = saved.current !== null && saved.current.body === body ? saved.current : null;
    if (target === null) {
      setPhase("saving");
      const out = await saveWorkload(workload);
      if (out.kind !== "saved") {
        setPhase(null);
        setStartError(saveMessage(out, limits));
        return;
      }
      target = { body, workloadId: out.workloadId, ownerToken: out.ownerToken };
      saved.current = target;
    }
    setPhase("starting");
    const run = await startRun(target.workloadId, target.ownerToken, configs);
    if (run.kind !== "started") {
      if (run.kind === "not_found") saved.current = null;
      setPhase(null);
      setStartError(startMessage(run));
      return;
    }
    startedRef.current = true;
    handOverRun(run.runId, run.ownerToken, key);
    setPhase("opening");
    // Client-side navigation keeps this JavaScript alive, which is the only place the key lives.
    router.push(`/run/${run.runId}`);
  };

  const rail: { id: string; label: string; state: RailState }[] = [
    { id: "sample", label: "Sample (optional)", state: loaded !== null ? "done" : "idle" },
    {
      id: "agent",
      label: "Your agent",
      state: draft.name.trim() !== "" && draft.systemPrompt.trim() !== "" ? "done" : "idle",
    },
    {
      id: "shape",
      label: "Answer shape",
      state: schema.ok && draft.scoring.length > 0 ? "done" : !schema.ok && !schema.empty ? "attention" : "idle",
    },
    {
      id: "cases",
      label: "Test cases",
      state: parsed.problems.length > 0 ? "attention" : parsed.cases.length > 0 ? "done" : "idle",
    },
    {
      id: "check",
      label: "Setup check",
      state: check === null || stale ? "idle" : check.kind === "invalid" || checkErrors > 0 ? "attention" : "done",
    },
    { id: "settings", label: "Settings", state: compareIssue !== null ? "attention" : configs.length > 0 ? "done" : "idle" },
    { id: "key", label: "SERV key", state: keyOk ? "done" : key.trim() !== "" ? "attention" : "idle" },
    { id: "run", label: "Run it", state: todo.length === 0 ? "done" : "idle" },
  ];

  return (
    <MotionConfig reducedMotion="user">
      <div className={s.layout}>
        <nav className={s.rail} aria-label="Steps">
          <ol className={s.railList}>
            {rail.map((r, i) => (
              <li key={r.id}>
                <a className={s.railLink} href={`#${r.id}`}>
                  <span className={s.railIndex}>{String(i + 1).padStart(2, "0")}</span>
                  <span>{r.label}</span>
                  <span className={s.railState} data-state={r.state} aria-hidden="true" />
                  <span className={s.srOnly}>{r.state === "done" ? ", done" : r.state === "attention" ? ", needs attention" : ", to do"}</span>
                </a>
              </li>
            ))}
          </ol>
          <p className={s.railNote}>Nothing is saved or spent until you press Start.</p>
        </nav>

        <div className={s.form}>
          <SampleRow samples={samples} loaded={loaded} onLoad={loadSample} />
          <AgentSection draft={draft} limits={limits} promptFlash={flash.prompt} onChange={edit} />
          <ShapeSection draft={draft} schema={schema} limits={limits} flash={flash.shape} onChange={edit} />
          <CasesSection draft={draft} parsed={parsed} scoring={rules} limits={limits} flash={flash.cases} onChange={edit} />
          <CheckSection
            result={check}
            stale={stale}
            busy={busy}
            queued={workload !== null && checkKey !== attempted && !autoPaused}
            error={checkError}
            blockers={blockers}
            promptChars={draft.systemPrompt.length}
            contextChars={draft.context.length}
            applied={applied}
            onCheck={onCheck}
            onFix={onFix}
            onUndo={onUndo}
          />
          <SettingsSection
            models={models}
            model={model}
            modes={modes}
            limits={limits}
            notes={fullNote === undefined ? {} : { full: fullNote }}
            onModel={setModel}
            onToggle={toggleMode}
            compare={compare}
            compareProblem={compareIssue}
            onCompare={setCompare}
          />
          <KeySection value={key} limits={limits} onChange={setKey} />
          <RunSection
            cases={parsed.cases.length}
            settings={configs.length}
            estimate={est}
            modelIds={[...new Set(configs.map((c) => c.model))]}
            servOn={configs.some((c) => c.mode !== "raw")}
            bytes={bytes}
            maxBytes={limits.bodyMaxBytes}
            todo={todo}
            checkErrors={checkErrors}
            phase={phase}
            error={startError}
            onStart={() => void onStart()}
          />
        </div>
      </div>
    </MotionConfig>
  );
}
