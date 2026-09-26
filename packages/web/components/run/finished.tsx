"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Report } from "../../lib/report";
import { Slash } from "../brand/slash";
import { Disagreements } from "../report/disagreements";
import { EveryCase } from "../report/every-case";
import { Findings } from "../report/findings";
import { configLabels } from "../report/format";
import r from "../report/report.module.css";
import { ReportSummary } from "../report/summary";
import { Verdict } from "../report/verdict";
import { Ledger } from "./ledger";
import s from "./run.module.css";
import { PrivateLink } from "./states";

export type ShareState =
  | { kind: "unknown" }
  | { kind: "working"; action: "share" | "unshare" }
  | { kind: "shared"; reportId: string }
  /** Public on the server, but the status read never carries the report id (C9), so the link waits for a press. */
  | { kind: "public" }
  | { kind: "private"; again: boolean }
  | { kind: "failed"; action: "share" | "unshare"; code: string };

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  };

  return (
    <>
      <div className={s.shareLink}>
        <a className={s.shareUrl} href={url} target="_blank" rel="noopener noreferrer" title={url}>
          {url}
        </a>
        <button type="button" className={s.copy} onClick={() => void copy()} aria-live="polite">
          {copied === "done" ? "Copied" : "Copy"}
        </button>
      </div>
      {copied === "failed" && <p className={s.shareText}>This browser blocked the copy. Select the link and copy it by hand.</p>}
    </>
  );
}

/*
 * Everything the public page at /r/<id> shows, in the order it shows it. Kept as one list so the
 * warning before sharing and the note after it can never drift apart.
 */
export function publicItems(hasContext: boolean): string[] {
  return [
    "The run's name and every setting, with its model",
    "The system prompt",
    ...(hasContext ? ["The shared data you added to every case"] : []),
    "The answer schema",
    "Every case's input, up to its first 2,000 characters",
    "The expected answers",
    "Every setting's answers and the scores",
    "The setup check's findings, the token counts and the estimated cost",
  ];
}

export function PublicList({ hasContext }: { hasContext: boolean }) {
  return (
    <ul className={s.publicList}>
      {publicItems(hasContext).map((item) => (
        <li key={item}>
          <Slash className={s.publicSlash} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function shareText(state: ShareState): string {
  switch (state.kind) {
    case "shared":
      return "This report is public. Anyone with this link can read everything listed below. It never shows your SERV key or your private run link.";
    case "public":
      return "This report is public. Anyone with its link can read everything listed below. It never shows your SERV key or your private run link.";
    case "private":
      return state.again
        ? "The report is private again. The old link now shows not found; sharing again brings the same link back."
        : "The report is private until you share it. Sharing gives a public link; you can make it private again at any time.";
    case "failed":
      return state.action === "share"
        ? `Urai could not share the report (${state.code}). Nothing changed. Try again in a moment.`
        : `Urai could not make the report private (${state.code}). It is still shared. Try again in a moment.`;
    case "unknown":
      return "Urai could not tell whether this report is public. Share it to get its link, or press Unshare to be sure it is private.";
    case "working":
      return state.action === "share" ? "Making the report public." : "Making the report private.";
  }
}

/*
 * The disclosure a team reads before anything goes public: the exact list of what the public page
 * shows and a second, explicit press to publish. Shown on its own so it can be checked in a test.
 */
export function ShareConfirm({ hasContext, onConfirm, onCancel }: { hasContext: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <motion.div
      className={s.shareConfirm}
      role="group"
      aria-label="What sharing makes public"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
    >
      <p className={s.shareText}>
        <strong className={s.shareStrong}>Sharing makes all of this public</strong> to anyone who has the link:
      </p>
      <PublicList hasContext={hasContext} />
      <p className={s.shareText}>Your SERV key and your private run link are never shown. You can make it private again at any time.</p>
      <div className={s.shareActions}>
        <button type="button" className={s.primary} onClick={onConfirm}>
          <span>Yes, make it public</span>
        </button>
        <button type="button" className={s.quiet} onClick={onCancel}>
          Keep it private
        </button>
      </div>
    </motion.div>
  );
}

export function SharePanel({ state, hasContext, onShare, onUnshare }: { state: ShareState; hasContext: boolean; onShare: () => void; onUnshare: () => void }) {
  const [origin, setOrigin] = useState("");
  const [asking, setAsking] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const working = state.kind === "working";
  const shared = state.kind === "shared";
  const isPublic = state.kind === "public";

  const confirmShare = (): void => {
    setAsking(false);
    onShare();
  };

  return (
    <div className={s.share}>
      <p className={s.shareTitle}>
        <Slash className={s.markerSlash} />
        Share the report
      </p>
      {shared && <CopyLink url={`${origin}/r/${state.reportId}`} />}
      {asking && !shared && !working ? (
        <ShareConfirm hasContext={hasContext} onConfirm={confirmShare} onCancel={() => setAsking(false)} />
      ) : (
        <>
          <p className={s.shareText} role={state.kind === "failed" ? "alert" : undefined}>
            {shareText(state)}
          </p>
          {(shared || isPublic) && <PublicList hasContext={hasContext} />}
        </>
      )}
      <div className={s.shareActions}>
        {/* Already public, so the link is fetched with no second confirm: sharing again returns the same report id. */}
        {isPublic && (
          <button type="button" className={s.primary} onClick={onShare}>
            <span>Show the public link</span>
          </button>
        )}
        {!shared && !isPublic && !asking && (
          <button type="button" className={s.primary} onClick={() => setAsking(true)} disabled={working}>
            {working && state.action === "share" ? <span className={s.spinner} aria-hidden="true" /> : null}
            <span>{working && state.action === "share" ? "Sharing" : "Share the report"}</span>
          </button>
        )}
        {shared && (
          <Link href={`/r/${state.reportId}`} className={s.primary}>
            <span>Open the public page</span>
            <span className={s.arrow} aria-hidden="true">
              &rarr;
            </span>
          </Link>
        )}
        {state.kind !== "private" && !asking && (
          <button type="button" className={s.quiet} onClick={onUnshare} disabled={working}>
            {working && state.action === "unshare" ? "Making it private" : "Unshare"}
          </button>
        )}
      </div>
    </div>
  );
}

export interface FinishedProps {
  report: Report;
  share: ShareState;
  keyHeld: boolean;
  privateLink: string | null;
  onShare: () => void;
  onUnshare: () => void;
  onForget: () => void;
}

/*
 * The finished run: the report's own opening with the cost ledger and the share controls
 * beside it, then the verdict, the disagreements, the setup findings and every case, rendered by
 * the same components as the public page, so the owner sees exactly what a shared link shows.
 */
export function Finished({ report, share, keyHeld, privateLink, onShare, onUnshare, onForget }: FinishedProps) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
      <div className={r.opening}>
        <ReportSummary report={report} />
        <div className={s.finishAside}>
          <Ledger labels={configLabels(report.configs)} configs={report.configs} totals={report.totals} balance={report.balance} />
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <SharePanel state={share} hasContext={report.context !== null} onShare={onShare} onUnshare={onUnshare} />
            {privateLink !== null && <PrivateLink url={privateLink} className={s.asideLink} />}
            <p className={s.forget}>
              {keyHeld ? (
                <>
                  <span>Your key is held in this tab&apos;s memory only.</span>
                  <button type="button" className={s.quiet} onClick={onForget}>
                    Forget my key
                  </button>
                </>
              ) : (
                <span>Your key is forgotten. Nothing of it is left in this tab.</span>
              )}
            </p>
          </motion.div>
        </div>
      </div>
      <Verdict report={report} />
      <Disagreements report={report} />
      <Findings report={report} />
      <EveryCase report={report} />
    </motion.div>
  );
}
