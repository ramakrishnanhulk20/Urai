"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { setTeamKey } from "../app/session";
import { Slash } from "../brand/slash";
import s from "./run.module.css";

function Panel({ label, marker, title, size, children }: { label: string; marker: ReactNode; title: ReactNode; size?: "medium"; children: ReactNode }) {
  return (
    <section className={s.panel} aria-label={label}>
      <Slash className={s.panelMark} />
      <p className={`${s.marker} ${s.enter}`}>{marker}</p>
      <h1 className={s.panelTitle} data-size={size}>
        {title}
      </h1>
      <div className={s.panelBody}>{children}</div>
    </section>
  );
}

function Line({ children, delay }: { children: ReactNode; delay: number }) {
  return (
    <span className={s.line}>
      <span className={s.rise} style={{ animationDelay: `${delay}s` }}>
        {children}
      </span>
    </span>
  );
}

function Arrow() {
  return (
    <span className={s.arrow} aria-hidden="true">
      &rarr;
    </span>
  );
}

/*
 * Hands the owner token back to its owner as a link, only when they press for it. The token rides
 * after "#", which browsers never send to a server, and the link never carries the SERV key (C22).
 * A browser that blocks the clipboard gets the link in a selected field to copy by hand.
 */
export function PrivateLink({ url, className, style }: { url: string; className?: string; style?: CSSProperties }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const inputRef = useRef<HTMLInputElement>(null);
  const helpId = useId();

  useEffect(() => {
    if (state !== "copied") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (state !== "manual") return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [state]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("manual");
    }
  };

  return (
    <div className={`${s.runLink} ${className ?? ""}`} style={style}>
      <button type="button" className={`${s.secondary} ${s.linkButton}`} data-copied={state === "copied"} onClick={() => void copy()} aria-describedby={helpId}>
        <Slash className={s.secondarySlash} />
        <span aria-live="polite">{state === "copied" ? "Copied" : "Copy private link"}</span>
      </button>
      <p id={helpId} className={s.runLinkHelp}>
        Reopens this run in any browser. Anyone with the link can see and share these results. It never includes your SERV key.
      </p>
      {state === "manual" && (
        <input
          ref={inputRef}
          className={s.linkInput}
          type="text"
          readOnly
          value={url}
          aria-label="Private run link"
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
      )}
    </div>
  );
}

/*
 * A run's owner token lives in the sessionStorage of the tab that created it, so any other tab,
 * or this one after the token is gone, can only be told where to go. No API call is made.
 */
export function NoToken() {
  return (
    <Panel
      label="Run not open in this tab"
      marker={
        <>
          <Slash className={s.markerSlash} />
          <span>Run not in this tab</span>
        </>
      }
      title={
        <>
          <Line delay={0.1}>This run</Line>
          <Line delay={0.2}>
            belongs to <em className={s.goldWord}>another tab.</em>
          </Line>
        </>
      }
    >
      <p className={`${s.panelText} ${s.enter}`} style={{ animationDelay: "0.4s" }}>
        A run can only be driven from the browser tab that started it. That tab holds the run&apos;s owner pass, and
        closing it throws the pass away on purpose, so nobody else can spend on your key or publish your results.{" "}
        If you copied this run&apos;s private link, opening it brings the run back.{" "}
        <strong>If the run finished and you shared it, its report link still works.</strong>
      </p>
      <div className={`${s.actions} ${s.enter}`} style={{ animationDelay: "0.55s" }}>
        <Link href="/new" className={s.primary}>
          <span>Start a new run</span>
          <Arrow />
        </Link>
        <Link href="/try" className={s.secondary}>
          <Slash className={s.secondarySlash} />
          <span>Try the live demo</span>
        </Link>
      </div>
    </Panel>
  );
}

export interface LinkConfirmProps {
  name: string;
  /** model is null when the label already names it, as on a run over several models. */
  settings: { label: string; model: string | null }[];
  callsLeft: number;
  /** The start of the system prompt as the report holds it, cut here to PROMPT_PREVIEW characters. */
  prompt: string;
  onConfirm: () => void;
  onLeave: () => void;
}

const PROMPT_PREVIEW = 200;

/*
 * A private link opens the run for anyone who holds it, so before any key field appears the
 * visitor sees what a key would pay for and says, with a press, that the run is theirs. The
 * prompt is React text, never HTML (C20).
 */
export function LinkConfirm({ name, settings, callsLeft, prompt, onConfirm, onLeave }: LinkConfirmProps) {
  const cut = prompt.length > PROMPT_PREVIEW;
  const preview = cut ? `${prompt.slice(0, PROMPT_PREVIEW).trimEnd()}...` : prompt;

  return (
    <Panel
      label="Confirm this run is yours"
      size="medium"
      marker={
        <>
          <Slash className={s.markerSlash} />
          <span>Opened from a private link</span>
        </>
      }
      title={
        <>
          <Line delay={0.1}>Is this</Line>
          <Line delay={0.2}>
            <em className={s.goldWord}>your run?</em>
          </Line>
        </>
      }
    >
      <p className={`${s.notice} ${s.enter}`} role="note" style={{ animationDelay: "0.35s" }}>
        <span>
          <strong>Your key pays for these calls.</strong> If you paste a SERV key on the next screen, the{" "}
          {callsLeft} {callsLeft === 1 ? "call" : "calls"} below are sent to SERV and billed to that key. Anyone holding
          this link can open this run and read its answers. Only go on if you set this run up yourself.
        </span>
      </p>
      <dl className={`${s.confirmList} ${s.enter}`} style={{ animationDelay: "0.45s" }}>
        <div className={s.confirmRow}>
          <dt>Run</dt>
          <dd>{name}</dd>
        </div>
        <div className={s.confirmRow}>
          <dt>{settings.length === 1 ? "Setting" : "Settings"}</dt>
          <dd>
            <ul className={s.confirmSettings}>
              {settings.map((c, i) => (
                <li key={i}>
                  <span>{c.label}</span>
                  {c.model !== null && <span className={s.confirmModel}>{c.model}</span>}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div className={s.confirmRow}>
          <dt>Calls still to run</dt>
          <dd className={s.confirmCount}>{callsLeft}</dd>
        </div>
        <div className={s.confirmRow}>
          <dt>{cut ? `System prompt, first ${PROMPT_PREVIEW} characters` : "System prompt"}</dt>
          <dd>
            <blockquote className={s.confirmPrompt}>{preview === "" ? "(empty)" : preview}</blockquote>
          </dd>
        </div>
      </dl>
      <div className={`${s.actions} ${s.enter}`} style={{ animationDelay: "0.6s" }}>
        <button type="button" className={s.primary} onClick={onConfirm}>
          <span>This is my run</span>
          <Arrow />
        </button>
        <button type="button" className={s.quiet} onClick={onLeave}>
          This is not my run
        </button>
      </div>
    </Panel>
  );
}

export type KeyNotice = "refused" | "bad_key" | "forgotten" | null;

function noticeText(notice: KeyNotice, refusedCalls: number): ReactNode {
  if (notice === "refused") {
    return (
      <>
        <strong>SERV refused the key.</strong> That usually means the key is wrong, revoked or from another account.
        The key is cleared from this tab and nothing was charged or recorded for the refused calls.{" "}
        {refusedCalls > 0 && `${refusedCalls} ${refusedCalls === 1 ? "call" : "calls"} came back with a refusal Urai cannot safely retry, so ${refusedCalls === 1 ? "it is" : "they are"} recorded as No response. `}
        Paste a working key and the run picks up where it stopped.
      </>
    );
  }
  if (notice === "bad_key") {
    return (
      <>
        <strong>That does not look like a SERV key.</strong> Urai refused it before anything was sent to SERV. Copy the
        key again from your SERV dashboard and paste it whole, with no spaces.
      </>
    );
  }
  if (notice === "forgotten") {
    return <>Your key is forgotten. Paste it again to carry on with this run.</>;
  }
  return null;
}

export interface KeyFormProps {
  runId: string;
  title: string;
  /** "ready" when a run opened from a private link waits for a Continue press after the key, instead of starting. */
  next: "run" | "ready";
  notice: KeyNotice;
  refusedCalls: number;
  done: number;
  total: number;
  privateLink: string | null;
  onKey: () => void;
}

/*
 * Asks for the SERV key when the run is open but the key is not in memory, as after a reload.
 * The field is uncontrolled and emptied the moment it is read, so the key never sits in React
 * state; setTeamKey keeps it in module memory only (C22). The input has no name on purpose: a
 * browser only puts named fields into a native form submission, so even a submit before the page
 * hydrates sends nothing, and the key can never land in a URL (C1). It is read through the ref.
 */
export function KeyForm({ runId, title, next, notice, refusedCalls, done, total, privateLink, onKey }: KeyFormProps) {
  const inputId = useId();
  const keyRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = keyRef.current;
    const key = field === null ? "" : field.value.trim();
    if (field !== null) field.value = "";
    if (key === "") {
      setError("Paste your SERV key first.");
      return;
    }
    if (/\s/.test(key)) {
      setError("A SERV key has no spaces or line breaks. Copy it again and paste it whole.");
      return;
    }
    setError(null);
    setTeamKey(runId, key);
    onKey();
  };

  const text = noticeText(notice, refusedCalls);

  return (
    <Panel
      label="Paste your SERV key"
      size="medium"
      marker={
        <>
          <Slash className={s.markerSlash} />
          <span>{title}</span>
        </>
      }
      title={
        <>
          <Line delay={0.1}>Paste your key</Line>
          <Line delay={0.2}>
            to <em className={s.goldWord}>continue.</em>
          </Line>
        </>
      }
    >
      {text !== null && (
        <p className={s.notice} data-tone={notice === "forgotten" ? "gold" : undefined} role="alert">
          <span>{text}</span>
        </p>
      )}
      <form className={`${s.keyForm} ${s.enter}`} style={{ animationDelay: "0.4s" }} onSubmit={submit} noValidate>
        <label htmlFor={inputId} className={s.keyLabel}>
          Paste your SERV key to continue this run
        </label>
        <div className={s.keyRow}>
          <input
            ref={keyRef}
            id={inputId}
            type="password"
            className={s.keyInput}
            placeholder="Your SERV API key"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            aria-describedby={`${inputId}-note`}
          />
          <button type="submit" className={s.primary}>
            <span>{next === "ready" ? "Use this key" : "Continue the run"}</span>
            <Arrow />
          </button>
        </div>
        {error !== null && (
          <p className={s.keyError} role="alert">
            {error}
          </p>
        )}
        <p id={`${inputId}-note`} className={s.keyNote}>
          <Slash className={s.noteSlash} />
          <span>
            The key is used for each call, sent in a request header to SERV through Urai, and never stored: not in the
            database, not in this browser. It lives in this tab&apos;s memory, for this run only, so a reload asks for it again.
            {next === "ready" && " Nothing is sent to SERV until you press Continue the run on the next screen."}
          </span>
        </p>
      </form>
      <p className={`${s.already} ${s.enter}`} style={{ animationDelay: "0.55s" }}>
        {done} of {total} answers already back. A finished call is never run twice.
      </p>
      {privateLink !== null && <PrivateLink url={privateLink} className={`${s.panelLink} ${s.enter}`} style={{ animationDelay: "0.7s" }} />}
    </Panel>
  );
}

export function Loading() {
  return (
    <section className={s.panel} aria-label="Opening the run" aria-busy="true">
      <p className={`${s.marker} ${s.enter}`}>
        <span className={s.live}>
          <span className={s.liveDot} aria-hidden="true" />
          Opening the run
        </span>
      </p>
    </section>
  );
}

export type LoadProblem =
  | { kind: "gone" }
  | { kind: "demo" }
  | { kind: "unreachable"; detail: string }
  /** The report read at the end of a run failed, after calls may already have gone to SERV. */
  | { kind: "report_unreachable"; detail: string };

/* Every way the run can fail to open, with what happened and what to do next. */
export function LoadFailed({ problem, onRetry }: { problem: LoadProblem; onRetry: () => void }) {
  const copy =
    problem.kind === "gone"
      ? {
          marker: "Run not found",
          title: "Urai does not know this run.",
          text: "The pass this tab holds does not open this run. The run may have passed its 30-day retention date, or the link was changed. Start a new run from the builder.",
        }
      : problem.kind === "demo"
        ? {
            marker: "Demo run",
            title: "This is a demo run.",
            text: "Demo runs are paid by Urai and driven from the live demo page, not from here. Open the live demo to start one, or build a run on your own key.",
          }
        : problem.kind === "report_unreachable"
          ? {
              marker: "Report did not load",
              title: "The answers are in. The report is not.",
              text: `Every call in this run has come back and is stored on Urai, but the report did not load (${problem.detail}). Trying again only reads it: a finished call is never sent to SERV or charged twice. Check your connection and try again.`,
            }
          : {
              marker: "Could not reach Urai",
              title: "The run did not load.",
              text: `Urai did not answer (${problem.detail}), so this page sent nothing to SERV. Check your connection and try again.`,
            };

  return (
    <Panel
      label={copy.marker}
      size="medium"
      marker={
        <>
          <Slash className={s.markerSlash} />
          <span>{copy.marker}</span>
        </>
      }
      title={<Line delay={0.1}>{copy.title}</Line>}
    >
      <p className={`${s.panelText} ${s.enter}`} style={{ animationDelay: "0.35s" }}>
        {copy.text}
      </p>
      <div className={`${s.actions} ${s.enter}`} style={{ animationDelay: "0.5s" }}>
        {problem.kind === "unreachable" || problem.kind === "report_unreachable" ? (
          <button type="button" className={s.primary} onClick={onRetry}>
            <span>Try again</span>
            <Arrow />
          </button>
        ) : (
          <Link href="/new" className={s.primary}>
            <span>Start a new run</span>
            <Arrow />
          </Link>
        )}
        <Link href="/try" className={s.secondary}>
          <Slash className={s.secondarySlash} />
          <span>Try the live demo</span>
        </Link>
      </div>
    </Panel>
  );
}
