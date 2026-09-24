"use client";

import type { Estimate } from "./draft";
import { OUTPUT_TOKENS_GUESS } from "./draft";
import s from "./new.module.css";
import { Section } from "./parts";

export type StartPhase = "saving" | "starting" | "opening" | null;

export interface RunSectionProps {
  cases: number;
  settings: number;
  estimate: Estimate | null;
  modelId: string;
  /** Size of the test set as it will be sent, against the server's cap. */
  bytes: number | null;
  maxBytes: number;
  /** Everything still missing, in plain sentences. Start stays off until this is empty. */
  todo: string[];
  /** Setup check errors the team may still choose to run with, for example to measure the mistake. */
  checkErrors: number;
  phase: StartPhase;
  error: string | null;
  onStart: () => void;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function usd(v: number): string {
  return v > 0 && v < 0.01 ? "under $0.01" : `about ${USD.format(v)}`;
}

const PHASE_LABEL: Record<Exclude<StartPhase, null>, string> = {
  saving: "Saving your test set",
  starting: "Starting the run",
  opening: "Opening the run",
};

export function RunSection(p: RunSectionProps) {
  const busy = p.phase !== null;
  const disabled = busy || p.todo.length > 0;
  const kb = p.bytes === null ? null : Math.ceil(p.bytes / 1024);

  return (
    <Section
      id="run"
      index={8}
      marker="Run it"
      className={s.run}
      title={
        <>
          Every case,
          <br />
          every setting.
        </>
      }
      lede="Start saves your test set, opens the run, and takes you to the live results. You watch each answer come back and can stop at any time."
    >
      <p className={s.equation} aria-label={`${p.cases} cases times ${p.settings} settings is ${p.cases * p.settings} calls`}>
        <span className={s.eqTerm}>
          {p.cases}
          <small>{p.cases === 1 ? "case" : "cases"}</small>
        </span>
        <span className={s.eqOp} aria-hidden="true">
          &times;
        </span>
        <span className={s.eqTerm}>
          {p.settings}
          <small>{p.settings === 1 ? "setting" : "settings"}</small>
        </span>
        <span className={s.eqGroup}>
          <span className={s.eqOp} aria-hidden="true">
            =
          </span>
          <span className={`${s.eqTerm} ${s.eqResult}`}>
            {p.cases * p.settings}
            <small>calls</small>
          </span>
        </span>
      </p>

      <div className={s.runFoot}>
        <div className={s.estimate}>
          <p className={s.estimateValue}>
            {p.estimate?.usd != null ? (
              <>
                Estimate: <em>{usd(p.estimate.usd)}</em> in model tokens
              </>
            ) : (
              "Estimate appears once the model and cases are in"
            )}
          </p>
          <p className={s.hint}>
            A rough figure from SERV&apos;s listed prices for {p.modelId === "" ? "the model" : p.modelId}: about{" "}
            {p.estimate === null ? "..." : p.estimate.inputTokensPerCall.toLocaleString("en-US")} input tokens per call
            (four characters to a token) and {OUTPUT_TOKENS_GUESS} output tokens, our bench average. SERV&apos;s own
            charges, like the reasoning graph built on first sight and full mode, are extra: see the setup check.
          </p>
          {kb !== null && (
            <p className={s.hint}>
              Test set size: {kb} KB of {Math.floor(p.maxBytes / 1024)} KB allowed.
            </p>
          )}
          {p.todo.length > 0 && (
            <ul className={s.todo} aria-label="Before you can start">
              {p.todo.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          )}
          {p.todo.length === 0 && p.checkErrors > 0 && (
            <p className={s.feedback} data-tone="bad">
              The setup check found {p.checkErrors} {p.checkErrors === 1 ? "error" : "errors"}. You can still run it, for
              example to measure what the mistake costs, but fix it first if you want a fair test of SERV.
            </p>
          )}
        </div>

        <div className={s.startWrap}>
          <button
            type="button"
            className={`${s.primary} ${s.start}`}
            onClick={p.onStart}
            disabled={disabled}
            data-busy={busy}
            aria-describedby={p.error !== null ? "start-error" : undefined}
          >
            {busy && <span className={s.pulse} aria-hidden="true" />}
            <span>{p.phase !== null ? PHASE_LABEL[p.phase] : "Start the run"}</span>
            {!busy && (
              <span className={s.arrow} aria-hidden="true">
                &rarr;
              </span>
            )}
          </button>
        </div>
      </div>

      {p.error !== null && (
        <p id="start-error" className={s.error} role="alert">
          {p.error}
        </p>
      )}
    </Section>
  );
}
