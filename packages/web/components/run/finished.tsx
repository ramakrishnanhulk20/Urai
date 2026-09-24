"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Report } from "../../lib/report";
import { Slash } from "../brand/slash";
import { Disagreements } from "../report/disagreements";
import { EveryCase } from "../report/every-case";
import { Findings } from "../report/findings";
import r from "../report/report.module.css";
import { ReportSummary } from "../report/summary";
import { Verdict } from "../report/verdict";
import { Ledger, type BalanceView } from "./ledger";
import s from "./run.module.css";
import { PrivateLink } from "./states";

export type ShareState =
  | { kind: "unknown" }
  | { kind: "working"; action: "share" | "unshare" }
  | { kind: "shared"; reportId: string }
  | { kind: "private" }
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

function shareText(state: ShareState): string {
  switch (state.kind) {
    case "shared":
      return "Anyone with this link can read the report. It shows the answers and the scores, never your key.";
    case "private":
      return "The report is private again. The old link now shows not found; sharing again brings the same link back.";
    case "failed":
      return state.action === "share"
        ? `Urai could not share the report (${state.code}). Nothing changed. Try again in a moment.`
        : `Urai could not make the report private (${state.code}). It is still shared. Try again in a moment.`;
    default:
      return "The report is private until you share it. Sharing gives a public link; you can make it private again at any time.";
  }
}

function SharePanel({ state, onShare, onUnshare }: { state: ShareState; onShare: () => void; onUnshare: () => void }) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const working = state.kind === "working";
  const shared = state.kind === "shared";

  return (
    <div className={s.share}>
      <p className={s.shareTitle}>
        <Slash className={s.markerSlash} />
        Share the report
      </p>
      {shared && <CopyLink url={`${origin}/r/${state.reportId}`} />}
      <p className={s.shareText} role={state.kind === "failed" ? "alert" : undefined}>
        {shareText(state)}
      </p>
      <div className={s.shareActions}>
        {!shared && (
          <button type="button" className={s.primary} onClick={onShare} disabled={working}>
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
        {state.kind !== "private" && (
          <button type="button" className={s.quiet} onClick={onUnshare} disabled={working}>
            {working && state.action === "unshare" ? "Making it private" : shared ? "Unshare" : "Make sure it is private"}
          </button>
        )}
      </div>
    </div>
  );
}

export interface FinishedProps {
  report: Report;
  before: BalanceView;
  after: BalanceView;
  share: ShareState;
  keyHeld: boolean;
  privateLink: string | null;
  onShare: () => void;
  onUnshare: () => void;
  onForget: () => void;
}

/*
 * The finished run: the report's own opening with the measured spend and the share controls
 * beside it, then the verdict, the disagreements, the setup findings and every case, rendered by
 * the same components as the public page, so the owner sees exactly what a shared link shows.
 */
export function Finished({ report, before, after, share, keyHeld, privateLink, onShare, onUnshare, onForget }: FinishedProps) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
      <div className={r.opening}>
        <ReportSummary report={report} />
        <div className={s.finishAside}>
          <Ledger before={before} after={after} />
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.9, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <SharePanel state={share} onShare={onShare} onUnshare={onUnshare} />
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
